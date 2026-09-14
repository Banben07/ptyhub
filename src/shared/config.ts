/**
 * Filesystem layout and server-side configuration.
 *
 * Everything lives under XDG directories so nothing is ever written inside the
 * project tree, and nothing outside ~/.config/ptyhub, ~/.local/state/ptyhub and
 * $XDG_RUNTIME_DIR/ptyhub is touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResizePolicy } from './protocol.ts';

export const APP = 'ptyhub';

function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v && path.isAbsolute(v) ? v : fallback;
}

const home = os.homedir();

export const configDir = path.join(xdg('XDG_CONFIG_HOME', path.join(home, '.config')), APP);
export const stateDir = path.join(
  xdg('XDG_STATE_HOME', path.join(home, '.local', 'state')),
  APP,
);
/**
 * Runtime dir holds the unix socket. $XDG_RUNTIME_DIR is tmpfs and cleared on
 * logout, which is exactly right for a socket; when it is missing (common on
 * cluster login nodes) fall back to the state dir.
 */
export const runtimeDir = process.env.XDG_RUNTIME_DIR
  ? path.join(process.env.XDG_RUNTIME_DIR, APP)
  : stateDir;

export const paths = {
  config: path.join(configDir, 'config.json'),
  auth: path.join(configDir, 'auth.json'),
  keymap: path.join(configDir, 'keymap.json'),
  prefs: path.join(configDir, 'prefs.json'),
  devices: path.join(stateDir, 'devices.json'),
  pairings: path.join(stateDir, 'pairings.json'),
  token: path.join(stateDir, 'token.json'),
  sessions: path.join(stateDir, 'sessions.json'),
  fonts: path.join(stateDir, 'fonts'),
  socket: path.join(runtimeDir, 'ptyd.sock'),
  ptydLog: path.join(stateDir, 'ptyd.log'),
  webLog: path.join(stateDir, 'web.log'),
} as const;

// ---------------------------------------------------------------------------

export interface Config {
  /** Listen address for the HTTP gateway. Non-loopback requires auth. */
  bind: string;
  port: number;
  /** Shell to spawn; null means $SHELL, then /bin/bash, then /bin/sh. */
  shell: string | null;
  /** Args for the shell. `-l` gives a login shell so profiles are sourced. */
  shellArgs: string[];
  /** Lines of scrollback kept by the headless terminal per session. */
  scrollback: number;
  /** Lines of scrollback included in the snapshot sent to a reconnecting client. */
  snapshotScrollback: number;
  /** Raw output ring buffer per session, bytes. Fallback for snapshot replay. */
  rawBufferBytes: number;
  /** Create a session automatically when the UI opens and none exist. */
  autoCreateFirstSession: boolean;
  /** How to reconcile window sizes across multiple attached clients. */
  resizePolicy: ResizePolicy;
  /** Maintain a headless terminal per session for exact screen restore. */
  reviveScreen: boolean;
  defaultCols: number;
  defaultRows: number;
  /** How often to re-read the foreground process of each session, ms. */
  procPollMs: number;
  /** Override the unix socket path. */
  socketPath: string | null;
  /**
   * Treat the network as already authenticated (e.g. Tailscale-only access).
   * Disables the login page. Off by default and never implied.
   */
  trustedNetwork: boolean;
  /** Extra origins allowed for WebSocket upgrades, e.g. a reverse proxy host. */
  allowedOrigins: string[];
  /** Keep this many default shells pre-spawned so "New terminal" is instant. */
  warmPoolSize: number;
  warmPoolEnabled: boolean;
  /** Respawn a pooled shell that has sat idle this long, so it never hands out a stale environment. */
  warmPoolMaxIdleMs: number;
}

export const defaultConfig: Config = {
  bind: '127.0.0.1',
  port: 7420,
  shell: null,
  shellArgs: ['-l'],
  scrollback: 10000,
  snapshotScrollback: 1000,
  rawBufferBytes: 256 * 1024,
  autoCreateFirstSession: true,
  resizePolicy: 'active',
  reviveScreen: true,
  defaultCols: 120,
  defaultRows: 30,
  procPollMs: 2000,
  socketPath: null,
  trustedNetwork: false,
  allowedOrigins: [],
  warmPoolSize: 4,
  warmPoolEnabled: true,
  warmPoolMaxIdleMs: 5 * 60 * 1000,
};

export function resolveShell(cfg: Config): { file: string; args: string[] } {
  const file =
    cfg.shell ??
    process.env.SHELL ??
    (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  return { file, args: [...cfg.shellArgs] };
}

export function socketPath(cfg: Config): string {
  return cfg.socketPath ?? paths.socket;
}

export function isLoopback(bind: string): boolean {
  return (
    bind === '127.0.0.1' ||
    bind === 'localhost' ||
    bind === '::1' ||
    bind.startsWith('127.')
  );
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(`[${APP}] ignoring unreadable ${file}: ${String(err)}\n`);
    }
    return fallback;
  }
}

/** Write via temp file + rename so a crash never leaves a truncated file. */
export function writeJson(file: string, value: unknown, mode = 0o600): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/** Shallow-merge stored config over defaults so new keys get sane values. */
export function loadConfig(): Config {
  const stored = readJson<Partial<Config>>(paths.config, {});
  return { ...defaultConfig, ...stored };
}

export function saveConfig(cfg: Config): void {
  writeJson(paths.config, cfg, 0o644);
}
