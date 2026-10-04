/** Real HTTP/WebSocket transport with an isolated auth store and fake IPC.
 * Exercises races and revocation without touching user sessions or files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { Auth } from '../src/web/auth.ts';
import { attachWebSockets } from '../src/web/ws.ts';
import { defaultConfig, paths } from '../src/shared/config.ts';
import { PtydClient, type PtydClientHandlers } from '../src/shared/ptyd-client.ts';
import type { PtydControl } from '../src/web/ptyd-control.ts';
import type { SessionMeta } from '../src/shared/protocol.ts';

const session: SessionMeta = {
  id: 'abcdefghjkmn', name: 'test', cwd: '/tmp', argv: ['/bin/sh'],
  createdAt: 0, cols: 80, rows: 24, pid: 1, fgProc: 'sh', title: '',
  viewers: 1, locked: false, alive: true, exitCode: null, exitSignal: null, exitedAt: null,
};

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeClient(handlers: PtydClientHandlers = {}) {
  const inputs: string[] = [];
  let closeCalls = 0, getCalls = 0, subscriptions = 0;
  const client = {
    close() { closeCalls++; handlers.onClose?.(); },
    async get() { getCalls++; return session; },
    async subscribe() {
      subscriptions++;
      handlers.onEvent?.({ t: 'evt', ev: 'ready', id: session.id, cols: 80, rows: 24 });
      return session;
    },
    async resize() { return { cols: 80, rows: 24 }; },
    sendInput(_id: string, data: Buffer) { inputs.push(data.toString()); },
  };
  return { client, inputs, closeCalls: () => closeCalls, getCalls: () => getCalls, subscriptions: () => subscriptions };
}

async function setup(t: TestContext, connect?: (handlers: PtydClientHandlers, signal?: AbortSignal) => Promise<PtydClient>) {
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === paths.devices) return JSON.stringify({ devices: ['a', 'b'].map((id) => ({
      id, user: 'test', expiresAt: Date.now() + 60_000,
      confirmedAt: 1, persistent: true, prevHash: null, rotatedAt: 1,
    })) });
    return Reflect.apply(originalRead, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
  const auth = new Auth(defaultConfig, () => {});
  t.mock.method(auth as any, 'saveDevices', () => {});
  const clients: ReturnType<typeof fakeClient>[] = [];
  t.mock.method(PtydClient, 'connect', async (_path: string, handlers: PtydClientHandlers = {}, signal?: AbortSignal) => {
    if (connect) return connect(handlers, signal);
    const f = fakeClient(handlers);
    clients.push(f);
    return f.client as unknown as PtydClient;
  });
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  const control = {
    listCached: () => [session], currentStatus: 'connected',
    onEvent: () => () => {}, onStatus: () => () => {},
  } as unknown as PtydControl;
  const closeGateway = attachWebSockets(server, {
    cfg: defaultConfig, control, socketFile: '/unused', log: () => {},
    authenticate: (req) => {
      const id = req.headers.cookie?.replace('device=', '');
      if (id === 'trusted') return { user: 'trusted', deviceId: null };
      return id && auth.deviceActive(id) ? { user: 'test', deviceId: id } : null;
    },
    deviceActive: (id) => auth.deviceActive(id),
    onDeviceRevoked: (listener) => auth.onDeviceRevoked(listener),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  const open = async (pathname: string, device = 'a') => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}${pathname}`, { headers: { Cookie: `device=${device}` } });
    sockets.push(ws);
    const messages: any[] = [];
    ws.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(String(raw))); });
    ws.on('error', () => {});
    await once(ws, 'open');
    return { ws, messages };
  };
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    closeGateway();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { auth, clients, server, origin, open };
}

test('malformed WebSocket paths and Host headers return 400 and leave the gateway usable', async (t) => {
  const f = await setup(t);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const ws = new WebSocket(`${f.origin.replace('http', 'ws')}/ws/sessions/%ZZ`, { headers: { Cookie: 'device=a' } });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('malformed path upgraded')); });
    ws.on('unexpected-response', (req, res) => { res.resume(); req.destroy(); resolve(res.statusCode); });
  });
  assert.equal(status, 400);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.get(`${f.origin}/ws/events`, { headers: {
      Host: '[invalid', Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
    } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHost, 400);
  assert.equal((await fetch(f.origin)).status, 200);
  const live = await f.open('/ws/events');
  await until(() => live.messages.some((m) => m.t === 'snapshot'));
});

test('revoking one device immediately closes its terminal and event sockets only', async (t) => {
  const f = await setup(t);
  const events = await f.open('/ws/events');
  const terminal = await f.open(`/ws/sessions/${session.id}`);
  const other = await f.open('/ws/events', 'b');
  await until(() => terminal.messages.some((m) => m.t === 'ready'));
  f.auth.removeDevice('a');
  await until(() => events.ws.readyState === WebSocket.CLOSED && terminal.ws.readyState === WebSocket.CLOSED);
  assert.equal(f.clients[0]!.closeCalls(), 1);
  other.ws.send(JSON.stringify({ t: 'ping', ts: 1 }));
  await until(() => other.messages.some((m) => m.t === 'pong'));
});

test('revoke-all closes every device socket while trusted-network sockets remain authorised', async (t) => {
  const f = await setup(t);
  const a = await f.open('/ws/events', 'a');
  const b = await f.open('/ws/events', 'b');
  const trusted = await f.open('/ws/events', 'trusted');
  f.auth.revokeAll();
  await until(() => a.ws.readyState === WebSocket.CLOSED && b.ws.readyState === WebSocket.CLOSED);
  trusted.ws.send(JSON.stringify({ t: 'ping', ts: 1 }));
  await until(() => trusted.messages.some((m) => m.t === 'pong'));
});

test('expiry is enforced before another terminal input is forwarded', async (t) => {
  const f = await setup(t);
  const terminal = await f.open(`/ws/sessions/${session.id}`);
  await until(() => terminal.messages.some((m) => m.t === 'ready'));
  (f.auth as any).devices.devices.find((d: any) => d.id === 'a').expiresAt = Date.now() - 1;
  terminal.ws.send(Buffer.from('must not arrive'));
  await until(() => terminal.ws.readyState === WebSocket.CLOSED);
  assert.deepEqual(f.clients[0]!.inputs, []);
});

test('a browser closing during IPC connect never creates an orphan subscription', async (t) => {
  const pending = deferred<PtydClient>();
  const fake = fakeClient();
  let signal: AbortSignal | undefined;
  const f = await setup(t, (_handlers, abort) => { signal = abort; return pending.promise; });
  const terminal = await f.open(`/ws/sessions/${session.id}`);
  const closed = once(terminal.ws, 'close'); terminal.ws.close(); await closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, true);
  pending.resolve(fake.client as unknown as PtydClient);
  await until(() => fake.closeCalls() === 1);
  assert.equal(fake.getCalls(), 0);
  assert.equal(fake.subscriptions(), 0);
});

test('a browser closing during metadata lookup does not subsequently subscribe', async (t) => {
  const pending = deferred<SessionMeta>();
  const fake = fakeClient();
  let lookup = false;
  fake.client.get = async () => { lookup = true; return pending.promise; };
  const f = await setup(t, async () => fake.client as unknown as PtydClient);
  const terminal = await f.open(`/ws/sessions/${session.id}`);
  await until(() => lookup);
  const closed = once(terminal.ws, 'close'); terminal.ws.close(); await closed;
  await until(() => fake.closeCalls() === 1);
  pending.resolve(session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.subscriptions(), 0);
  assert.equal(fake.closeCalls(), 1);
});

test('the first input after ready is accepted even before subscribe resolves', async (t) => {
  const pending = deferred<SessionMeta>();
  let fake!: ReturnType<typeof fakeClient>;
  const f = await setup(t, async (handlers) => {
    fake = fakeClient(handlers);
    fake.client.subscribe = async () => {
      handlers.onEvent?.({ t: 'evt', ev: 'ready', id: session.id, cols: 80, rows: 24 });
      return pending.promise;
    };
    return fake.client as unknown as PtydClient;
  });
  const terminal = await f.open(`/ws/sessions/${session.id}`);
  await until(() => terminal.messages.some((m) => m.t === 'ready'));
  terminal.ws.send(Buffer.from('first input'));
  await until(() => fake.inputs.length === 1);
  const closed = once(terminal.ws, 'close'); terminal.ws.close(); await closed;
  await until(() => fake.closeCalls() === 1);
  pending.resolve(session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.inputs, ['first input']);
  assert.equal(fake.closeCalls(), 1);
});

test('an already cancelled IPC connect rejects without opening a connection', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(PtydClient.connect('/unused', {}, controller.signal), { name: 'AbortError' });
});
