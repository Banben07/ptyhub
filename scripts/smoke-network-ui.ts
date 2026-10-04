/** Real browser + TCP/WebSocket fault tests against an in-memory gateway
 * fixture. No real shells, user configuration, build output, or file cleanup. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer, WebSocket } from 'ws';
import viteConfig from '../vite.config.ts';
import { defaultPrefs } from '../src/shared/prefs.ts';
import { defaultSharedKeymap } from '../src/shared/keymap.ts';
import type { SessionMeta } from '../src/shared/protocol.ts';

const session: SessionMeta = {
  id: 'abcdefghjkmn', name: 'Network test', cwd: '/tmp', argv: ['/bin/sh'],
  createdAt: Date.now(), cols: 100, rows: 30, pid: 1234, fgProc: 'sh',
  title: '', viewers: 1, locked: false, alive: true,
  exitCode: null, exitSignal: null, exitedAt: null,
};

async function main(): Promise<void> {
  const result = await build({
    ...viteConfig, configFile: false, publicDir: false, logLevel: 'silent',
    build: { ...viteConfig.build, write: false, emptyOutDir: false },
  });
  if ('on' in result) throw new Error('unexpected watch build');
  const assets = new Map<string, string | Uint8Array>();
  for (const bundle of Array.isArray(result) ? result : [result]) {
    for (const item of bundle.output) {
      assets.set(`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source);
    }
  }
  process.stdout.write('UI production build completed in memory.\n');

  let storedPrefs = structuredClone(defaultPrefs);
  let failPrefs = false;
  let prefsAttempts = 0;
  let failHealth = 1;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/api/prefs' && req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        prefsAttempts++;
        if (failPrefs) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'temporary_failure', message: 'test outage' } }));
          return;
        }
        const patch = JSON.parse(body).prefs;
        storedPrefs = { ...storedPrefs, ...patch, font: {
          ...storedPrefs.font, ...patch.font,
          size: { ...storedPrefs.font.size, ...patch.font?.size },
        } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prefs: storedPrefs }));
      });
      return;
    }
    req.resume();
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/health' && failHealth-- > 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'temporary_failure' } }));
        return;
      }
      const responses: Record<string, unknown> = {
        '/api/auth/status': { authenticated: true, user: 'test', openAccess: true, passwordConfigured: false },
        '/api/health': { ok: true, version: 'test', ptyd: 'connected', autoCreateFirstSession: false, resizePolicy: 'active', user: 'test' },
        '/api/prefs': { prefs: storedPrefs },
        '/api/keymap': { keymap: defaultSharedKeymap },
        '/api/sessions': { sessions: [session] },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responses[pathname] ?? {}));
      return;
    }
    const key = pathname === '/' ? '/index.html' : pathname;
    const data = assets.get(key);
    if (data === undefined) { res.writeHead(404); res.end(); return; }
    const type = key.endsWith('.html') ? 'text/html' : key.endsWith('.js') ? 'text/javascript'
      : key.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
  const wss = new WebSocketServer({ server });
  const blocked = new WeakSet<WebSocket>();
  const terminals = new Set<WebSocket>();
  const receivedInput: string[] = [];
  const counts = { terminal: 0, events: 0 };
  let holdReady = true;
  let delayMs = 0;
  const delayed = new Set<ReturnType<typeof setTimeout>>();
  function send(ws: WebSocket, data: string | Buffer): void {
    if (ws.readyState === WebSocket.OPEN && !blocked.has(ws)) ws.send(data);
  }
  function reply(ws: WebSocket, data: string | Buffer): void {
    if (!delayMs) { send(ws, data); return; }
    const timer = setTimeout(() => { delayed.delete(timer); send(ws, data); }, delayMs);
    delayed.add(timer);
  }
  function ready(ws: WebSocket): void {
    send(ws, JSON.stringify({ t: 'ready', cols: session.cols, rows: session.rows }));
  }
  wss.on('connection', (ws, req) => {
    const terminal = req.url?.startsWith('/ws/sessions/');
    if (terminal) {
      counts.terminal++;
      terminals.add(ws);
      ws.on('close', () => terminals.delete(ws));
      send(ws, JSON.stringify({ t: 'hello', session, policy: 'active' }));
      send(ws, Buffer.from('\x1b[2J\x1b[HNetwork snapshot restored\r\n$ '));
      if (!holdReady) ready(ws);
    } else {
      counts.events++;
      send(ws, JSON.stringify({ t: 'snapshot', sessions: [session], status: 'connected' }));
    }
    ws.on('message', (data, binary) => {
      if (blocked.has(ws)) return;
      if (binary) {
        receivedInput.push(String(data));
        reply(ws, Buffer.from(String(data)));
      } else {
        const msg = JSON.parse(String(data));
        if (msg.t === 'ping') reply(ws, JSON.stringify({ t: 'pong', ts: msg.ts }));
        if (terminal && msg.t === 'resize') {
          session.cols = msg.cols;
          session.rows = msg.rows;
          send(ws, JSON.stringify({ t: 'resized', cols: msg.cols, rows: msg.rows }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const connected = () => page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub?.active() && hub.state(hub.active()) === 'open'
        && document.querySelector('.status-label')?.textContent === 'Connected';
    });
    const paste = (text: string) => page.evaluate((value) => {
      const hub = (window as any).__ptyhub;
      hub.terminal(hub.active()).paste(value);
    }, text);
    const check = (label: string) => process.stdout.write(`  ok   ${label}\n`);

    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub?.active() && hub.read(hub.active()).includes('Network snapshot restored');
    });
    check('workspace loading retries a temporary HTTP failure');
    assert.equal(await page.evaluate(() => {
      const hub = (window as any).__ptyhub;
      return hub.state(hub.active());
    }), 'connecting');
    await paste('UNSENT_BEFORE_READY\r');
    assert.equal(receivedInput.length, 0);
    holdReady = false;
    for (const ws of terminals) ready(ws);
    await connected();
    await page.getByText('Input was not sent.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    check('input waits for snapshot completion and rejected input is explained');

    await paste('healthy input\r');
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub.read(hub.active()).includes('healthy input');
    });
    check('real terminal accepts and renders input once ready');

    const beforeBlackhole = { ...counts };
    for (const ws of wss.clients) blocked.add(ws);
    const started = Date.now();
    await page.waitForFunction(() => document.querySelector('.status-label')?.textContent === 'Reconnecting', undefined, { timeout: 23_000 });
    await connected();
    assert.ok(counts.terminal > beforeBlackhole.terminal && counts.events > beforeBlackhole.events);
    check(`silent failures recover both channels without reload (${Date.now() - started} ms)`);

    const beforeWake = { ...counts };
    for (const ws of terminals) blocked.add(ws);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub.state(hub.active()) === 'reconnecting';
    }, undefined, { timeout: 23_000 });
    await connected();
    assert.ok(counts.terminal > beforeWake.terminal);
    assert.equal(counts.events, beforeWake.events);
    check('focus probes and replaces a stale terminal while preserving a healthy event channel');

    const beforeDelay = { ...counts };
    delayMs = 1200;
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub.terminal(hub.active()).latencyMs.value >= 1000;
    });
    await paste('delayed input\r');
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub.read(hub.active()).includes('delayed input');
    });
    assert.deepEqual(counts, beforeDelay);
    delayMs = 0;
    check('high latency keeps the existing connection and ordered input');

    await context.setOffline(true);
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub.state(hub.active()) === 'reconnecting';
    });
    await paste('UNSENT_WHILE_OFFLINE\r');
    assert.equal(receivedInput.some((input) => input.includes('UNSENT')), false);
    await context.setOffline(false);
    await connected();
    await page.getByText('Input was not sent.', { exact: false }).waitFor();
    await paste('after reconnect\r');
    await page.waitForFunction(() => {
      const hub = (window as any).__ptyhub;
      return hub.read(hub.active()).includes('after reconnect');
    });
    assert.equal(receivedInput.some((input) => input.includes('UNSENT')), false);
    assert.equal(receivedInput.filter((input) => input === 'healthy input\r').length, 1);
    assert.deepEqual(errors, []);
    check('offline/online resumes automatically, reports unsent keys, and never replays commands');

    // Exercise the actual settings UI rather than calling the save queue directly.
    failPrefs = true;
    const beforeSaves = prefsAttempts;
    await page.click('button[title="Settings"]');
    await page.getByRole('button', { name: 'Font', exact: true }).click();
    const size = page.locator('.setting').filter({ hasText: 'Size on this desktop' }).locator('input[type="range"]');
    await size.fill('18');
    await page.waitForFunction(() => (window as any).__ptyhub.prefs().font.size.desktop === 18);
    const saveDeadline = Date.now() + 5000;
    while (prefsAttempts === beforeSaves && Date.now() < saveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(prefsAttempts > beforeSaves);
    await size.fill('19');
    failPrefs = false;
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    const recoveryDeadline = Date.now() + 6000;
    while (storedPrefs.font.size.desktop !== 19 && Date.now() < recoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(storedPrefs.font.size.desktop, 19);
    await page.reload();
    await connected();
    assert.equal(await page.evaluate(() => (window as any).__ptyhub.prefs().font.size.desktop), 19);
    assert.deepEqual(errors, []);
    check('failed settings saves recover with the newest edit and survive a reload');
    process.stdout.write('8 browser network checks passed.\n');
  } finally {
    await browser?.close();
    for (const timer of delayed) clearTimeout(timer);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => { process.stderr.write(`${err.stack ?? err}\n`); process.exitCode = 1; });
