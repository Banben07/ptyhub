/**
 * Wire protocol shared by ptyd, the web gateway, the CLI and the browser.
 *
 * Two transports carry the same logical messages:
 *
 *   ptyd <-> gateway/CLI   length-prefixed binary frames over a unix socket
 *   gateway <-> browser    WebSocket, JSON in text frames, PTY bytes in binary frames
 *
 * Frame layout on the unix socket:
 *
 *   [4B big-endian payload length][1B frame type][payload]
 *
 * For Out/In frames the payload begins with a fixed-width session id so a
 * single connection can multiplex every session it has subscribed to.
 */

export const SESSION_ID_LEN = 12;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const FrameType = {
  /** UTF-8 JSON control message. */
  Json: 1,
  /** PTY output: ptyd -> subscriber. */
  Out: 2,
  /** PTY input: subscriber -> ptyd. */
  In: 3,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  name: string;
  cwd: string;
  argv: string[];
  createdAt: number;
  cols: number;
  rows: number;
  pid: number;
  /** Foreground process name, derived from the tty's tpgid. */
  fgProc: string;
  /** Last title set by the shell via OSC 0/2. */
  title: string;
  /** How many clients are attached right now, across browsers and the CLI. */
  viewers: number;
  /**
   * Protected from being closed. Enforced by ptyd, not by the UI: a lock that
   * only greys out a button is no lock at all, because the CLI and every other
   * browser could still kill the session.
   */
  locked: boolean;
  alive: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  exitedAt: number | null;
}

/** How ptyd reconciles differing window sizes from multiple attached clients. */
export type ResizePolicy = 'active' | 'min';

// ---------------------------------------------------------------------------
// Requests: subscriber -> ptyd
// ---------------------------------------------------------------------------

export interface ReqBase {
  t: 'req';
  /** Correlates with the matching response. */
  rid: number;
}

export interface ReqList extends ReqBase {
  op: 'list';
}

export interface ReqCreate extends ReqBase {
  op: 'create';
  name?: string;
  cwd?: string;
  argv?: string[];
  cols?: number;
  rows?: number;
  /** Extra environment entries. Deliberately empty in normal use. */
  env?: Record<string, string>;
}

export interface ReqGet extends ReqBase {
  op: 'get';
  id: string;
}

export interface ReqRename extends ReqBase {
  op: 'rename';
  id: string;
  name: string;
}

export interface ReqKill extends ReqBase {
  op: 'kill';
  id: string;
  signal?: string;
  /** Close even when the session is locked. */
  force?: boolean;
}

export interface ReqSetLock extends ReqBase {
  op: 'setLock';
  id: string;
  locked: boolean;
}

/**
 * Declares the window size this subscriber would like for the session.
 * ptyd reconciles all attached subscribers according to the configured
 * resize policy and broadcasts the winning size back as a `resized` event.
 */
export interface ReqResize extends ReqBase {
  op: 'resize';
  id: string;
  cols: number;
  rows: number;
}

export interface ReqSubscribe extends ReqBase {
  op: 'subscribe';
  id: string;
  /** Send a screen-restoring snapshot before live output. Defaults to true. */
  snapshot?: boolean;
  /** Declare an initial window size along with the subscription. */
  cols?: number;
  rows?: number;
}

export interface ReqUnsubscribe extends ReqBase {
  op: 'unsubscribe';
  id: string;
}

export interface ReqSnapshot extends ReqBase {
  op: 'snapshot';
  id: string;
}

export interface ReqStats extends ReqBase {
  op: 'stats';
}

export type Request =
  | ReqList
  | ReqCreate
  | ReqGet
  | ReqRename
  | ReqKill
  | ReqSetLock
  | ReqResize
  | ReqSubscribe
  | ReqUnsubscribe
  | ReqSnapshot
  | ReqStats;

export type RequestOp = Request['op'];

// ---------------------------------------------------------------------------
// Responses: ptyd -> subscriber
// ---------------------------------------------------------------------------

export interface ResOk<T = unknown> {
  t: 'res';
  rid: number;
  ok: true;
  data: T;
}

export interface ResErr {
  t: 'res';
  rid: number;
  ok: false;
  error: { code: string; message: string };
}

export type Response<T = unknown> = ResOk<T> | ResErr;

export interface StatsData {
  pid: number;
  startedAt: number;
  sessions: number;
  aliveSessions: number;
  subscribers: number;
  version: string;
}

/** Maps each request op to the shape of its successful response payload. */
export interface ResponseData {
  list: { sessions: SessionMeta[] };
  create: { session: SessionMeta };
  get: { session: SessionMeta };
  rename: { session: SessionMeta };
  kill: { id: string };
  setLock: { session: SessionMeta };
  resize: { id: string; cols: number; rows: number };
  subscribe: { session: SessionMeta };
  unsubscribe: { id: string };
  snapshot: { id: string };
  stats: StatsData;
}

// ---------------------------------------------------------------------------
// Events: ptyd -> every subscriber
// ---------------------------------------------------------------------------

export interface EvtCreated {
  t: 'evt';
  ev: 'created';
  session: SessionMeta;
}

export interface EvtRenamed {
  t: 'evt';
  ev: 'renamed';
  id: string;
  name: string;
}

export interface EvtExited {
  t: 'evt';
  ev: 'exited';
  id: string;
  exitCode: number | null;
  exitSignal: number | null;
}

/** Emitted when a session is removed from the registry entirely. */
export interface EvtRemoved {
  t: 'evt';
  ev: 'removed';
  id: string;
}

export interface EvtProc {
  t: 'evt';
  ev: 'proc';
  id: string;
  fgProc: string;
}

export interface EvtTitle {
  t: 'evt';
  ev: 'title';
  id: string;
  title: string;
}

/** The authoritative window size after reconciling all attached clients. */
export interface EvtResized {
  t: 'evt';
  ev: 'resized';
  id: string;
  cols: number;
  rows: number;
}

/**
 * Attached-client count changed. Lets a viewer tell "I am the only one here"
 * from "someone else is driving this session's size".
 */
export interface EvtViewers {
  t: 'evt';
  ev: 'viewers';
  id: string;
  viewers: number;
}

export interface EvtLocked {
  t: 'evt';
  ev: 'locked';
  id: string;
  locked: boolean;
}

/** Marks the end of the snapshot replay that follows a subscribe. */
export interface EvtReady {
  t: 'evt';
  ev: 'ready';
  id: string;
  cols: number;
  rows: number;
}

export type Event =
  | EvtCreated
  | EvtRenamed
  | EvtExited
  | EvtRemoved
  | EvtProc
  | EvtTitle
  | EvtResized
  | EvtViewers
  | EvtLocked
  | EvtReady;

export type Message = Request | Response | Event;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export interface Frame {
  type: FrameTypeValue;
  /** Present for Out/In frames. */
  sessionId?: string;
  /** JSON payload for Json frames. */
  json?: Message;
  /** Raw PTY bytes for Out/In frames. */
  data?: Buffer;
}

export function encodeJson(msg: Message): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out.writeUInt8(FrameType.Json, 4);
  body.copy(out, 5);
  return out;
}

export function encodeData(
  type: typeof FrameType.Out | typeof FrameType.In,
  sessionId: string,
  data: Buffer,
): Buffer {
  const id = Buffer.alloc(SESSION_ID_LEN, 0);
  id.write(sessionId, 0, SESSION_ID_LEN, 'ascii');
  const out = Buffer.allocUnsafe(5 + SESSION_ID_LEN + data.length);
  out.writeUInt32BE(SESSION_ID_LEN + data.length + 1, 0);
  out.writeUInt8(type, 4);
  id.copy(out, 5);
  data.copy(out, 5 + SESSION_ID_LEN);
  return out;
}

export class ProtocolError extends Error {}

/**
 * Streaming frame decoder. Feed it socket chunks, get back whole frames.
 * Keeps a single growable buffer rather than an array of pending chunks so
 * a busy session does not turn into a concat storm.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME_BYTES) {
        throw new ProtocolError(`frame length out of range: ${len}`);
      }
      if (this.buf.length < 4 + len) break;

      const type = this.buf.readUInt8(4) as FrameTypeValue;
      const payload = this.buf.subarray(5, 4 + len);

      if (type === FrameType.Json) {
        let json: Message;
        try {
          json = JSON.parse(payload.toString('utf8')) as Message;
        } catch {
          throw new ProtocolError('malformed JSON frame');
        }
        frames.push({ type, json });
      } else if (type === FrameType.Out || type === FrameType.In) {
        if (payload.length < SESSION_ID_LEN) {
          throw new ProtocolError('data frame shorter than session id');
        }
        const sessionId = payload
          .subarray(0, SESSION_ID_LEN)
          .toString('ascii')
          .replace(/\0+$/, '');
        // Copy: the slice would otherwise pin the whole accumulation buffer.
        frames.push({
          type,
          sessionId,
          data: Buffer.from(payload.subarray(SESSION_ID_LEN)),
        });
      } else {
        throw new ProtocolError(`unknown frame type: ${type}`);
      }

      this.buf = this.buf.subarray(4 + len);
    }

    // Release the backing store once everything buffered has been consumed.
    if (this.buf.length === 0) this.buf = Buffer.alloc(0);
    return frames;
  }
}

// ---------------------------------------------------------------------------
// Browser <-> gateway WebSocket messages
//
// Binary frames are raw PTY bytes in both directions; these JSON messages ride
// in text frames alongside them.
// ---------------------------------------------------------------------------

export type ClientWsMessage =
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'ping'; ts: number };

export type ServerWsMessage =
  | { t: 'hello'; session: SessionMeta; policy: ResizePolicy }
  | { t: 'ready'; cols: number; rows: number }
  | { t: 'resized'; cols: number; rows: number }
  | { t: 'proc'; fgProc: string }
  | { t: 'title'; title: string }
  | { t: 'viewers'; viewers: number }
  | { t: 'locked'; locked: boolean }
  | { t: 'exit'; exitCode: number | null; exitSignal: number | null }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: string; message: string };

/** Health of the gateway's own connection to ptyd, surfaced in the UI. */
export type PtydStatus = 'connected' | 'connecting' | 'down';

/**
 * The session-list channel (`/ws/events`). One per browser tab; carries
 * everything needed to keep the sidebar, tab bar and favicon in sync.
 */
export type EventsWsMessage =
  | { t: 'snapshot'; sessions: SessionMeta[]; status: PtydStatus }
  | { t: 'event'; event: Event }
  | { t: 'status'; status: PtydStatus }
  | { t: 'pong'; ts: number };

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars, no look-alikes

/** 12-char lowercase base32-ish id: 60 bits, collision-free in practice here. */
export function newSessionId(random: (n: number) => Uint8Array): string {
  const bytes = random(SESSION_ID_LEN);
  let out = '';
  for (let i = 0; i < SESSION_ID_LEN; i++) {
    out += ID_ALPHABET[bytes[i]! & 31];
  }
  return out;
}

export function isSessionId(value: string): boolean {
  if (value.length !== SESSION_ID_LEN) return false;
  for (const ch of value) if (!ID_ALPHABET.includes(ch)) return false;
  return true;
}
