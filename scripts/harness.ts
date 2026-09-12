/** Shared helpers for the smoke tests. */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

let passed = 0;
let failed = 0;

export function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}\n`);
  }
}

export function summary(extra = ''): void {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    if (extra) process.stdout.write(`\n${extra}\n`);
    process.exitCode = 1;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until the predicate holds. Async predicates are awaited — returning the
 * promise itself would always be truthy, which silently turns every such wait
 * into no wait at all.
 */
export async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  process.stdout.write(`       (timed out waiting for ${label})\n`);
  return false;
}

export interface Sandbox {
  dir: string;
  env: NodeJS.ProcessEnv;
  configFile: string;
  socketFile: string;
  cleanup(): void;
}

/** Throwaway XDG directories so tests never touch the real configuration. */
export function makeSandbox(prefix: string): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ptyhub-${prefix}-`));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_RUNTIME_DIR: path.join(dir, 'run'),
    NODE_ENV: 'production',
  };
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME!, 'ptyhub'), { recursive: true });
  fs.mkdirSync(env.XDG_RUNTIME_DIR!, { recursive: true });
  return {
    dir,
    env,
    configFile: path.join(env.XDG_CONFIG_HOME!, 'ptyhub', 'config.json'),
    socketFile: path.join(env.XDG_RUNTIME_DIR!, 'ptyhub', 'ptyd.sock'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Proc {
  child: ChildProcess;
  logs(): string;
  stop(): void;
}

/**
 * Launch a daemon in-process under tsx, the same way the systemd units do, so
 * signals and the reported pid refer to the real process.
 */
export function launch(entry: string, env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  child.stderr?.on('data', (c: Buffer) => {
    buffer += c.toString();
  });
  child.stdout?.on('data', (c: Buffer) => {
    buffer += c.toString();
  });
  return {
    child,
    logs: () => buffer,
    stop: () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}

/** Run a script to completion under the given environment and return stdout. */
export function runScript(
  entry: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString();
    });
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${entry} exited ${code}: ${err}`)),
    );
  });
}

/** A fetch wrapper that keeps cookies, like a browser would. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(readonly origin: string) {}

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async request(
    method: string,
    pathname: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; text: string }> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (this.cookies.size > 0) {
      (init.headers as Record<string, string>).Cookie = this.cookieHeader;
    }
    if (body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.origin}${pathname}`, init);
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      if (eq > 0) {
        const name = pair!.slice(0, eq).trim();
        const value = pair!.slice(eq + 1).trim();
        if (value === '' || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON; callers that care look at `text`.
    }
    return { status: res.status, json, text };
  }

  get = (p: string, h?: Record<string, string>) => this.request('GET', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) =>
    this.request('POST', p, b, h);
  patch = (p: string, b?: unknown) => this.request('PATCH', p, b);
  del = (p: string) => this.request('DELETE', p, undefined);
}

export function freePort(): number {
  // High ephemeral-ish range, randomised to avoid clashing with a real run.
  return 39000 + Math.floor(Math.random() * 2000);
}
