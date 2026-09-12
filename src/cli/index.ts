/**
 * `ptyhub` — the local command line.
 *
 * Talks to ptyd over the same unix socket the web gateway uses, so the sessions
 * you see here are exactly the ones in the browser.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  loadConfig,
  isLoopback,
  paths,
  socketPath,
  stateDir,
} from '../shared/config.ts';
import type { SessionMeta } from '../shared/protocol.ts';
import { PtydClient, PtydError } from '../shared/ptyd-client.ts';
import { VERSION } from '../shared/version.ts';
import { Auth, hashPassword } from '../web/auth.ts';
import { attachSession } from './attach.ts';
import { runTui } from './tui.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = `ptyhub ${VERSION} — persistent terminal sessions

  ptyhub                    open the session picker
  ptyhub ls                 list sessions
  ptyhub new [name] [-- cmd…]
  ptyhub attach <id|name>
  ptyhub kill [--force] <id|name>
  ptyhub lock <id|name>     protect a session from being closed
  ptyhub unlock <id|name>
  ptyhub rename <id|name> <new name>
  ptyhub status             daemon and gateway health
  ptyhub passwd [user]      set the web password
  ptyhub link [--qr]        one-shot pairing link for a new device
  ptyhub install-service    set up and start the systemd --user units
  ptyhub fetch-font nerd    download the Nerd Font build for the web UI
`;

function fail(message: string): never {
  process.stderr.write(`ptyhub: ${message}\n`);
  process.exit(1);
}

async function connect(): Promise<PtydClient> {
  const cfg = loadConfig();
  const socket = socketPath(cfg);
  try {
    return await PtydClient.connect(socket);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      fail(
        `ptyd is not running (no socket at ${socket}).\n` +
          `  start it with:  systemctl --user start ptyhub-ptyd\n` +
          `  or set it up:   ptyhub install-service`,
      );
    }
    throw err;
  }
}

/** Accept a full id, an id prefix, or an exact session name. */
function resolveSession(sessions: SessionMeta[], needle: string): SessionMeta {
  const exactId = sessions.find((s) => s.id === needle);
  if (exactId) return exactId;

  const byName = sessions.filter((s) => s.name === needle);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) fail(`"${needle}" matches ${byName.length} sessions; use the id`);

  const prefixed = sessions.filter((s) => s.id.startsWith(needle));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) fail(`"${needle}" is ambiguous; use a longer id`);

  fail(`no session matches "${needle}"`);
}

function fmtAge(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(): Promise<void> {
  const client = await connect();
  const sessions = await client.list();
  client.close();

  if (sessions.length === 0) {
    process.stdout.write('no sessions. create one with `ptyhub new`.\n');
    return;
  }

  const width = Math.max(4, ...sessions.map((s) => s.name.length));
  for (const session of sessions) {
    const state = session.alive
      ? (session.fgProc || 'shell')
      : `exited ${session.exitCode ?? ''}`.trim();
    process.stdout.write(
      `${session.id} ${session.locked ? '🔒' : ' '} ${session.name.padEnd(width)}  ${state.padEnd(12)}  ` +
        `${String(session.cols).padStart(3)}×${String(session.rows).padEnd(3)}  ` +
        `${fmtAge(session.createdAt).padStart(4)}  ${session.cwd}\n`,
    );
  }
}

async function cmdNew(args: string[]): Promise<void> {
  const sep = args.indexOf('--');
  const argv = sep >= 0 ? args.slice(sep + 1) : undefined;
  const name = (sep >= 0 ? args.slice(0, sep) : args)[0];

  const client = await connect();
  const session = await client.create({
    name,
    argv,
    cwd: process.cwd(),
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  });

  if (process.stdin.isTTY) {
    await attachSession(client, session.id);
  } else {
    process.stdout.write(`${session.id}\n`);
  }
  client.close();
}

async function cmdAttach(args: string[]): Promise<void> {
  const needle = args[0];
  if (!needle) fail('attach needs a session id or name');

  const client = await connect();
  const session = resolveSession(await client.list(), needle);
  if (!session.alive) fail(`session ${session.name} has exited`);

  const result = await attachSession(client, session.id);
  client.close();
  if (result.reason === 'lost') fail('lost connection to ptyd');
  process.stdout.write(
    result.reason === 'detached'
      ? `detached from ${session.name}; it is still running\n`
      : `${session.name} exited\n`,
  );
}

async function cmdKill(args: string[]): Promise<void> {
  const force = args.includes('--force') || args.includes('-f');
  const rest = args.filter((a) => a !== '--force' && a !== '-f');
  if (!rest[0]) fail('kill needs a session id or name');

  const client = await connect();
  const session = resolveSession(await client.list(), rest[0]!);
  try {
    await client.kill(session.id, rest[1], force);
  } catch (err) {
    client.close();
    if (err instanceof PtydError && err.code === 'session_locked') {
      fail(
        `${session.name} is locked.\n` +
          `  unlock it:  ptyhub unlock ${session.id}\n` +
          `  or force:   ptyhub kill --force ${session.id}`,
      );
    }
    throw err;
  }
  client.close();
  process.stdout.write(`${session.name} (${session.id}) closed\n`);
}

async function cmdSetLock(args: string[], locked: boolean): Promise<void> {
  const verb = locked ? 'lock' : 'unlock';
  if (!args[0]) fail(`${verb} needs a session id or name`);
  const client = await connect();
  const session = resolveSession(await client.list(), args[0]);
  await client.setLock(session.id, locked);
  client.close();
  process.stdout.write(
    locked
      ? `${session.name} is locked; it cannot be closed until you unlock it\n`
      : `${session.name} is unlocked\n`,
  );
}

async function cmdRename(args: string[]): Promise<void> {
  if (args.length < 2) fail('rename needs a session and a new name');
  const client = await connect();
  const session = resolveSession(await client.list(), args[0]!);
  const renamed = await client.rename(session.id, args.slice(1).join(' '));
  client.close();
  process.stdout.write(`renamed to ${renamed.name}\n`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  let client: PtydClient | null = null;
  try {
    client = await PtydClient.connect(socketPath(cfg));
  } catch {
    process.stdout.write(`ptyd          not running (${socketPath(cfg)})\n`);
  }

  if (client) {
    const stats = await client.stats();
    client.close();
    // A ptyd older than the code on disk keeps running happily but will not
    // have newer features; restarting it is the one action that costs sessions,
    // so say so rather than letting the difference go unnoticed.
    const stale =
      stats.version !== VERSION
        ? `  ← code on disk is v${VERSION}; restart ptyd to pick it up (this ends all sessions)`
        : '';
    process.stdout.write(
      `ptyd          running v${stats.version}, pid ${stats.pid}, up ${fmtAge(stats.startedAt)}${stale}\n` +
        `sessions      ${stats.aliveSessions} alive / ${stats.sessions} total\n` +
        // Includes the gateway's control link and this very command, so it is
        // a connection count rather than a count of people watching.
        `connections   ${stats.subscribers} to ptyd\n`,
    );
  }

  const url = `http://${isLoopback(cfg.bind) ? '127.0.0.1' : cfg.bind}:${cfg.port}`;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { version?: string };
    process.stdout.write(`gateway       ${url} (v${body.version ?? '?'})\n`);
  } catch {
    process.stdout.write(`gateway       not responding on ${url}\n`);
  }

  const hasPassword = fs.existsSync(paths.auth);
  process.stdout.write(
    `auth          ${
      cfg.trustedNetwork
        ? 'DISABLED (trustedNetwork is on)'
        : hasPassword
          ? 'password set'
          : 'access token — run `ptyhub link` for the URL'
    }\n` + `bind          ${cfg.bind}${isLoopback(cfg.bind) ? ' (loopback)' : ' (exposed)'}\n`,
  );
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = output._writeToOutput.bind(rl);
    let muted = false;
    output._writeToOutput = (chunk: string) => {
      if (!muted) original(chunk);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function ask(prompt: string, fallback: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [${fallback}] `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback);
    });
  });
}

async function cmdPasswd(args: string[]): Promise<void> {
  if (!process.stdin.isTTY) fail('passwd needs a terminal');

  const user = args[0] ?? (await ask('user', os.userInfo().username));
  const password = await askHidden('password: ');
  if (password.length < 8) fail('use at least 8 characters');
  const again = await askHidden('again: ');
  if (password !== again) fail('the two passwords do not match');

  const { salt, hash } = hashPassword(password);
  ensureDir(path.dirname(paths.auth));
  fs.writeFileSync(
    paths.auth,
    `${JSON.stringify({ users: [{ name: user, salt, hash }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  // The standing token is only honoured while no password exists, so setting
  // one retires it. Devices already paired keep their own credentials.
  try {
    fs.unlinkSync(paths.token);
  } catch {
    // There may not have been one.
  }
  process.stdout.write(
    `password set for ${user}.\n` +
      `the access token is retired; already-authorised devices keep working.\n` +
      `run \`ptyhub link --qr\` to add a phone without typing the password.\n`,
  );
}

function guessHost(bind: string): string {
  if (!isLoopback(bind) && bind !== '0.0.0.0' && bind !== '::') return bind;
  if (bind === '0.0.0.0' || bind === '::') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  }
  return 'localhost';
}

async function cmdLink(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const hostArg = args.find((a) => a.startsWith('--host='))?.split('=')[1];
  const host = hostArg ?? guessHost(cfg.bind);

  if (cfg.trustedNetwork) {
    process.stdout.write(
      `trustedNetwork is on, so no credential is needed:\n\n  http://${host}:${cfg.port}/\n`,
    );
    return;
  }

  const auth = new Auth(cfg, () => {});
  let url: string;
  let note: string;

  if (auth.passwordConfigured) {
    const user = JSON.parse(fs.readFileSync(paths.auth, 'utf8')).users?.[0]?.name ?? 'ptyhub';
    const { key, expiresAt } = Auth.createPairing(user);
    url = `http://${host}:${cfg.port}/#k=${key}`;
    note = `valid for ${Math.round((expiresAt - Date.now()) / 60000)} minutes, single use.`;
  } else {
    // No password yet: the standing access token is how anyone gets in.
    url = auth.accessUrl(host, cfg.port)!;
    note = 'this is the standing access token; `ptyhub passwd` replaces it with a password.';
  }

  process.stdout.write(`\n${url}\n\n`);

  if (args.includes('--qr')) {
    const { default: QRCode } = await import('qrcode');
    process.stdout.write(`${await QRCode.toString(url, { type: 'terminal', small: true })}\n`);
  }

  process.stdout.write(`${note}\nopen it once on the device; after that it signs in on its own.\n`);
}

function unitFile(description: string, entry: string, restart: string, extra = ''): string {
  return `[Unit]
Description=${description}
${extra}
[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${process.execPath} --import tsx ${path.join(root, entry)}
Restart=${restart}
RestartSec=2
Environment=NODE_ENV=production
# The shells this starts are the user's own; no extra hardening that would
# stop them from doing what a login shell can normally do.
KillMode=mixed

[Install]
WantedBy=default.target
`;
}

async function cmdInstallService(): Promise<void> {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  ensureDir(unitDir, 0o755);

  const ptydUnit = path.join(unitDir, 'ptyhub-ptyd.service');
  const webUnit = path.join(unitDir, 'ptyhub-web.service');

  fs.writeFileSync(
    ptydUnit,
    unitFile('ptyhub PTY daemon (owns every session)', 'src/ptyd/index.ts', 'on-failure'),
  );
  // Wants rather than Requires: a ptyd restart must not take the gateway with
  // it, and the gateway is built to sit there retrying.
  fs.writeFileSync(
    webUnit,
    unitFile(
      'ptyhub web gateway',
      'src/web/index.ts',
      'always',
      'After=ptyhub-ptyd.service\nWants=ptyhub-ptyd.service\n',
    ),
  );

  process.stdout.write(`wrote ${ptydUnit}\nwrote ${webUnit}\n\nnow run:\n`);
  process.stdout.write(
    `  systemctl --user daemon-reload\n` +
      `  systemctl --user enable --now ptyhub-ptyd ptyhub-web\n` +
      `  loginctl enable-linger ${os.userInfo().username}   # survive logout and reboot\n`,
  );
}

const NERD_FONTS = [
  {
    file: 'JetBrainsMonoNerdFont-Regular.ttf',
    url: 'https://github.com/ryanoasis/nerd-fonts/raw/v3.2.1/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFont-Regular.ttf',
  },
  {
    file: 'JetBrainsMonoNerdFont-Bold.ttf',
    url: 'https://github.com/ryanoasis/nerd-fonts/raw/v3.2.1/patched-fonts/JetBrainsMono/Ligatures/Bold/JetBrainsMonoNerdFont-Bold.ttf',
  },
];

/**
 * Download a file, preferring curl.
 *
 * Node's `fetch` ignores http_proxy/https_proxy unless the process was started
 * with NODE_USE_ENV_PROXY, which is exactly the situation on a lot of managed
 * networks and clusters. curl honours the same variables the rest of the shell
 * does, so it is the more predictable tool here; `fetch` remains the fallback.
 */
async function download(url: string, target: string): Promise<void> {
  const viaCurl = await new Promise<boolean>((resolve) => {
    const curl = spawn(
      'curl',
      ['-fsSL', '--connect-timeout', '20', '--max-time', '300', '-o', target, url],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    curl.on('error', () => resolve(false));
    curl.on('close', (code) => resolve(code === 0));
  });
  if (viaCurl) return;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
}

async function cmdFetchFont(args: string[]): Promise<void> {
  if (args[0] !== 'nerd') fail('only `ptyhub fetch-font nerd` is supported');
  ensureDir(paths.fonts, 0o755);

  for (const font of NERD_FONTS) {
    const target = path.join(paths.fonts, font.file);
    process.stdout.write(`fetching ${font.file}… `);
    try {
      await download(font.url, target);
      const size = fs.statSync(target).size;
      if (size < 100_000) throw new Error(`suspiciously small (${size} bytes)`);
      process.stdout.write(`ok (${Math.round(size / 1024)} KB)\n`);
    } catch (err) {
      try {
        fs.unlinkSync(target);
      } catch {
        // Nothing to remove.
      }
      process.stdout.write(`failed (${String(err)})\n`);
      process.stderr.write(
        `\nif this machine needs a proxy, make sure https_proxy is set.\n` +
          `otherwise download the font from https://www.nerdfonts.com and drop\n` +
          `JetBrainsMonoNerdFont-Regular.ttf into ${paths.fonts}\n`,
      );
      process.exit(1);
    }
  }

  process.stdout.write(
    `\ninstalled into ${paths.fonts}\nturn on "Nerd Font glyphs" in Settings → Font.\n`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDir(stateDir);
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined: {
      const client = await connect();
      try {
        await runTui(client, os.homedir());
      } finally {
        client.close();
      }
      return;
    }
    case 'ls':
    case 'list':
      return cmdList();
    case 'new':
      return cmdNew(args);
    case 'attach':
      return cmdAttach(args);
    case 'kill':
      return cmdKill(args);
    case 'lock':
      return cmdSetLock(args, true);
    case 'unlock':
      return cmdSetLock(args, false);
    case 'rename':
      return cmdRename(args);
    case 'status':
      return cmdStatus();
    case 'passwd':
      return cmdPasswd(args);
    case 'link':
      return cmdLink(args);
    case 'install-service':
      return cmdInstallService();
    case 'fetch-font':
      return cmdFetchFont(args);
    case 'version':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`ptyhub: unknown command "${command}"\n\n${USAGE}`);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof PtydError) fail(err.message);
    fail(err?.stack ?? String(err));
  });
