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
  deviceActive: (id: string) => boolean;
  onDeviceRevoked: (listener: (id: string | null) => void) => () => void;
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
  const devices = new Map<string, Set<WebSocket>>();
  const identities = new WeakMap<WebSocket, AuthContext>();
  const authorised = (ws: WebSocket): boolean => {
    const auth = identities.get(ws);
    if (!auth || (auth.deviceId && !deps.deviceActive(auth.deviceId))) {
      ws.terminate();
      return false;
    }
    return true;
  };
  const offRevocation = deps.onDeviceRevoked((id) => {
    const groups = id === null ? [...devices.values()] : [devices.get(id)];
    for (const group of groups) {
      if (group) for (const ws of group) ws.terminate();
    }
  });

  // A suspended phone leaves a socket that looks open but never answers.
  // Heartbeats reap those so ptyd does not keep broadcasting into the void.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!authorised(ws)) continue;
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const track = (ws: WebSocket, auth: AuthContext) => {
    identities.set(ws, auth);
    if (auth.deviceId) {
      const id = auth.deviceId;
      let group = devices.get(id);
      if (!group) devices.set(id, (group = new Set()));
      group.add(ws);
      ws.once('close', () => {
        group.delete(ws);
        if (group.size === 0) devices.delete(id);
      });
    }
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => ws.terminate());
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

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
        track(ws, auth);
        if (authorised(ws)) handleEvents(ws, control, () => authorised(ws));
      });
      return;
    }

    if (parts[1] === 'sessions' && parts.length === 3) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(parts[2]!);
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws, auth);
        if (!authorised(ws)) return;
        void handleTerminal(
          ws,
          sessionId,
          {
            cols: positiveParam(url.searchParams.get('cols')),
            rows: positiveParam(url.searchParams.get('rows')),
          },
          deps,
          () => authorised(ws),
        );
      });
      return;
    }

    rejectUpgrade(socket, 404, 'Not Found');
  };
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      upgrade(req, socket, head);
    } catch (err) {
      log(`websocket upgrade failed: ${String(err)}`);
      socket.destroy();
    }
  };
  server.on('upgrade', handleUpgrade);

  return () => {
    server.removeListener('upgrade', handleUpgrade);
    offRevocation();
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}

// ---------------------------------------------------------------------------

function handleEvents(ws: WebSocket, control: PtydControl, authorised: () => boolean): void {
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
    if (!authorised()) return;
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
  authorised: () => boolean,
): Promise<void> {
  const { cfg, socketFile, log } = deps;

  let client: PtydClient | null = null;
  let ended = false;
  let attached = false;
  const connecting = new AbortController();
  const cleanup = () => {
    ended = true;
    const current = client;
    client = null;
    connecting.abort();
    current?.close();
  };
  ws.once('close', cleanup);
  ws.once('error', cleanup);
  const active = () => !ended && ws.readyState === ws.OPEN && authorised();

  // Install before starting any asynchronous IPC work. A ready frame can reach
  // the browser before subscribe() resolves, and its first input must not vanish.
  ws.on('message', (raw, isBinary) => {
    if (!active()) return;
    if (isBinary) {
      if (attached) client?.sendInput(sessionId, raw as Buffer);
      return;
    }
    try {
      const msg = JSON.parse(String(raw)) as ClientWsMessage;
      if (msg.t === 'resize' && attached) {
        void client?.resize(sessionId, msg.cols, msg.rows).catch(() => {});
      } else if (msg.t === 'ping') {
        sendJson(ws, { t: 'pong', ts: msg.ts });
      }
    } catch {
      log(`ignoring malformed control frame on session ${sessionId}`);
    }
  });

  try {
    client = await PtydClient.connect(socketFile, {
      onOutput: (_id, data) => {
        if (ended || ws.readyState !== ws.OPEN) return;
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
        if (ended) return;
        if ('id' in evt && evt.id !== sessionId) return;
        switch (evt.ev) {
          case 'ready':
            attached = true;
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
        if (ended) return;
        sendJson(ws, {
          t: 'error',
          code: 'ptyd_unavailable',
          message: 'lost connection to ptyd',
        });
        ws.close(1011, 'ptyd unavailable');
      },
    }, connecting.signal);
  } catch (err) {
    if (ended) return;
    sendJson(ws, {
      t: 'error',
      code: 'ptyd_unavailable',
      message: `cannot reach ptyd: ${String(err)}`,
    });
    ws.close(1011, 'ptyd unavailable');
    return;
  }

  if (!active()) { cleanup(); return; }
  const connected = client;

  try {
    const meta = await connected.get(sessionId);
    if (!active()) { cleanup(); return; }
    // The browser resets its terminal on `hello`, so it must arrive before the
    // snapshot bytes that subscribe is about to produce.
    sendJson(ws, { t: 'hello', session: meta, policy: cfg.resizePolicy });

    // Only declare a size when the client actually told us one; a viewer that
    // has not measured itself yet must not get a vote.
    const wantsSize = size.cols !== undefined && size.rows !== undefined;
    await connected.subscribe(sessionId, {
      cols: wantsSize ? size.cols : undefined,
      rows: wantsSize ? size.rows : undefined,
    });
    if (!active()) cleanup();
  } catch (err) {
    if (ended) return;
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ws, { t: 'error', code: 'attach_failed', message });
    ws.close(1011, 'attach failed');
    cleanup();
    return;
  }
}
