/**
 * Client side of the ptyd unix socket, used by the web gateway and the CLI.
 *
 * One instance is one viewer. The gateway keeps a long-lived control instance
 * for listing and lifecycle calls, plus one instance per attached browser
 * terminal so ptyd can tell the viewers apart when reconciling window sizes.
 */

import net from 'node:net';
import type {
  Event,
  Message,
  Request,
  ResponseData,
  SessionMeta,
} from './protocol.ts';
import {
  FrameDecoder,
  FrameType,
  ProtocolError,
  encodeData,
  encodeJson,
} from './protocol.ts';

export class PtydError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface PtydClientHandlers {
  onEvent?: (evt: Event) => void;
  onOutput?: (sessionId: string, data: Buffer) => void;
  onClose?: (err?: Error) => void;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class PtydClient {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private ridSeq = 0;
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    /** Mutable so a caller can take over the stream, as `attach` does. */
    readonly handlers: PtydClientHandlers,
  ) {
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.teardown(err));
    socket.on('close', () => this.teardown());
  }

  static connect(
    socketFile: string,
    handlers: PtydClientHandlers = {},
  ): Promise<PtydClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketFile);
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(new PtydClient(socket, handlers));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // -------------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.teardown(err instanceof ProtocolError ? err : (err as Error));
      this.socket.destroy();
      return;
    }

    for (const frame of frames) {
      if (frame.type === FrameType.Out) {
        this.handlers.onOutput?.(frame.sessionId!, frame.data!);
        continue;
      }
      if (frame.type !== FrameType.Json) continue;

      const msg: Message = frame.json!;
      if (msg.t === 'res') {
        const pending = this.pending.get(msg.rid);
        if (!pending) continue;
        this.pending.delete(msg.rid);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new PtydError(msg.error.code, msg.error.message));
      } else if (msg.t === 'evt') {
        this.handlers.onEvent?.(msg);
      }
    }
  }

  private teardown(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err ?? new PtydError('closed', 'connection to ptyd closed'));
    }
    this.pending.clear();
    this.handlers.onClose?.(err);
  }

  private send(msg: Message): void {
    if (this.closed) throw new PtydError('closed', 'connection to ptyd closed');
    this.socket.write(encodeJson(msg));
  }

  private request<K extends keyof ResponseData>(
    req: Omit<Extract<Request, { op: K }>, 't' | 'rid'>,
  ): Promise<ResponseData[K]> {
    const rid = ++this.ridSeq;
    const full = { t: 'req', rid, ...req } as Request;
    return new Promise<ResponseData[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new PtydError('timeout', `ptyd did not answer ${String(req.op)}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(rid, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send(full);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err as Error);
      }
    });
  }

  // --- Operations -----------------------------------------------------------

  async list(): Promise<SessionMeta[]> {
    return (await this.request<'list'>({ op: 'list' })).sessions;
  }

  async create(opts: {
    name?: string;
    cwd?: string;
    argv?: string[];
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  } = {}): Promise<SessionMeta> {
    return (await this.request<'create'>({ op: 'create', ...opts })).session;
  }

  async get(id: string): Promise<SessionMeta> {
    return (await this.request<'get'>({ op: 'get', id })).session;
  }

  async rename(id: string, name: string): Promise<SessionMeta> {
    return (await this.request<'rename'>({ op: 'rename', id, name })).session;
  }

  async kill(id: string, signal?: string, force?: boolean): Promise<void> {
    await this.request<'kill'>({ op: 'kill', id, signal, force });
  }

  async setLock(id: string, locked: boolean): Promise<SessionMeta> {
    return (await this.request<'setLock'>({ op: 'setLock', id, locked })).session;
  }

  async resize(
    id: string,
    cols: number,
    rows: number,
  ): Promise<{ cols: number; rows: number }> {
    const res = await this.request<'resize'>({ op: 'resize', id, cols, rows });
    return { cols: res.cols, rows: res.rows };
  }

  async subscribe(
    id: string,
    opts: { snapshot?: boolean; cols?: number; rows?: number } = {},
  ): Promise<SessionMeta> {
    return (await this.request<'subscribe'>({ op: 'subscribe', id, ...opts })).session;
  }

  async unsubscribe(id: string): Promise<void> {
    await this.request<'unsubscribe'>({ op: 'unsubscribe', id });
  }

  async snapshot(id: string): Promise<void> {
    await this.request<'snapshot'>({ op: 'snapshot', id });
  }

  async stats(): Promise<ResponseData['stats']> {
    return this.request<'stats'>({ op: 'stats' });
  }

  /** Raw keystrokes for a session. Fire and forget, like typing. */
  sendInput(sessionId: string, data: Buffer | string): void {
    if (this.closed) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.socket.write(encodeData(FrameType.In, sessionId, buf));
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
    this.socket.destroy();
    this.teardown();
  }
}
