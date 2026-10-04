/**
 * Real PTYs and real IPC, isolated from the running daemon. Abstract Unix
 * sockets leave no socket file; the temporary state directory is retained.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { spawn as spawnPty } from 'node-pty';
import { WebSocket } from 'ws';
import type { Config } from '../src/shared/config.ts';
import type { Registry as RegistryType } from '../src/ptyd/registry.ts';
import type { Session, Subscriber } from '../src/ptyd/session.ts';
import { PtydClient, PtydError } from '../src/shared/ptyd-client.ts';
import { encodeJson, type Event } from '../src/shared/protocol.ts';

// Set these before importing modules that resolve their XDG paths.
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhub-ptyd-recovery-'));
process.env.XDG_CONFIG_HOME = path.join(workdir, 'config');
process.env.XDG_STATE_HOME = path.join(workdir, 'state');
process.env.XDG_RUNTIME_DIR = path.join(workdir, 'run');
const { Registry } = await import('../src/ptyd/registry.ts');
const { startIpcServer } = await import('../src/ptyd/ipc-server.ts');
const { defaultConfig, paths, writeJson } = await import('../src/shared/config.ts');
process.stdout.write(`isolated ptyd state: ${workdir}\n`);
// Only Linux provides abstract Unix sockets. Keep the file-free IPC cases
// skipped on other platforms; the real-PTY cases remain independently usable.
const ipcTest = process.platform === 'linux' ? test : test.skip;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ptyd test condition');
    await delay(5);
  }
}

function config(extra: Partial<Config> = {}): Config {
  return {
    ...defaultConfig, shell: '/bin/sh', shellArgs: [],
    scrollback: 200, snapshotScrollback: 100, procPollMs: 60_000,
    warmPoolSize: 1, ...extra,
  };
}

function registry(t: TestContext, cfg = config()): RegistryType {
  const reg = new Registry(cfg);
  reg.start();
  t.after(() => reg.stop());
  return reg;
}

function warmPool(reg: RegistryType): { session: Session; bornAt: number }[] {
  return Reflect.get(reg, 'warmPool');
}

let key = 1;
function viewer(session: Session, cols?: number, rows?: number) {
  const output: Buffer[] = [];
  const events: Event[] = [];
  const sub: Subscriber = {
    key: key++, sendOut: (_id, data) => output.push(data), sendEvent: (evt) => events.push(evt),
  };
  session.attach(sub, cols, rows);
  return { sub, output, events, text: () => Buffer.concat(output).toString() };
}

function nodeSession(reg: RegistryType, code: string): Session {
  return reg.create({ argv: [process.execPath, '-e', code], cols: 80, rows: 24 });
}

async function gateway(t: TestContext) {
  const cfg = config({ warmPoolEnabled: false });
  const reg = new Registry(cfg);
  reg.start();
  const accepted: net.Socket[] = [];
  const originalCreate = net.createServer;
  t.mock.method(net, 'createServer', ((listener: (socket: net.Socket) => void) =>
    originalCreate((socket) => { accepted.push(socket); listener(socket); })) as typeof net.createServer);
  const socket = `\0ptyhub-recovery-${process.pid}-${key++}`;
  const logs: string[] = [];
  const server = await startIpcServer(reg, socket, cfg, (msg) => logs.push(msg));
  const clients: PtydClient[] = [];
  const rawSockets: net.Socket[] = [];
  const connect = async (handlers = {}) => {
    const client = await PtydClient.connect(socket, handlers);
    clients.push(client);
    return client;
  };
  const raw = async () => {
    const client = net.connect(socket);
    client.on('error', () => {});
    // Backlog tests override the server-side queue. Read here so a remote
    // close remains observable even after earlier metadata notifications.
    client.resume();
    rawSockets.push(client);
    await once(client, 'connect');
    await until(() => accepted.length === clients.length + rawSockets.length);
    return { client, peer: accepted.at(-1)! };
  };
  t.after(async () => {
    for (const client of clients) client.close();
    for (const socket of rawSockets) socket.destroy();
    await server.close();
    reg.stop();
  });
  return { cfg, reg, server, socket, logs, accepted, clients, connect, raw };
}

test('claiming a warm shell applies requested geometry and creation time without a synchronous refill', async (t) => {
  const reg = registry(t);
  await until(() => warmPool(reg).length === 1);
  const parked = warmPool(reg)[0]!.session;
  const spawnedAt = parked.createdAt;
  await delay(10);
  const refill = t.mock.method(reg as any, 'spawnWarm');
  const beforeClaim = Date.now();
  const claimed = reg.create({ name: 'claimed', cols: 97, rows: 33 });
  assert.equal(claimed.pid, parked.pid);
  assert.equal(claimed.name, 'claimed');
  assert.deepEqual([claimed.cols, claimed.rows], [97, 33]);
  assert.ok(claimed.createdAt >= beforeClaim && claimed.createdAt > spawnedAt);
  assert.equal(refill.mock.callCount(), 0);
  await until(() => warmPool(reg).length === 1);
  assert.equal(refill.mock.callCount(), 1);
  const v = viewer(claimed);
  claimed.write(v.sub, Buffer.from('stty size\n'));
  await until(() => /33\s+97/.test(v.text()));
});

test('an exited warm shell is discarded before a request can claim it', async (t) => {
  const reg = registry(t);
  await until(() => warmPool(reg).length === 1);
  const dead = warmPool(reg)[0]!.session;
  dead.kill('SIGKILL');
  await until(() => !dead.alive);
  const created = reg.create();
  assert.notEqual(created.id, dead.id);
  assert.equal(created.alive, true);
  assert.equal(reg.get(dead.id), undefined);
  await until(() => warmPool(reg).length === 1);
  assert.notEqual(warmPool(reg)[0]!.session.id, dead.id);
});

test('an expired warm shell is rejected even before the next background sweep', async (t) => {
  const reg = registry(t, config({ warmPoolMaxIdleMs: 30 }));
  await until(() => warmPool(reg).length === 1);
  const old = warmPool(reg)[0]!.session;
  await delay(40);
  const fresh = reg.create();
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.alive, true);
  await until(() => !old.alive);
});

test('the regular sweep replaces shells that have exited while parked', async (t) => {
  const reg = registry(t, config({ procPollMs: 30 }));
  await until(() => warmPool(reg).length === 1);
  const old = warmPool(reg)[0]!.session;
  old.kill('SIGKILL');
  await until(() => !old.alive);
  await until(() => warmPool(reg).length === 1 && warmPool(reg)[0]!.session.id !== old.id);
  assert.equal(warmPool(reg)[0]!.session.alive, true);
});

test('a failed refill leaves the already-claimed session usable', async (t) => {
  const cfg = config();
  const reg = registry(t, cfg);
  await until(() => warmPool(reg).length === 1);
  const warnings: string[] = [];
  t.mock.method(process.stderr, 'write', ((message: string) => { warnings.push(String(message)); return true; }) as any);
  t.mock.method(reg as any, 'spawnWarm', () => { throw new Error('simulated prewarm resource failure'); });
  const session = reg.create();
  assert.equal(session.alive, true);
  await until(() => warnings.some((line) => line.includes('could not prewarm shell')));
  const v = viewer(session);
  session.write(v.sub, Buffer.from('printf "REFILL_OK\\n"\n'));
  await until(() => v.text().includes('REFILL_OK'));
  assert.equal(reg.require(session.id), session);
  assert.equal(warmPool(reg).length, 0);
});

test('stopping the registry cancels pending warm-shell work', async (t) => {
  const reg = new Registry(config());
  const spawn = t.mock.method(reg as any, 'spawnWarm');
  reg.start();
  reg.stop();
  await delay(20);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(warmPool(reg).length, 0);
});

test('a non-finite pool size does not schedule unbounded shell creation', async (t) => {
  const reg = registry(t, config({ warmPoolSize: Infinity }));
  await delay(20);
  assert.equal(warmPool(reg).length, 0);
  assert.equal(reg.create().alive, true);
});

test('input split between frames preserves UTF-8 and raw bytes through a real PTY', async (t) => {
  const reg = registry(t, config({ warmPoolEnabled: false }));
  const input = Buffer.concat([Buffer.from('中文🙂'), Buffer.from([0, 255, 128, 4])]);
  const session = nodeSession(reg, `
    process.stdin.setRawMode(true);
    let received = Buffer.alloc(0);
    process.stdin.on('data', (data) => {
      received = Buffer.concat([received, data]);
      if (received.length >= ${input.length}) process.stdout.write('HEX:' + received.toString('hex') + '\\n');
    });
    process.stdout.write('INPUT_READY\\n');
  `);
  const v = viewer(session);
  await until(() => v.text().includes('INPUT_READY'));
  for (const byte of input) {
    session.write(v.sub, Buffer.from([byte]));
    await delay(2);
  }
  await until(() => v.text().includes(`HEX:${input.toString('hex')}`));
});

test('latest activity wins resizing even when timestamps tie or go backwards', async (t) => {
  const reg = registry(t, config({ warmPoolEnabled: false }));
  const session = reg.create({ argv: ['/bin/sh'], cols: 120, rows: 30 });
  const now = t.mock.method(Date, 'now', () => 1000);
  const a = viewer(session, 80, 24);
  const b = viewer(session, 110, 40);
  assert.deepEqual([session.cols, session.rows], [110, 40]);
  session.write(a.sub, Buffer.alloc(0));
  assert.equal(session.cols, 110);
  now.mock.mockImplementation(() => 500);
  session.write(a.sub, Buffer.from('x'));
  assert.deepEqual([session.cols, session.rows], [80, 24]);
  const observer = viewer(session);
  session.write(observer.sub, Buffer.from('y'));
  assert.equal(session.cols, 80);
  session.declareSize(b.sub, 95, 28);
  assert.deepEqual([session.cols, session.rows], [95, 28]);
  session.detach(b.sub);
  assert.deepEqual([session.cols, session.rows], [80, 24]);
});

test('minimum-size policy still takes the smallest declared geometry', (t) => {
  const reg = registry(t, config({ warmPoolEnabled: false, resizePolicy: 'min' }));
  const session = reg.create({ argv: ['/bin/sh'] });
  viewer(session, 80, 40);
  const b = viewer(session, 110, 24);
  session.write(b.sub, Buffer.from('x'));
  assert.deepEqual([session.cols, session.rows], [80, 24]);
});

test('a stalled headless parser bounds PTY reads and resumes without losing output', async (t) => {
  const reg = registry(t, config({ warmPoolEnabled: false }));
  const bytes = 4 * 1024 * 1024;
  const session = nodeSession(reg, `
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      process.stdout.write(Buffer.alloc(${bytes}, 122));
      process.stdout.write('\\nBURST_DONE\\n');
    });
    process.stdout.write('BURST_READY\\n');
  `);
  const v = viewer(session);
  await until(() => v.text().includes('BURST_READY') && Reflect.get(session, 'pendingBytes') === 0);
  v.output.length = 0;
  const term = Reflect.get(session, 'term');
  const pty = Reflect.get(session, 'pty');
  const writes: [string, () => void][] = [];
  const originalWrite = term.write.bind(term);
  const blocked = t.mock.method(term, 'write', (chunk: string, done: () => void) => writes.push([chunk, done]));
  const pause = t.mock.method(pty, 'pause');
  const resume = t.mock.method(pty, 'resume');
  session.write(v.sub, Buffer.from('go'));
  await until(() => pause.mock.callCount() > 0);
  const pending = Reflect.get(session, 'pendingBytes');
  assert.ok(pending >= 256 * 1024 && pending <= 384 * 1024, `unexpected parser backlog: ${pending}`);
  const queued = Buffer.concat(v.output);
  assert.ok(session.snapshot().subarray(-queued.length).equals(queued));
  await delay(20);
  assert.equal(Reflect.get(session, 'pendingBytes'), pending);
  blocked.mock.restore();
  for (const [chunk, done] of writes) originalWrite(chunk, done);
  await until(() => v.text().includes('BURST_DONE'), 20_000);
  await until(() => Reflect.get(session, 'pendingBytes') === 0, 20_000);
  assert.ok(resume.mock.callCount() > 0);
  assert.equal(Buffer.concat(v.output).filter((byte) => byte === 122).length, bytes);
  assert.ok(session.snapshot().toString().includes('BURST_DONE'));
});

test('a large burst followed immediately by exit preserves the final output', async (t) => {
  const reg = registry(t, config({ warmPoolEnabled: false }));
  const bytes = 2 * 1024 * 1024;
  const session = nodeSession(reg, `
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      process.stdout.write(Buffer.alloc(${bytes}, 122));
      process.stdout.write('\\nEXIT_TAIL\\n', () => process.exit(7));
    });
    process.stdout.write('EXIT_READY\\n');
  `);
  const v = viewer(session);
  await until(() => v.text().includes('EXIT_READY'));
  v.output.length = 0;
  session.write(v.sub, Buffer.from('go'));
  await until(() => !session.alive, 20_000);
  await until(() => Reflect.get(session, 'pendingBytes') === 0, 20_000);
  assert.equal(session.exitCode, 7);
  assert.equal(Buffer.concat(v.output).filter((byte) => byte === 122).length, bytes);
  assert.ok(v.text().includes('EXIT_TAIL'));
  assert.ok(session.snapshot().toString().includes('EXIT_TAIL'));
});

test('disposing a paused session prevents delayed parser callbacks from resuming its PTY', async (t) => {
  const reg = registry(t, config({ warmPoolEnabled: false }));
  const session = nodeSession(reg, `
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => process.stdout.write(Buffer.alloc(1024 * 1024, 122)));
    process.stdout.write('DISPOSE_READY\\n');
  `);
  const v = viewer(session);
  await until(() => v.text().includes('DISPOSE_READY') && Reflect.get(session, 'pendingBytes') === 0);
  const callbacks: (() => void)[] = [];
  t.mock.method(Reflect.get(session, 'term'), 'write', (_chunk: string, done: () => void) => callbacks.push(done));
  const resume = t.mock.method(Reflect.get(session, 'pty'), 'resume');
  session.write(v.sub, Buffer.from('go'));
  await until(() => Reflect.get(session, 'outputPaused'));
  session.dispose();
  const resumeCount = resume.mock.callCount();
  for (const callback of callbacks) callback();
  assert.equal(resume.mock.callCount(), resumeCount);
  assert.equal(Reflect.get(session, 'pendingBytes'), 0);
  assert.equal(session.subscriberCount, 0);
  await until(() => !session.alive);
});

ipcTest('IPC rejects invalid operation fields without changing sessions or locks', async (t) => {
  const f = await gateway(t);
  const client = await f.connect();
  const bad = (err: unknown) => err instanceof PtydError && err.code === 'bad_request';
  for (const options of [{ name: 1 }, { argv: 'sh' }, { argv: [] }, { cols: null }, { env: [] }, { env: { BAD: 1 } }]) {
    await assert.rejects(client.create(options as any), bad);
  }
  assert.equal((await client.list()).length, 0);
  const session = await client.create({ argv: ['/bin/sh'], name: 'valid' });
  await client.setLock(session.id, true);
  await assert.rejects(client.setLock(session.id, 1 as any), bad);
  await assert.rejects(client.rename(session.id, 1 as any), bad);
  await assert.rejects(client.kill(session.id, 'INVALID_SIGNAL', true), bad);
  await assert.rejects(client.resize(session.id, '80' as any, 24), bad);
  await assert.rejects(client.subscribe(session.id, { snapshot: 'false' as any }), bad);
  const retained = await client.get(session.id);
  assert.equal(retained.name, 'valid');
  assert.equal(retained.locked, true);
  assert.equal(retained.alive, true);
  assert.equal(retained.viewers, 0);
});

ipcTest('malformed IPC JSON envelopes close only the offending connection', async (t) => {
  const f = await gateway(t);
  const healthy = await f.connect();
  for (const envelope of [null, [], 'request', { t: 'req', rid: '1', op: 'list' }, { t: 'req', rid: 1.5, op: 'list' }]) {
    const { client } = await f.raw();
    const closed = once(client, 'close');
    client.write(encodeJson(envelope as any));
    await closed;
    assert.deepEqual(await healthy.list(), []);
  }
  await until(() => f.server.connectionCount() === 1);
});

ipcTest('control messages enforce the same slow-client limit as terminal output', async (t) => {
  const f = await gateway(t);
  const healthy = await f.connect();
  const slow = await f.connect();
  await until(() => f.accepted.length === 2);
  Object.defineProperty(f.accepted[1]!, 'writableLength', { get: () => 9 * 1024 * 1024 });
  await assert.rejects(slow.stats());
  await until(() => f.server.connectionCount() === 1);
  assert.ok(f.logs.some((line) => line.includes('not draining')));
  assert.equal((await healthy.stats()).subscribers, 1);
});

ipcTest('closing during subscribe leaves no viewer and ignores subsequent frames in the same batch', async (t) => {
  const f = await gateway(t);
  const healthy = await f.connect();
  const session = await healthy.create({ argv: ['/bin/sh'] });
  const { client, peer } = await f.raw();
  Object.defineProperty(peer, 'writableLength', { get: () => 9 * 1024 * 1024 });
  const closed = once(client, 'close');
  client.write(Buffer.concat([
    encodeJson({ t: 'req', rid: 1, op: 'subscribe', id: session.id, snapshot: false, cols: 88, rows: 28 }),
    encodeJson({ t: 'req', rid: 2, op: 'kill', id: session.id, force: true }),
  ]));
  await closed;
  const retained = await healthy.get(session.id);
  assert.equal(retained.viewers, 0);
  assert.equal(retained.alive, true);
  assert.equal(f.reg.require(session.id).subscriberCount, 0);
});

ipcTest('detaching a slow viewer preserves size-event order for other clients', async (t) => {
  const f = await gateway(t);
  const { client, peer } = await f.raw();
  const events: Event[] = [];
  const healthy = await f.connect({ onEvent: (evt: Event) => events.push(evt) });
  const session = await healthy.create({ argv: ['/bin/sh'] });
  await healthy.subscribe(session.id, { cols: 80, rows: 24, snapshot: false });
  await until(() => events.some((evt) => evt.ev === 'ready'));
  events.length = 0;
  Object.defineProperty(peer, 'writableLength', { get: () => 9 * 1024 * 1024 });
  const closed = once(client, 'close');
  client.write(encodeJson({ t: 'req', rid: 1, op: 'subscribe', id: session.id, cols: 110, rows: 40, snapshot: false }));
  await closed;
  await until(() => events.filter((evt) => evt.ev === 'resized').length === 2);
  assert.deepEqual(events.filter((evt) => evt.ev === 'resized').map((evt) => [evt.cols, evt.rows]), [[110, 40], [80, 24]]);
  const retained = await healthy.get(session.id);
  assert.deepEqual([retained.cols, retained.rows, retained.viewers], [80, 24, 1]);
});

ipcTest('separate IPC servers have independent connection counts and shutdown', async (t) => {
  const f = await gateway(t);
  const first = await f.connect();
  const otherReg = new Registry(f.cfg);
  otherReg.start();
  const socket = `\0ptyhub-recovery-other-${process.pid}-${key++}`;
  const otherServer = await startIpcServer(otherReg, socket, f.cfg, () => {});
  const second = await PtydClient.connect(socket);
  t.after(async () => { second.close(); await otherServer.close(); otherReg.stop(); });
  assert.equal((await first.stats()).subscribers, 1);
  assert.equal((await second.stats()).subscribers, 1);
  await f.server.close();
  assert.equal((await second.stats()).subscribers, 1);
});

ipcTest('real IPC reconnect restores the screen while retaining the same shell', async (t) => {
  const f = await gateway(t);
  const control = await f.connect();
  const session = await control.create({ argv: ['/bin/sh'], name: 'persistent' });
  const output: string[] = [];
  const first = await f.connect({ onOutput: (_id: string, data: Buffer) => output.push(data.toString()) });
  await first.subscribe(session.id, { cols: 91, rows: 29 });
  first.sendInput(session.id, 'printf "RECONNECT_MARK\\n"; stty size\n');
  await until(() => output.join('').includes('RECONNECT_MARK') && /29\s+91/.test(output.join('')));
  first.close();
  await until(async () => (await control.get(session.id)).viewers === 0);
  const restored: string[] = [];
  const events: Event[] = [];
  const second = await f.connect({
    onOutput: (_id: string, data: Buffer) => restored.push(data.toString()),
    onEvent: (evt: Event) => events.push(evt),
  });
  await second.subscribe(session.id, { cols: 91, rows: 29 });
  await until(() => events.some((evt) => evt.ev === 'ready'));
  assert.ok(restored.join('').includes('RECONNECT_MARK'));
  assert.equal((await control.get(session.id)).pid, session.pid);
  await control.setLock(session.id, true);
  await assert.rejects(control.kill(session.id), (err: unknown) => err instanceof PtydError && err.code === 'session_locked');
  await control.kill(session.id, 'SIGKILL', true);
  assert.equal((await control.list()).length, 0);
  await until(() => f.reg.size === 0);
  assert.ok(paths.sessions.startsWith(workdir));
});

ipcTest('the real Web gateway and CLI can share and recover a session on the updated daemon', { timeout: 30_000 }, async (t) => {
  const f = await gateway(t);
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  writeJson(paths.config, { ...f.cfg, port, bind: '127.0.0.1', socketPath: f.socket, trustedNetwork: true });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/web/index.ts'], {
    cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data: Buffer) => { logs += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { logs += data.toString(); });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try {
      await until(() => child.exitCode !== null || child.signalCode !== null, 8000);
    } catch {
      child.kill('SIGKILL');
      assert.fail(`isolated Web gateway did not stop: ${logs}`);
    }
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`isolated Web gateway exited: ${logs}`);
    try {
      const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      return health.ok && (await health.json() as { ptyd?: string }).ptyd === 'connected';
    } catch { return false; }
  }, 15_000);
  const created = await fetch(`${origin}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ name: 'shared-test', argv: ['/bin/sh'], cols: 79, rows: 23 }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(created.status, 201);
  const { session } = await created.json() as { session: { id: string; pid: number } };
  const open = async () => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws/sessions/${session.id}`);
    const output: Buffer[] = [];
    const messages: { t: string }[] = [];
    sockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      if (binary) output.push(data as Buffer);
      else messages.push(JSON.parse(String(data)));
    });
    await once(ws, 'open');
    await until(() => messages.some((msg) => msg.t === 'ready'));
    return { ws, text: () => Buffer.concat(output).toString() };
  };
  const web = await open();
  web.ws.send(JSON.stringify({ t: 'resize', cols: 84, rows: 26 }));
  web.ws.send(Buffer.from('printf "WEB_PERSIST_MARK\\n"; stty size\n'));
  await until(() => web.text().includes('WEB_PERSIST_MARK') && /26\s+84/.test(web.text()));
  const closed = once(web.ws, 'close'); web.ws.close(); await closed;
  await until(() => f.reg.require(session.id).subscriberCount === 0);

  const cli = spawnPty(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'attach', session.id], {
    cwd: root, env: { ...process.env }, cols: 93, rows: 31,
  });
  let terminal = '';
  let cliExit: number | undefined;
  cli.onData((chunk) => { terminal += chunk; });
  cli.onExit(({ exitCode }) => { cliExit = exitCode; });
  t.after(() => { if (cliExit === undefined) cli.kill('SIGTERM'); });
  await until(() => terminal.includes('-- attached to'), 10_000);
  assert.ok(terminal.includes('WEB_PERSIST_MARK'));
  cli.write('printf "CLI_PERSIST_MARK\\n"; stty size\n');
  await until(() => terminal.includes('CLI_PERSIST_MARK') && /31\s+93/.test(terminal));
  cli.write('\x1cd');
  await until(() => cliExit !== undefined);
  assert.equal(cliExit, 0);
  assert.equal(f.reg.require(session.id).alive, true);
  assert.equal(f.reg.require(session.id).pid, session.pid);
  await until(() => f.reg.require(session.id).subscriberCount === 0);

  const restored = await open();
  assert.ok(restored.text().includes('WEB_PERSIST_MARK'));
  assert.ok(restored.text().includes('CLI_PERSIST_MARK'));
  assert.equal(f.reg.require(session.id).pid, session.pid);
  const rejected = await fetch(`${origin}/api/sessions/${session.id}?signal=INVALID_SIGNAL`, {
    method: 'DELETE', headers: { Origin: origin }, signal: AbortSignal.timeout(3000),
  });
  assert.equal(rejected.status, 400);
  assert.equal(f.reg.require(session.id).alive, true);
});
