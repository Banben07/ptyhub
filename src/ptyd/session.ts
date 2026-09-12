/**
 * One PTY session: the shell, the master fd, and everyone currently watching it.
 *
 * The whole point of ptyd is that this object outlives every viewer. Attaching
 * and detaching only adds or removes an entry in `attached`; the PTY itself is
 * untouched, so the shell never sees a hangup.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { Event, ResizePolicy, SessionMeta } from '../shared/protocol.ts';
import { RingBuffer } from './ringbuffer.ts';
import { foregroundProcess } from './procinfo.ts';
import {
  SerializeAddon,
  Terminal,
  type HeadlessTerminal,
  type Serializer,
} from './xterm-interop.ts';

export const MIN_COLS = 2;
export const MIN_ROWS = 1;
export const MAX_COLS = 1000;
export const MAX_ROWS = 1000;

export function clampCols(n: number): number {
  if (!Number.isFinite(n)) return MIN_COLS;
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(n)));
}

export function clampRows(n: number): number {
  if (!Number.isFinite(n)) return MIN_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(n)));
}

/**
 * Whether a client's declared window size is worth acting on.
 *
 * Clamping is not enough on its own: zero, NaN and null all clamp to the 2x1
 * minimum, and a viewer that has not measured itself yet must not be able to
 * squeeze a real shell down to two columns.
 */
export function isUsableSize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    cols >= MIN_COLS &&
    rows >= MIN_ROWS
  );
}

/** Anything that can receive output and events for a session. */
export interface Subscriber {
  readonly key: number;
  sendOut(sessionId: string, data: Buffer): void;
  sendEvent(evt: Event): void;
}

export interface SessionInit {
  id: string;
  name: string;
  cwd: string;
  file: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  scrollback: number;
  snapshotScrollback: number;
  rawBufferBytes: number;
  reviveScreen: boolean;
  resizePolicy: ResizePolicy;
}

interface Attachment {
  cols: number;
  rows: number;
  /** Last time this client typed or resized; drives the `active` policy. */
  activeAt: number;
  /** False until the client has declared a window size. */
  sized: boolean;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly argv: string[];
  readonly createdAt = Date.now();
  readonly pid: number;

  name: string;
  cols: number;
  rows: number;
  fgProc = '';
  title = '';
  /** Refuses `kill` without an explicit force. See `ipc-server`. */
  locked = false;
  alive = true;
  exitCode: number | null = null;
  exitSignal: number | null = null;
  exitedAt: number | null = null;

  private readonly pty: IPty;
  private readonly ring: RingBuffer;
  private readonly term: HeadlessTerminal | null = null;
  private readonly serializer: Serializer | null = null;
  private readonly snapshotScrollback: number;
  private readonly attached = new Map<Subscriber, Attachment>();
  /**
   * Output handed to the headless terminal but not parsed by it yet. xterm
   * parses asynchronously, so a snapshot taken right now would otherwise miss
   * these bytes and the reconnecting client would never see them.
   */
  private readonly pending: Buffer[] = [];

  private resizePolicy: ResizePolicy;
  private emit: (evt: Event) => void = () => {};
  private disposed = false;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.name = init.name;
    this.cwd = init.cwd;
    this.argv = [init.file, ...init.args];
    this.cols = clampCols(init.cols);
    this.rows = clampRows(init.rows);
    this.resizePolicy = init.resizePolicy;
    this.snapshotScrollback = init.snapshotScrollback;
    this.ring = new RingBuffer(init.rawBufferBytes);

    this.pty = ptySpawn(init.file, init.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: init.cwd,
      env: init.env,
    });
    this.pid = this.pty.pid;

    if (init.reviveScreen) {
      this.term = new Terminal({
        cols: this.cols,
        rows: this.rows,
        scrollback: init.scrollback,
        allowProposedApi: true,
      });
      this.serializer = new SerializeAddon();
      this.term.loadAddon(this.serializer);
      this.term.onTitleChange((title) => {
        if (title === this.title) return;
        this.title = title;
        this.emit({ t: 'evt', ev: 'title', id: this.id, title });
      });
    }

    this.pty.onData((chunk) => this.onOutput(chunk));
    this.pty.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));
  }

  /** Called once by the registry to route events out. */
  setEmitter(emit: (evt: Event) => void): void {
    this.emit = emit;
  }

  get meta(): SessionMeta {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      argv: this.argv,
      createdAt: this.createdAt,
      cols: this.cols,
      rows: this.rows,
      pid: this.pid,
      fgProc: this.fgProc,
      title: this.title,
      viewers: this.attached.size,
      locked: this.locked,
      alive: this.alive,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      exitedAt: this.exitedAt,
    };
  }

  get subscriberCount(): number {
    return this.attached.size;
  }

  // -------------------------------------------------------------------------
  // PTY plumbing
  // -------------------------------------------------------------------------

  private onOutput(chunk: string): void {
    const buf = Buffer.from(chunk, 'utf8');
    this.ring.write(buf);
    if (this.term) {
      this.pending.push(buf);
      // xterm invokes write callbacks in order, so shifting keeps the queue
      // aligned with what the parser has actually consumed.
      this.term.write(chunk, () => this.pending.shift());
    }
    for (const sub of this.attached.keys()) {
      sub.sendOut(this.id, buf);
    }
  }

  private onExit(exitCode: number, signal: number | undefined): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = exitCode;
    this.exitSignal = signal ?? null;
    this.exitedAt = Date.now();
    this.emit({
      t: 'evt',
      ev: 'exited',
      id: this.id,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
    });
  }

  write(sub: Subscriber | null, data: Buffer): void {
    if (!this.alive) return;
    if (sub) {
      const att = this.attached.get(sub);
      if (att) att.activeAt = Date.now();
    }
    try {
      this.pty.write(data.toString('utf8'));
    } catch {
      // The process died between the liveness check and the write.
    }
  }

  // -------------------------------------------------------------------------
  // Attachment and size reconciliation
  // -------------------------------------------------------------------------

  attach(sub: Subscriber, cols?: number, rows?: number): void {
    const sized = isUsableSize(cols, rows);
    this.attached.set(sub, {
      cols: sized ? clampCols(cols!) : this.cols,
      rows: sized ? clampRows(rows!) : this.rows,
      activeAt: Date.now(),
      sized,
    });
    if (sized) this.reconcileSize();
    this.announceViewers();
  }

  detach(sub: Subscriber): void {
    if (this.attached.delete(sub)) {
      this.reconcileSize();
      this.announceViewers();
    }
  }

  private announceViewers(): void {
    this.emit({ t: 'evt', ev: 'viewers', id: this.id, viewers: this.attached.size });
  }

  isAttached(sub: Subscriber): boolean {
    return this.attached.has(sub);
  }

  declareSize(sub: Subscriber | null, cols: number, rows: number): void {
    if (!isUsableSize(cols, rows)) return;
    if (sub) {
      const att = this.attached.get(sub);
      if (!att) return;
      att.cols = clampCols(cols);
      att.rows = clampRows(rows);
      att.activeAt = Date.now();
      att.sized = true;
      this.reconcileSize();
      return;
    }
    // No subscriber context (e.g. a REST resize call): apply directly.
    this.applySize(clampCols(cols), clampRows(rows));
  }

  setResizePolicy(policy: ResizePolicy): void {
    if (policy === this.resizePolicy) return;
    this.resizePolicy = policy;
    this.reconcileSize();
  }

  /**
   * Pick the winning window size among attached clients.
   *
   * `active` follows whoever typed or resized most recently, so a phone joining
   * a session does not squeeze the laptop that is driving it. `min` takes the
   * smallest of every client so nobody ever sees wrapped garbage.
   */
  private reconcileSize(): void {
    const sized = [...this.attached.values()].filter((a) => a.sized);
    if (sized.length === 0) return;

    let cols: number;
    let rows: number;

    if (this.resizePolicy === 'min') {
      cols = Math.min(...sized.map((a) => a.cols));
      rows = Math.min(...sized.map((a) => a.rows));
    } else {
      const winner = sized.reduce((best, a) => (a.activeAt > best.activeAt ? a : best));
      cols = winner.cols;
      rows = winner.rows;
    }

    this.applySize(cols, rows);
  }

  private applySize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.alive) {
      try {
        // Resizing the master fd makes the kernel deliver SIGWINCH to the
        // foreground process group; nothing else needs to signal anyone.
        this.pty.resize(cols, rows);
      } catch {
        // Raced with process exit.
      }
    }
    this.term?.resize(cols, rows);
    this.emit({ t: 'evt', ev: 'resized', id: this.id, cols, rows });
  }

  // -------------------------------------------------------------------------
  // Screen restore
  // -------------------------------------------------------------------------

  /**
   * Bytes that rebuild the current screen on a freshly reset terminal.
   * With the headless terminal running this is exact, including full-screen
   * programs; otherwise it degrades to replaying the raw ring buffer.
   */
  snapshot(): Buffer {
    if (this.serializer) {
      const parsed = Buffer.from(
        this.serializer.serialize({ scrollback: this.snapshotScrollback }),
        'utf8',
      );
      // Append whatever the parser has not caught up on yet, in arrival order.
      return this.pending.length === 0
        ? parsed
        : Buffer.concat([parsed, ...this.pending]);
    }
    return this.ring.read();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  rename(name: string): void {
    this.name = name;
    this.emit({ t: 'evt', ev: 'renamed', id: this.id, name });
  }

  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.emit({ t: 'evt', ev: 'locked', id: this.id, locked });
  }

  kill(signal = 'SIGHUP'): void {
    if (!this.alive) return;
    try {
      this.pty.kill(signal);
    } catch {
      // Already gone.
    }
  }

  /** Re-read the foreground process; returns true when it changed. */
  refreshProc(): boolean {
    if (!this.alive) {
      if (this.fgProc === '') return false;
      this.fgProc = '';
      return true;
    }
    const proc = foregroundProcess(this.pid) ?? '';
    if (proc === this.fgProc) return false;
    this.fgProc = proc;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Stop talking: the registry announces the removal, and a later `exited`
    // for a session nobody can look up any more would only confuse clients.
    this.emit = () => {};
    this.attached.clear();
    if (this.alive) {
      try {
        this.pty.kill('SIGHUP');
      } catch {
        // Already gone.
      }
    }
    this.term?.dispose();
    this.ring.clear();
    this.pending.length = 0;
  }
}
