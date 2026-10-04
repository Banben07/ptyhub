/** Request and preference failure tests using virtual time; no user files. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { api, ApiError } from '../web/src/api.ts';
import { PendingSave, PrefsSync } from '../web/src/prefs-sync.ts';
import { defaultPrefs, type Prefs } from '../src/shared/prefs.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return async (ms: number) => {
    t.mock.timers.tick(ms);
    // Let fetch, body reads, catches and save completions drain their microtasks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}

test('reads retry a temporary failure once', async (t) => {
  const advance = clock(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return json({ error: { code: 'unavailable' } }, 503);
    return json({ sessions: [] });
  });
  const request = api.listSessions();
  await advance(0);
  assert.equal(calls, 1);
  await advance(300);
  assert.deepEqual(await request, { sessions: [] });
  assert.equal(calls, 2);
});

test('read retries are bounded and authentication failures are not retried', async (t) => {
  const advance = clock(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({}, 503); });
  const failed = assert.rejects(api.health(), (err: ApiError) => err.status === 503);
  await advance(0);
  await advance(300);
  await failed;
  assert.equal(calls, 2);
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({}, 401); });
  await assert.rejects(api.listSessions(), (err: ApiError) => err.unauthenticated);
  assert.equal(calls, 1);
});

test('the deadline also covers a response body that stops arriving', async (t) => {
  const advance = clock(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    if (++calls > 1) return json({ sessions: [] });
    return new Response(new ReadableStream({
      start(controller) {
        options.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      },
    }));
  });
  const request = api.listSessions();
  await advance(15_000);
  await advance(300);
  assert.deepEqual(await request, { sessions: [] });
  assert.equal(calls, 2);
});

test('timed-out session creation is reported without executing it twice', async (t) => {
  const advance = clock(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  const failed = assert.rejects(api.createSession({ name: 'test' }), (err: ApiError) =>
    err.code === 'request_timeout' && err.message.includes('completed before retrying'));
  await advance(15_000);
  await failed;
  await advance(60_000);
  assert.equal(calls, 1);
});

test('failed session close and failed preference PUT are not retried by the HTTP client', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('broken route'); });
  await assert.rejects(api.killSession('abcdefghjkmn'), (err: ApiError) => err.code === 'network_error');
  await assert.rejects(api.savePrefs({ darkTheme: 'dracula' }), (err: ApiError) => err.code === 'network_error');
  assert.equal(calls, 2);
});

function preferences(t: TestContext, save: (patch: Partial<Prefs>) => Promise<unknown>) {
  const advance = clock(t);
  const events = new EventTarget();
  const network = { onLine: true };
  const restore: (() => void)[] = [];
  for (const [key, value] of Object.entries({ window: events, navigator: network })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const errors: unknown[] = [];
  const sync = new PrefsSync(save, (err) => errors.push(err));
  const cleanup = [() => sync.stop()];
  sync.start();
  t.after(() => { for (const stop of cleanup) stop(); for (const undo of restore) undo(); });
  return { sync, advance, events, network, errors, cleanup };
}

test('offline preferences and layout stay queued and are saved on returning online', async (t) => {
  const saved: Partial<Prefs>[] = [];
  const f = preferences(t, async (patch) => { saved.push(patch); });
  f.network.onLine = false;
  f.sync.enqueue({ darkTheme: 'dracula', font: { ...defaultPrefs.font, lineHeight: 1.5 } });
  f.sync.enqueue({ layout: { kind: 'leaf', id: 'pane', sessionId: 'abcdefghjkmn' } });
  await f.advance(60_000);
  assert.equal(saved.length, 0);
  assert.equal(f.sync.snapshot()?.darkTheme, 'dracula');
  f.network.onLine = true;
  f.events.dispatchEvent(new Event('online'));
  await f.advance(0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.font!.lineHeight, 1.5);
  assert.ok(saved[0]!.layout);
  assert.equal(f.sync.snapshot(), null);
});

test('edits during a failed save win, and preference writes stay serial', async (t) => {
  const saved: Partial<Prefs>[] = [];
  let rejectFirst!: (err: unknown) => void;
  const f = preferences(t, async (patch) => {
    saved.push(patch);
    if (saved.length === 1) await new Promise((_resolve, reject) => { rejectFirst = reject; });
  });
  f.sync.enqueue({ darkTheme: 'dracula' }, 0);
  await f.advance(0);
  f.sync.enqueue({ darkTheme: 'tokyo-night', lightTheme: 'github-light' });
  await f.advance(2_000);
  assert.equal(saved.length, 1);
  rejectFirst(new ApiError(0, 'network_error', 'offline'));
  await f.advance(0);
  await f.advance(1_000);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1], { darkTheme: 'tokyo-night', lightTheme: 'github-light' });
  assert.equal(f.sync.snapshot(), null);
  assert.equal(f.errors.length, 1);
});

test('permanent save failures pause until successful authentication resumes them', async (t) => {
  let calls = 0;
  const f = preferences(t, async () => {
    if (++calls === 1) throw new ApiError(401, 'unauthenticated', 'login required');
  });
  f.sync.enqueue({ darkTheme: 'dracula' }, 0);
  await f.advance(0);
  f.events.dispatchEvent(new Event('online'));
  await f.advance(60_000);
  assert.equal(calls, 1);
  assert.ok(f.sync.snapshot());
  f.sync.resume();
  await f.advance(0);
  assert.equal(calls, 2);
  assert.equal(f.sync.snapshot(), null);
});

test('successful in-flight writes do not drop newer changes or resend old fields', async (t) => {
  const saved: Partial<Prefs>[] = [];
  let resolveFirst!: () => void;
  const f = preferences(t, async (patch) => {
    saved.push(patch);
    if (saved.length === 1) await new Promise<void>((resolve) => { resolveFirst = resolve; });
  });
  f.sync.enqueue({ darkTheme: 'dracula' }, 0);
  await f.advance(0);
  f.sync.enqueue({ copyOnSelect: false });
  assert.deepEqual(f.sync.snapshot(), { darkTheme: 'dracula', copyOnSelect: false });
  resolveFirst();
  await f.advance(0);
  await f.advance(0);
  assert.deepEqual(saved, [{ darkTheme: 'dracula' }, { copyOnSelect: false }]);
});

test('keyboard settings retry only the newest complete keymap', async (t) => {
  const f = preferences(t, async () => {});
  const saved: { leader: string }[] = [];
  const queue = new PendingSave<{ leader: string }>(async (value) => {
    saved.push(value);
    if (saved.length === 1) throw new ApiError(0, 'network_error', 'offline');
  }, () => {});
  queue.start();
  f.cleanup.push(() => queue.stop());
  queue.enqueue({ leader: 'old' }, 0);
  await f.advance(0);
  queue.enqueue({ leader: 'new' }, 0);
  await f.advance(0);
  assert.deepEqual(saved, [{ leader: 'old' }, { leader: 'new' }]);
  assert.equal(queue.snapshot(), null);
  queue.stop();
});
