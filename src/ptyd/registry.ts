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

export class Registry {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(evt: Event) => void>();
  private procTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: Config) {}

  start(): void {
    // A previous ptyd's sessions died with it. Start from a clean file rather
    // than resurrecting metadata for shells that no longer exist.
    this.persistNow();
    this.procTimer = setInterval(() => this.pollForeground(), this.cfg.procPollMs);
  }

  stop(): void {
    if (this.procTimer) clearInterval(this.procTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.procTimer = null;
    this.persistTimer = null;
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
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
    for (const listener of this.listeners) listener(evt);
    if (evt.ev !== 'proc' && evt.ev !== 'ready') this.persistSoon();
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
      if (!this.sessions.has(id)) return id;
    }
    throw new RegistryError('id_exhausted', 'could not allocate a session id');
  }

  private defaultName(): string {
    return 'New term';
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
