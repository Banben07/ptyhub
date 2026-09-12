/**
 * The unix socket front door of ptyd.
 *
 * Every connection is one viewer: the web gateway opens one per attached
 * browser terminal plus a control connection, and `ptyhub attach` opens one of
 * its own. A connection appearing or disappearing never touches a PTY.
 */

import net from 'node:net';
import type { Config } from '../shared/config.ts';
import type {
  Event,
  Frame,
  Message,
  Request,
  Response,
  ResponseData,
} from '../shared/protocol.ts';
import {
  FrameDecoder,
  FrameType,
  ProtocolError,
  encodeData,
  encodeJson,
} from '../shared/protocol.ts';
import { VERSION } from '../shared/version.ts';
import type { Subscriber } from './session.ts';
import { Registry, RegistryError } from './registry.ts';

/**
 * Disconnect a viewer that has stopped reading past this much backlog.
 * Overridable so a test can shrink it and force the condition deterministically
 * without actually pushing megabytes through a real socket.
 */
const MAX_SOCKET_BACKLOG = Number(process.env.PTYHUB_MAX_SOCKET_BACKLOG) || 8 * 1024 * 1024;

let nextKey = 1;

class Connection implements Subscriber {
  readonly key = nextKey++;
  private readonly decoder = new FrameDecoder();
  private readonly subscribed = new Set<string>();
  private readonly unlisten: () => void;
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly registry: Registry,
    private readonly log: (msg: string) => void,
  ) {
    socket.setNoDelay(true);
    this.unlisten = registry.onEvent((evt) => this.sendEvent(evt));

    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  // --- Subscriber -----------------------------------------------------------

  sendOut(sessionId: string, data: Buffer): void {
    if (this.closed) return;
    // A viewer that stalls (suspended phone, wedged tunnel) must not be able to
    // grow ptyd's memory without bound — but silently skipping output while
    // pretending the connection is still healthy is worse than disconnecting
    // it. This stream is arbitrary bytes mid-escape-sequence to a full-screen
    // program (vim, htop, a TUI): drop a chunk in the middle of one and the
    // client's rendered screen can permanently diverge from ptyd's own
    // headless copy, with nothing in the protocol able to detect or repair it
    // afterwards. So disconnect outright. Every caller's reconnect path
    // already re-subscribes and replays a fresh snapshot on the way back in,
    // which is the only correct recovery — a snapshot exists precisely for
    // this, and a connection that kept dropping bytes while claiming to be
    // fine would never use it.
    if (this.socket.writableLength > MAX_SOCKET_BACKLOG) {
      this.log(`connection ${this.key} is not draining; closing it rather than dropping output`);
      this.socket.destroy();
      return;
    }
    this.socket.write(encodeData(FrameType.Out, sessionId, data));
  }

  sendEvent(evt: Event): void {
    this.send(evt);
  }

  private send(msg: Message): void {
    if (this.closed) return;
    this.socket.write(encodeJson(msg));
  }

  // --- Wire handling --------------------------------------------------------

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.log(`connection ${this.key} protocol error: ${err.message}`);
        this.socket.destroy();
        return;
      }
      throw err;
    }

    for (const frame of frames) {
      if (frame.type === FrameType.In) {
        const session = this.registry.get(frame.sessionId!);
        if (session) session.write(this, frame.data!);
      } else if (frame.type === FrameType.Json) {
        const msg = frame.json!;
        if (msg.t === 'req') this.handleRequest(msg);
      }
    }
  }

  private ok<K extends keyof ResponseData>(rid: number, data: ResponseData[K]): void {
    const res: Response = { t: 'res', rid, ok: true, data };
    this.send(res);
  }

  private fail(rid: number, code: string, message: string): void {
    const res: Response = { t: 'res', rid, ok: false, error: { code, message } };
    this.send(res);
  }

  private handleRequest(req: Request): void {
    try {
      switch (req.op) {
        case 'list':
          this.ok<'list'>(req.rid, { sessions: this.registry.metas() });
          return;

        case 'create': {
          const session = this.registry.create({
            name: req.name,
            cwd: req.cwd,
            argv: req.argv,
            cols: req.cols,
            rows: req.rows,
            env: req.env,
          });
          this.ok<'create'>(req.rid, { session: session.meta });
          return;
        }

        case 'get':
          this.ok<'get'>(req.rid, { session: this.registry.require(req.id).meta });
          return;

        case 'rename': {
          const session = this.registry.require(req.id);
          const name = req.name.trim();
          if (!name) {
            this.fail(req.rid, 'bad_name', 'name must not be empty');
            return;
          }
          session.rename(name.slice(0, 128));
          this.ok<'rename'>(req.rid, { session: session.meta });
          return;
        }

        case 'kill': {
          const session = this.registry.require(req.id);
          // The lock lives here rather than in the UI so that it holds for
          // every client, the CLI included.
          if (session.locked && req.force !== true) {
            this.fail(
              req.rid,
              'session_locked',
              `session ${session.name} is locked; unlock it or force the close`,
            );
            return;
          }
          // Closing is one action, not two. A session the user asked to close
          // disappears; only a session that exited on its own is kept around
          // afterwards, because then the exit status is worth reading.
          if (session.alive) session.kill(req.signal ?? 'SIGHUP');
          this.registry.remove(req.id);
          this.ok<'kill'>(req.rid, { id: req.id });
          return;
        }

        case 'setLock': {
          const session = this.registry.require(req.id);
          session.setLocked(req.locked === true);
          this.ok<'setLock'>(req.rid, { session: session.meta });
          return;
        }

        case 'resize': {
          const session = this.registry.require(req.id);
          session.declareSize(session.isAttached(this) ? this : null, req.cols, req.rows);
          this.ok<'resize'>(req.rid, {
            id: req.id,
            cols: session.cols,
            rows: session.rows,
          });
          return;
        }

        case 'subscribe': {
          const session = this.registry.require(req.id);
          // Everything below happens in one tick so live output cannot slip in
          // between the snapshot and the start of the live stream.
          session.attach(this, req.cols, req.rows);
          this.subscribed.add(req.id);
          this.ok<'subscribe'>(req.rid, { session: session.meta });
          if (req.snapshot !== false) {
            const snap = session.snapshot();
            if (snap.length > 0) this.sendOut(req.id, snap);
          }
          this.sendEvent({
            t: 'evt',
            ev: 'ready',
            id: req.id,
            cols: session.cols,
            rows: session.rows,
          });
          return;
        }

        case 'unsubscribe': {
          const session = this.registry.get(req.id);
          if (session) session.detach(this);
          this.subscribed.delete(req.id);
          this.ok<'unsubscribe'>(req.rid, { id: req.id });
          return;
        }

        case 'snapshot': {
          const session = this.registry.require(req.id);
          const snap = session.snapshot();
          this.ok<'snapshot'>(req.rid, { id: req.id });
          if (snap.length > 0) this.sendOut(req.id, snap);
          return;
        }

        case 'stats':
          this.ok<'stats'>(req.rid, {
            pid: process.pid,
            startedAt: startedAt,
            sessions: this.registry.size,
            aliveSessions: this.registry.aliveCount,
            subscribers: connections.size,
            version: VERSION,
          });
          return;

        default: {
          const unknown = req as { op: string };
          this.fail(
            (req as { rid: number }).rid,
            'bad_op',
            `unknown op: ${unknown.op}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof RegistryError) {
        this.fail(req.rid, err.code, err.message);
      } else {
        this.log(`request ${req.op} failed: ${String(err)}`);
        this.fail(req.rid, 'internal', String(err));
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    for (const id of this.subscribed) {
      this.registry.get(id)?.detach(this);
    }
    this.subscribed.clear();
    connections.delete(this);
    this.socket.destroy();
  }
}

const connections = new Set<Connection>();
const startedAt = Date.now();

export interface IpcServer {
  close(): Promise<void>;
  connectionCount(): number;
}

export function startIpcServer(
  registry: Registry,
  socketFile: string,
  _cfg: Config,
  log: (msg: string) => void,
): Promise<IpcServer> {
  const server = net.createServer((socket) => {
    const conn = new Connection(socket, registry, log);
    connections.add(conn);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketFile, () => {
      server.removeListener('error', reject);
      server.on('error', (err) => log(`ipc server error: ${String(err)}`));
      resolve({
        connectionCount: () => connections.size,
        close: () =>
          new Promise<void>((done) => {
            for (const conn of [...connections]) conn.close();
            server.close(() => done());
          }),
      });
    });
  });
}
