/** Deterministic failure tests: no daemons, sockets on disk, or cleanup files. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ReconnectingSocket, type SocketState } from '../web/src/reconnecting-socket.ts';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  closed = false;
  throwOnSend = false;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(data: string | ArrayBuffer): void { this.onmessage?.({ data }); }
  send(data: string | Uint8Array): void {
    if (this.throwOnSend) throw new Error('network failure');
    this.sent.push(data);
  }
  // A broken network need not deliver onclose, even after close() is called.
  close(): void { this.closed = true; this.readyState = 2; }
  ping(): { t: string; ts: number } {
    return JSON.parse(this.sent.filter((v) => typeof v === 'string').at(-1) as string);
  }
  pong(): void { this.receive(JSON.stringify({ t: 'pong', ts: this.ping().ts })); }
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  t.mock.method(Math, 'random', () => 0.5);
  const events = new EventTarget();
  const network = { onLine: true };
  const restoreGlobals: (() => void)[] = [];
  for (const [key, value] of Object.entries({ window: events, navigator: network, WebSocket: FakeSocket })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    restoreGlobals.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  FakeSocket.instances = [];
  const states: SocketState[] = [];
  const messages: (string | ArrayBuffer)[] = [];
  const readyCallbacks: (() => boolean)[] = [];
  const latencies: (number | null)[] = [];
  const connection = new ReconnectingSocket({
    url: () => 'ws://localhost/ws/test',
    state: (state) => states.push(state),
    message: (data, ready) => { messages.push(data); readyCallbacks.push(ready); },
    latency: (ms) => latencies.push(ms),
  });
  t.after(() => {
    connection.stop();
    for (const restore of restoreGlobals) restore();
  });
  connection.start();
  const latest = () => FakeSocket.instances.at(-1)!;
  const ready = () => {
    latest().open();
    latest().receive('{"t":"snapshot"}');
    assert.equal(readyCallbacks.at(-1)!(), true);
    return latest();
  };
  return { connection, events, network, states, messages, readyCallbacks, latencies, latest, ready };
}

test('input waits for the snapshot to be applied, not merely the upgrade', (t) => {
  const f = setup(t);
  f.connection.start();
  f.latest().open();
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(f.states.at(-1), 'connecting');
  assert.equal(f.connection.send(new Uint8Array([13])), false);
  f.latest().receive('{"t":"ready"}');
  assert.equal(f.connection.send(new Uint8Array([13])), false);
  f.readyCallbacks[0]!();
  assert.equal(f.states.at(-1), 'open');
  assert.equal(f.connection.send(new Uint8Array([13])), true);
});

test('a silent OPEN socket is replaced without waiting for its close event', (t) => {
  const f = setup(t);
  const old = f.ready();
  const lateClose = old.onclose!;
  const lateMessage = old.onmessage!;
  const lateReady = f.readyCallbacks[0]!;
  t.mock.timers.tick(15_000);
  assert.equal(old.closed, true);
  assert.equal(f.states.at(-1), 'reconnecting');
  t.mock.timers.tick(300);
  const replacement = f.ready();
  lateClose();
  lateMessage({ data: '"stale output"' });
  assert.equal(lateReady(), false);
  assert.equal(replacement.closed, false);
  assert.equal(f.states.at(-1), 'open');
  assert.equal(f.messages.includes('"stale output"'), false);
});

test('a stuck upgrade times out and snapshot progress extends the sync deadline', (t) => {
  const f = setup(t);
  const old = f.latest();
  t.mock.timers.tick(15_000);
  assert.equal(old.closed, true);
  t.mock.timers.tick(300);
  const socket = f.latest();
  socket.open();
  t.mock.timers.tick(25_000);
  socket.receive(new Uint8Array([65]).buffer);
  t.mock.timers.tick(25_000);
  assert.equal(socket.closed, false);
  t.mock.timers.tick(5_000);
  assert.equal(socket.closed, true);
});

test('downstream output and mismatched pongs cannot hide a broken upstream', (t) => {
  const f = setup(t);
  const socket = f.ready();
  t.mock.timers.tick(10_000);
  socket.receive(new Uint8Array([65]).buffer);
  socket.receive('{"t":"pong","ts":-1}');
  t.mock.timers.tick(5_000);
  assert.equal(socket.closed, true);
});

test('short stalls preserve the socket, input order, and measured latency', (t) => {
  const f = setup(t);
  const socket = f.ready();
  assert.equal(f.connection.send(new Uint8Array([65])), true);
  assert.equal(f.connection.send(new Uint8Array([66])), true);
  t.mock.timers.tick(4_000);
  socket.pong();
  assert.equal(f.latencies.at(-1), 4_000);
  t.mock.timers.tick(5_000);
  socket.pong();
  assert.equal(socket.closed, false);
  assert.equal(FakeSocket.instances.length, 1);
  assert.deepEqual(socket.sent.filter((v) => v instanceof Uint8Array), [new Uint8Array([65]), new Uint8Array([66])]);
});

test('waking probes an OPEN socket and repeated focus events cannot defer failure', (t) => {
  const f = setup(t);
  const socket = f.ready();
  const oldPing = socket.ping();
  t.mock.timers.tick(14_000);
  f.connection.nudge();
  assert.notEqual(socket.ping().ts, oldPing.ts);
  socket.receive(JSON.stringify({ t: 'pong', ts: oldPing.ts }));
  t.mock.timers.tick(6_000);
  f.connection.nudge();
  assert.equal(socket.closed, false);
  t.mock.timers.tick(2_000);
  assert.equal(socket.closed, true);
});

test('a healthy wake-up probe keeps the current screen connection', (t) => {
  const f = setup(t);
  const socket = f.ready();
  t.mock.timers.tick(14_000);
  f.connection.nudge();
  t.mock.timers.tick(2_000);
  socket.pong();
  assert.equal(f.latencies.at(-1), 2_000);
  t.mock.timers.tick(5_000);
  socket.pong();
  assert.equal(socket.closed, false);
});

test('offline pauses retries and online reconnects immediately without replaying input', (t) => {
  const f = setup(t);
  const socket = f.ready();
  f.connection.send(new Uint8Array([13]));
  f.network.onLine = false;
  f.events.dispatchEvent(new Event('offline'));
  assert.equal(socket.closed, true);
  assert.equal(f.connection.send(new Uint8Array([65])), false);
  t.mock.timers.tick(60_000);
  assert.equal(FakeSocket.instances.length, 1);
  f.network.onLine = true;
  f.events.dispatchEvent(new Event('online'));
  assert.equal(FakeSocket.instances.length, 2);
  const replacement = f.ready();
  assert.equal(replacement.sent.some((v) => v instanceof Uint8Array), false);
});

test('repeated short-lived connections back off; a stable connection resets the delay', (t) => {
  const f = setup(t);
  for (const delay of [300, 600, 1200, 2400, 4800, 5000]) {
    const socket = f.ready();
    socket.onclose!();
    const count = FakeSocket.instances.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(FakeSocket.instances.length, count);
    t.mock.timers.tick(1);
    assert.equal(FakeSocket.instances.length, count + 1);
  }
  const stable = f.ready();
  stable.pong();
  t.mock.timers.tick(5_000);
  stable.pong();
  t.mock.timers.tick(5_000);
  stable.pong();
  stable.onclose!();
  const count = FakeSocket.instances.length;
  t.mock.timers.tick(300);
  assert.equal(FakeSocket.instances.length, count + 1);
});

test('input backlog and send failures are reported rather than silently buffered or replayed', (t) => {
  const f = setup(t);
  const socket = f.ready();
  socket.bufferedAmount = 65 * 1024;
  assert.equal(f.connection.send(new Uint8Array([65])), false);
  socket.bufferedAmount = 0;
  socket.throwOnSend = true;
  assert.equal(f.connection.send(new Uint8Array([66])), false);
  assert.equal(socket.closed, true);
  t.mock.timers.tick(300);
  const replacement = f.ready();
  assert.equal(replacement.sent.some((v) => v instanceof Uint8Array), false);
});

test('stop cancels retries, pending readiness, and browser lifecycle listeners', (t) => {
  const f = setup(t);
  const socket = f.ready();
  const pendingReady = f.readyCallbacks[0]!;
  f.connection.stop();
  assert.equal(socket.closed, true);
  assert.equal(pendingReady(), false);
  f.connection.nudge();
  f.events.dispatchEvent(new Event('online'));
  f.events.dispatchEvent(new Event('offline'));
  t.mock.timers.tick(60_000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(f.states.at(-1), 'closed');
});

test('malformed control messages do not mark a connection healthy or delay its timeout', (t) => {
  const f = setup(t);
  f.latest().open();
  t.mock.timers.tick(25_000);
  for (const data of ['{', 'null', '42', '[]', '{}', '{"t":"pong","ts":1}']) {
    f.latest().receive(data);
  }
  assert.deepEqual(f.messages, []);
  t.mock.timers.tick(5_000);
  assert.equal(f.latest().closed, true);
});
