/**
 * The session table. Owns every Session, hands out ids, fans events out to all
 * connected subscribers, and keeps a mirror of the current state on disk.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import type { Config } from '../shared/config.ts';
import { paths, resolveShell, writeJson } from '../shared/config.ts';
import type { Event, SessionMeta } from '../shared/protocol.ts';
import { newSessionId } from '../shared/protocol.ts';
import { Session, clampCols, clampRows } from './session.ts';

export interface CreateOptions {
  name?: string;
  cwd?: string;
  argv?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export class RegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A pre-spawned shell, parked outside the session table until claimed. */
interface WarmShell {
  session: Session;
  bornAt: number;
}

export class Registry {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(evt: Event) => void>();
  private readonly events: Event[] = [];
  private dispatching = false;
  private procTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private poolFill: NodeJS.Immediate | null = null;
  private running = false;
  /**
   * Shells spawned ahead of demand so "New terminal" can hand one over
   * instead of paying for `spawn` + shell rc startup on every click. Not in
   * `sessions`, not broadcast, not visible to any client until `create()`
   * claims one — as far as the rest of ptyd is concerned these do not exist
   * yet.
   */
  private readonly warmPool: WarmShell[] = [];

  constructor(private readonly cfg: Config) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // A previous ptyd's sessions died with it. Start from a clean file rather
    // than resurrecting metadata for shells that no longer exist.
    this.persistNow();
    this.procTimer = setInterval(() => {
      this.pollForeground();
      this.sweepPool();
    }, this.cfg.procPollMs);
    this.fillPool();
  }

  stop(): void {
    this.running = false;
    if (this.procTimer) clearInterval(this.procTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.poolFill) clearImmediate(this.poolFill);
    this.procTimer = null;
    this.persistTimer = null;
    this.poolFill = null;
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const warm of this.warmPool.splice(0)) warm.session.dispose();
    this.persistNow();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onEvent(listener: (evt: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(evt: Event): void {
    this.events.push(evt);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      // Closing a slow connection can detach a viewer and emit another size
      // event. Finish the current fanout before delivering that newer event,
      // so every client observes the same order and ends on the current state.
      while (this.events.length > 0) {
        const next = this.events.shift()!;
        for (const listener of [...this.listeners]) {
          try {
            listener(next);
          } catch (err) {
            process.stderr.write(`[ptyd] event listener failed: ${String(err)}\n`);
          }
        }
        if (next.ev !== 'proc' && next.ev !== 'ready') this.persistSoon();
      }
    } finally {
      this.dispatching = false;
    }
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new RegistryError('no_such_session', `no session ${id}`);
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  metas(): SessionMeta[] {
    return this.list().map((s) => s.meta);
  }

  get size(): number {
    return this.sessions.size;
  }

  get aliveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.alive) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Create / destroy
  // -------------------------------------------------------------------------

  create(opts: CreateOptions = {}): Session {
    // A pooled shell was spawned with the default shell, home directory and
    // plain environment, so only a request asking for exactly that can claim
    // one — anything more specific (a custom command, cwd or env) still pays
    // for a fresh spawn.
    const poolable = this.cfg.warmPoolEnabled && !opts.argv && !opts.cwd && !opts.env;
    if (poolable) {
      this.discardUnusableWarm();
      if (this.warmPool.length > 0) return this.claimWarm(opts);
      this.fillPool();
    }

    const id = this.freshId();
    const cwd = this.resolveCwd(opts.cwd);

    let file: string;
    let args: string[];
    if (opts.argv && opts.argv.length > 0) {
      file = opts.argv[0]!;
      args = opts.argv.slice(1);
    } else {
      const shell = resolveShell(this.cfg);
      file = shell.file;
      args = shell.args;
    }

    const session = new Session({
      id,
      name: opts.name?.trim() || this.defaultName(),
      cwd,
      file,
      args,
      env: this.buildEnv(opts.env),
      cols: clampCols(opts.cols ?? this.cfg.defaultCols),
      rows: clampRows(opts.rows ?? this.cfg.defaultRows),
      scrollback: this.cfg.scrollback,
      snapshotScrollback: this.cfg.snapshotScrollback,
      rawBufferBytes: this.cfg.rawBufferBytes,
      reviveScreen: this.cfg.reviveScreen,
      resizePolicy: this.cfg.resizePolicy,
    });

    session.setEmitter((evt) => this.broadcast(evt));
    this.sessions.set(id, session);
    session.refreshProc();
    this.broadcast({ t: 'evt', ev: 'created', session: session.meta });
    return session;
  }

  private claimWarm(opts: CreateOptions): Session {
    const { session } = this.warmPool.shift()!;
    session.markCreated();
    if (opts.name?.trim()) session.rename(opts.name.trim());
    session.declareSize(
      null,
      clampCols(opts.cols ?? this.cfg.defaultCols),
      clampRows(opts.rows ?? this.cfg.defaultRows),
    );
    session.setEmitter((evt) => this.broadcast(evt));
    this.sessions.set(session.id, session);
    session.refreshProc();
    this.broadcast({ t: 'evt', ev: 'created', session: session.meta });
    // Top up in the background; the caller already has its session.
    this.fillPool();
    return session;
  }

  /** Dispose the session and drop it from the table. */
  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.dispose();
    this.sessions.delete(id);
    this.broadcast({ t: 'evt', ev: 'removed', id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private freshId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = newSessionId((n) => crypto.randomBytes(n));
      if (!this.sessions.has(id) && !this.warmPool.some((w) => w.session.id === id)) return id;
    }
    throw new RegistryError('id_exhausted', 'could not allocate a session id');
  }

  private defaultName(): string {
    return 'New term';
  }

  private spawnWarm(): Session {
    const shell = resolveShell(this.cfg);
    return new Session({
      id: this.freshId(),
      name: this.defaultName(),
      cwd: this.resolveCwd(undefined),
      file: shell.file,
      args: shell.args,
      env: this.buildEnv(undefined),
      cols: clampCols(this.cfg.defaultCols),
      rows: clampRows(this.cfg.defaultRows),
      scrollback: this.cfg.scrollback,
      snapshotScrollback: this.cfg.snapshotScrollback,
      rawBufferBytes: this.cfg.rawBufferBytes,
      reviveScreen: this.cfg.reviveScreen,
      resizePolicy: this.cfg.resizePolicy,
    });
  }

  private fillPool(): void {
    if (!this.running || !this.cfg.warmPoolEnabled || this.poolFill) return;
    const target = Number.isFinite(this.cfg.warmPoolSize)
      ? Math.min(32, Math.max(0, Math.floor(this.cfg.warmPoolSize)))
      : 0;
    if (this.warmPool.length >= target) return;
    // Spawn at most one shell per event-loop turn, after the request's reply
    // has been queued. A refill failure must not fail an already-created session.
    this.poolFill = setImmediate(() => {
      this.poolFill = null;
      if (!this.running) return;
      try {
        this.warmPool.push({ session: this.spawnWarm(), bornAt: Date.now() });
      } catch (err) {
        process.stderr.write(`[ptyd] could not prewarm shell: ${String(err)}\n`);
        // The next regular sweep retries, avoiding a tight failure loop.
        return;
      }
      this.fillPool();
    });
    this.poolFill.unref?.();
  }

  /** Never hand out an exited shell, or one with an excessively old environment. */
  private discardUnusableWarm(): void {
    const cutoff = Date.now() - this.cfg.warmPoolMaxIdleMs;
    for (let i = this.warmPool.length - 1; i >= 0; i--) {
      const warm = this.warmPool[i]!;
      if (warm.session.alive && warm.bornAt >= cutoff) continue;
      this.warmPool.splice(i, 1);
      warm.session.dispose();
    }
  }

  private sweepPool(): void {
    this.discardUnusableWarm();
    this.fillPool();
  }

  private resolveCwd(requested?: string): string {
    const home = os.homedir();
    if (!requested) return home;
    try {
      if (fs.statSync(requested).isDirectory()) return requested;
    } catch {
      // Fall through to home.
    }
    return home;
  }

  /**
   * The child's environment is ptyd's own plus the two terminal hints, and
   * nothing else. No plugin bootstrapping, no agent-specific variables.
   */
  private buildEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string') env[key] = value;
      }
    }
    return env;
  }

  private pollForeground(): void {
    for (const session of this.sessions.values()) {
      if (!session.alive) continue;
      if (session.refreshProc()) {
        this.broadcast({
          t: 'evt',
          ev: 'proc',
          id: session.id,
          fgProc: session.fgProc,
        });
      }
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    try {
      writeJson(paths.sessions, {
        ptydPid: process.pid,
        updatedAt: Date.now(),
        sessions: this.metas(),
      });
    } catch (err) {
      process.stderr.write(`[ptyd] could not persist session list: ${String(err)}\n`);
    }
  }
}
