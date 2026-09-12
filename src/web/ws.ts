/**
 * WebSocket endpoints.
 *
 *   /ws/sessions/:id   one attached terminal
 *   /ws/events         the session list, for tabs, sidebar and status icon
 *
 * Each attached terminal gets its own connection to ptyd rather than sharing
 * the gateway's control link. That is what lets ptyd tell viewers apart when it
 * reconciles window sizes, so a phone joining a session cannot resize the
 * laptop that is driving it.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../shared/config.ts';
import type {
  ClientWsMessage,
  EventsWsMessage,
  ServerWsMessage,
} from '../shared/protocol.ts';
import { PtydClient } from '../shared/ptyd-client.ts';
import type { AuthContext } from './http-util.ts';
import { originAllowed } from './http-util.ts';
import type { PtydControl } from './ptyd-control.ts';

/**
 * Disconnect a viewer that is not draining (asleep phone, dead tunnel).
 * Overridable so a test can shrink it and force the condition deterministically.
 */
const MAX_WS_BACKLOG = Number(process.env.PTYHUB_MAX_WS_BACKLOG) || 4 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export interface WsDeps {
  control: PtydControl;
  cfg: Config;
  socketFile: string;
  log: (msg: string) => void;
  /** Returns null when the request is not authenticated. */
  authenticate: (req: IncomingMessage) => AuthContext | null;
}

function sendJson(ws: WebSocket, msg: ServerWsMessage | EventsWsMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

/**
 * Read an optional positive integer query parameter.
 *
 * Note that `Number(null)` is 0, not NaN, so a missing parameter would
 * otherwise read as a real request for a zero-column terminal — which ptyd
 * would dutifully clamp to its 2x1 minimum and hand to the shell.
 */
function positiveParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export function attachWebSockets(server: Server, deps: WsDeps): () => void {
  const { control, cfg, log, authenticate } = deps;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // A suspended phone leaves a socket that looks open but never answers.
  // Heartbeats reap those so ptyd does not keep broadcasting into the void.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const track = (ws: WebSocket) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Without this check any page the user visits could open a socket to their
    // shell; SameSite cookies do not cover the WebSocket handshake.
    if (!originAllowed(req, cfg.allowedOrigins)) {
      log(`rejected websocket upgrade from origin ${String(req.headers.origin)}`);
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const auth = authenticate(req);
    if (!auth) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (parts[1] === 'events' && parts.length === 2) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        handleEvents(ws, control);
      });
      return;
    }

    if (parts[1] === 'sessions' && parts.length === 3) {
      const sessionId = decodeURIComponent(parts[2]!);
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        void handleTerminal(
          ws,
          sessionId,
          {
            cols: positiveParam(url.searchParams.get('cols')),
            rows: positiveParam(url.searchParams.get('rows')),
          },
          deps,
        );
      });
      return;
    }

    rejectUpgrade(socket, 404, 'Not Found');
  });

  return () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}

// ---------------------------------------------------------------------------

function handleEvents(ws: WebSocket, control: PtydControl): void {
  sendJson(ws, {
    t: 'snapshot',
    sessions: control.listCached(),
    status: control.currentStatus,
  });

  const offEvent = control.onEvent((event) => sendJson(ws, { t: 'event', event }));
  const offStatus = control.onStatus((status) => {
    sendJson(ws, { t: 'status', status });
    // A reconnected ptyd may have a completely different session list.
    if (status === 'connected') {
      sendJson(ws, { t: 'snapshot', sessions: control.listCached(), status });
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as ClientWsMessage;
      if (msg.t === 'ping') sendJson(ws, { t: 'pong', ts: msg.ts });
    } catch {
      // Ignore junk on the control channel.
    }
  });

  ws.on('close', () => {
    offEvent();
    offStatus();
  });
}

// ---------------------------------------------------------------------------

async function handleTerminal(
  ws: WebSocket,
  sessionId: string,
  size: { cols: number | undefined; rows: number | undefined },
  deps: WsDeps,
): Promise<void> {
  const { cfg, socketFile, log } = deps;

  let client: PtydClient;
  try {
    client = await PtydClient.connect(socketFile, {
      onOutput: (_id, data) => {
        if (ws.readyState !== ws.OPEN) return;
        // Silently skipping output here would be the same mistake ptyd itself
        // avoids on the other leg of this pipe: a browser that cannot keep up
        // would carry on believing it is in sync while missing bytes out of
        // the middle of, say, vim's screen redraw, with no way for either side
        // to notice or repair it. Closing forces exactly the reconnect path
        // that already re-subscribes and replays a full, correct snapshot.
        if (ws.bufferedAmount > MAX_WS_BACKLOG) {
          log(`terminal socket for session ${sessionId} is not draining; closing it`);
          // Not ws.close(): a graceful close sends a close frame down the very
          // same congested pipe and waits for the peer's reply, so on a socket
          // already this backed up it can sit half-closed for a long time
          // instead of freeing anything promptly. terminate() drops the
          // underlying connection immediately, no handshake — the same
          // abrupt approach ptyd takes on its own side of this pipe.
          ws.terminate();
          return;
        }
        ws.send(data, { binary: true });
      },
      onEvent: (evt) => {
        if ('id' in evt && evt.id !== sessionId) return;
        switch (evt.ev) {
          case 'ready':
            sendJson(ws, { t: 'ready', cols: evt.cols, rows: evt.rows });
            break;
          case 'resized':
            sendJson(ws, { t: 'resized', cols: evt.cols, rows: evt.rows });
            break;
          case 'proc':
            sendJson(ws, { t: 'proc', fgProc: evt.fgProc });
            break;
          case 'title':
            sendJson(ws, { t: 'title', title: evt.title });
            break;
          case 'viewers':
            sendJson(ws, { t: 'viewers', viewers: evt.viewers });
            break;
          case 'locked':
            sendJson(ws, { t: 'locked', locked: evt.locked });
            break;
          case 'exited':
            sendJson(ws, {
              t: 'exit',
              exitCode: evt.exitCode,
              exitSignal: evt.exitSignal,
            });
            break;
          default:
            break;
        }
      },
      onClose: () => {
        sendJson(ws, {
          t: 'error',
          code: 'ptyd_unavailable',
          message: 'lost connection to ptyd',
        });
        ws.close(1011, 'ptyd unavailable');
      },
    });
  } catch (err) {
    sendJson(ws, {
      t: 'error',
      code: 'ptyd_unavailable',
      message: `cannot reach ptyd: ${String(err)}`,
    });
    ws.close(1011, 'ptyd unavailable');
    return;
  }

  ws.on('close', () => client.close());
  ws.on('error', () => client.close());

  try {
    const meta = await client.get(sessionId);
    // The browser resets its terminal on `hello`, so it must arrive before the
    // snapshot bytes that subscribe is about to produce.
    sendJson(ws, { t: 'hello', session: meta, policy: cfg.resizePolicy });

    // Only declare a size when the client actually told us one; a viewer that
    // has not measured itself yet must not get a vote.
    const wantsSize = size.cols !== undefined && size.rows !== undefined;
    await client.subscribe(sessionId, {
      cols: wantsSize ? size.cols : undefined,
      rows: wantsSize ? size.rows : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ws, { t: 'error', code: 'attach_failed', message });
    ws.close(1011, 'attach failed');
    client.close();
    return;
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      client.sendInput(sessionId, raw as Buffer);
      return;
    }
    try {
      const msg = JSON.parse(String(raw)) as ClientWsMessage;
      if (msg.t === 'resize') {
        void client.resize(sessionId, msg.cols, msg.rows).catch(() => {});
      } else if (msg.t === 'ping') {
        sendJson(ws, { t: 'pong', ts: msg.ts });
      }
    } catch {
      log(`ignoring malformed control frame on session ${sessionId}`);
    }
  });
}
