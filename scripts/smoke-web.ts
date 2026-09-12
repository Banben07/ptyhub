/**
 * End-to-end smoke test for the HTTP/WebSocket gateway.
 *
 * Runs a real ptyd plus a real gateway against throwaway XDG directories and
 * exercises the paths a browser takes: REST lifecycle, terminal WebSocket,
 * reconnect, the event channel, cross-origin rejection, and both login routes.
 *
 *   npx tsx scripts/smoke-web.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  Client,
  check,
  freePort,
  launch,
  makeSandbox,
  runScript,
  sleep,
  summary,
  waitFor,
} from './harness.ts';
import { hashPassword } from '../src/web/auth.ts';
import type { EventsWsMessage, ServerWsMessage } from '../src/shared/protocol.ts';

const TEST_USER = 'tester';
const PASSWORD = 'correct horse battery staple';

interface Attached {
  ws: WebSocket;
  text: () => string;
  messages: ServerWsMessage[];
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => Promise<void>;
}

function attach(origin: string, id: string, cookie: string, query = ''): Promise<Attached> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws/sessions/${id}${query}`, {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
    let out = '';
    const messages: ServerWsMessage[] = [];

    ws.on('message', (raw, isBinary) => {
      if (isBinary) out += (raw as Buffer).toString('utf8');
      else messages.push(JSON.parse(String(raw)) as ServerWsMessage);
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        text: () => out,
        send: (data) => ws.send(Buffer.from(data, 'utf8'), { binary: true }),
        resize: (cols, rows) => ws.send(JSON.stringify({ t: 'resize', cols, rows })),
        close: () =>
          new Promise<void>((done) => {
            ws.once('close', () => done());
            ws.close();
          }),
      }),
    );
  });
}

async function main(): Promise<void> {
  const sandbox = makeSandbox('web');
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    sandbox.configFile,
    JSON.stringify({ bind: '127.0.0.1', port, procPollMs: 1000 }, null, 2),
  );

  process.stdout.write(`gateway smoke test\n  workdir ${sandbox.dir}\n  port ${port}\n\n`);

  const ptyd = launch('src/ptyd/index.ts', sandbox.env);
  await waitFor('ptyd socket', () => fs.existsSync(sandbox.socketFile), 20000);
  const web = launch('src/web/index.ts', sandbox.env);

  const api = new Client(origin);
  try {
    const up = await waitFor(
      'gateway health',
      () => /listening on/.test(web.logs()),
      20000,
    );
    check('gateway starts', up, web.logs().slice(-400));
    if (!up) return;

    // --- no password means an access token, not open access ----------------

    const locked = await api.get('/api/sessions');
    check(
      'loopback with no password is NOT open to everyone on the machine',
      locked.status === 401,
    );

    const tokenFile = path.join(sandbox.env.XDG_STATE_HOME!, 'ptyhub', 'token.json');
    check('the gateway minted an access token on startup', fs.existsSync(tokenFile));
    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token as string;

    const tokenPair = await api.post('/api/auth/pair', { k: token });
    check('the access token authorises a browser', tokenPair.status === 200);

    const health = await api.get('/api/health');
    check('health reports ptyd connected', health.json?.ptyd === 'connected');

    // --- session lifecycle over REST --------------------------------------

    const created = await api.post('/api/sessions', {
      name: 'web-smoke',
      argv: ['/bin/sh'],
      cols: 90,
      rows: 24,
    });
    check('POST /api/sessions creates a session', created.status === 201);
    const id: string = created.json.session.id;

    const listed = await api.get('/api/sessions');
    check(
      'GET /api/sessions lists it',
      listed.json.sessions.some((s: { id: string }) => s.id === id),
    );

    const renamed = await api.patch(`/api/sessions/${id}`, { name: 'renamed-via-rest' });
    check('PATCH renames the session', renamed.json.session.name === 'renamed-via-rest');

    // --- cross-origin protection ------------------------------------------

    const crossOrigin = await api.post(
      '/api/sessions',
      { argv: ['/bin/sh'] },
      { Origin: 'http://evil.example' },
    );
    check('cross-origin POST is rejected', crossOrigin.status === 403);

    const badOriginWs = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws/sessions/${id}`, {
        headers: { Origin: 'http://evil.example' },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        resolve(200);
      });
      ws.on('error', () => resolve(-1));
    });
    check('cross-origin WebSocket upgrade is rejected', badOriginWs === 403);

    // --- terminal websocket -----------------------------------------------

    const term = await attach(origin, id, api.cookieHeader, '?cols=90&rows=24');
    const gotHello = await waitFor('hello frame', () =>
      term.messages.some((m) => m.t === 'hello'),
    );
    check('terminal socket sends hello before any output', gotHello);
    check(
      'ready frame follows the snapshot',
      await waitFor('ready frame', () => term.messages.some((m) => m.t === 'ready')),
    );

    term.send('echo web-hello\n');
    check(
      'typing over the websocket reaches the shell',
      await waitFor('echo output', () => term.text().includes('web-hello')),
    );

    term.resize(70, 20);
    await sleep(200);
    term.send('stty size\n');
    check(
      'resize over the websocket reaches the shell',
      await waitFor('stty size', () => /20\s+70/.test(term.text())),
    );
    check(
      'server confirms the new size',
      term.messages.some((m) => m.t === 'resized' && m.cols === 70),
    );

    // --- a socket that declares no size must not resize the session --------

    const sizedBefore = (await api.get(`/api/sessions/${id}`)).json.session;
    const silent = await attach(origin, id, api.cookieHeader); // no ?cols=&rows=
    await sleep(400);
    const sizedAfter = (await api.get(`/api/sessions/${id}`)).json.session;
    check(
      'attaching without a size in the URL leaves the session alone',
      sizedAfter.cols === sizedBefore.cols && sizedAfter.rows === sizedBefore.rows,
      `${sizedBefore.cols}x${sizedBefore.rows} -> ${sizedAfter.cols}x${sizedAfter.rows}`,
    );
    await silent.close();

    // --- the core promise, through the gateway ----------------------------

    await term.close();
    await sleep(200);
    const afterClose = await api.get(`/api/sessions/${id}`);
    check('session stays alive after the browser disconnects', afterClose.json.session.alive);

    const reattached = await attach(origin, id, api.cookieHeader, '?cols=70&rows=20');
    check(
      'reattaching replays the earlier screen',
      await waitFor('snapshot replay', () => reattached.text().includes('web-hello')),
    );
    await reattached.close();

    // --- locking over REST --------------------------------------------------

    const lockTarget = (await api.post('/api/sessions', { argv: ['/bin/sh'] })).json
      .session.id as string;

    const lockRes = await api.patch(`/api/sessions/${lockTarget}`, { locked: true });
    check('PATCH can lock a session', lockRes.json.session.locked === true);

    const refused = await api.del(`/api/sessions/${lockTarget}`);
    check('DELETE on a locked session is refused with 409', refused.status === 409);

    const stillThere = await api.get(`/api/sessions/${lockTarget}`);
    check('the locked session survived the refused delete', stillThere.status === 200);

    const forced = await api.del(`/api/sessions/${lockTarget}?force=1`);
    check('DELETE with force=1 closes it anyway', forced.status === 200);
    const gone = await api.get(`/api/sessions/${lockTarget}`);
    check('the forced session is gone', gone.status === 404);

    // --- event channel ------------------------------------------------------

    const events: EventsWsMessage[] = [];
    const evWs = new WebSocket(`${origin.replace('http', 'ws')}/ws/events`, {
      headers: { Origin: origin, Cookie: api.cookieHeader },
    });
    evWs.on('error', (err) => process.stdout.write(`       events socket: ${err}\n`));
    await new Promise((r) => evWs.once('open', r));
    evWs.on('message', (raw) => events.push(JSON.parse(String(raw)) as EventsWsMessage));
    check(
      'event channel opens with a session snapshot',
      await waitFor('snapshot message', () => events.some((e) => e.t === 'snapshot')),
    );

    const second = await api.post('/api/sessions', { argv: ['/bin/sh'] });
    check(
      'event channel reports a newly created session',
      await waitFor('created event', () =>
        events.some((e) => e.t === 'event' && e.event.ev === 'created'),
      ),
    );
    await api.del(`/api/sessions/${second.json.session.id}`);

    // --- ensure-first-session ----------------------------------------------

    const ensure = await api.post('/api/sessions/ensure', { cols: 80, rows: 24 });
    check(
      'ensure returns the existing session instead of making another',
      ensure.json.created === false && ensure.json.session.id === id,
    );

    // --- authentication ------------------------------------------------------

    const { salt, hash } = hashPassword(PASSWORD);
    fs.writeFileSync(
      path.join(sandbox.env.XDG_CONFIG_HOME!, 'ptyhub', 'auth.json'),
      JSON.stringify({ users: [{ name: TEST_USER, salt, hash }] }, null, 2),
      { mode: 0o600 },
    );

    const retiredToken = await new Client(origin).post('/api/auth/pair', { k: token });
    check('setting a password retires the access token', retiredToken.status === 401);

    const stillIn = await api.get('/api/sessions');
    check('a device authorised earlier keeps working', stillIn.status === 200);

    const desktop = new Client(origin);
    const badLogin = await desktop.post('/api/auth/login', {
      user: TEST_USER,
      password: 'wrong',
    });
    check('wrong password is rejected', badLogin.status === 401);

    const login = await desktop.post('/api/auth/login', {
      user: TEST_USER,
      password: PASSWORD,
      remember: true,
    });
    check('correct password logs in', login.status === 200 && login.json.user === TEST_USER);
    check('login sets a device cookie', desktop.cookieHeader.includes('ptyhub_dev='));

    const authed = await desktop.get('/api/sessions');
    check('the cookie authenticates later requests', authed.status === 200);

    const devices = await desktop.get('/api/auth/devices');
    check(
      'the signed-in device shows up in the device list',
      devices.json.devices.some((d: { current: boolean }) => d.current),
    );

    // Pairing link, the phone path. Minted in a child process carrying the
    // sandbox environment, exactly as `ptyhub link` would.
    const pairing = JSON.parse(
      await runScript('scripts/pairing-key.ts', sandbox.env, [TEST_USER]),
    ) as { key: string; expiresAt: number };
    const phone = new Client(origin);
    const beforePair = await phone.get('/api/sessions');
    check('a fresh device is unauthenticated', beforePair.status === 401);

    const paired = await phone.post('/api/auth/pair', { k: pairing.key });
    check('pairing link authenticates a new device', paired.status === 200);
    const phoneAuthed = await phone.get('/api/sessions');
    check('the paired device can use the API', phoneAuthed.status === 200);

    const reused = await new Client(origin).post('/api/auth/pair', { k: pairing.key });
    check('a pairing link cannot be used twice', reused.status === 401);

    // WebSocket must honour the cookie too.
    const unauthedWs = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws/events`, {
        headers: { Origin: origin },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        resolve(200);
      });
      ws.on('error', () => resolve(-1));
    });
    check('WebSocket without a cookie is rejected once auth is on', unauthedWs === 401);

    const logout = await desktop.post('/api/auth/logout');
    check('logout succeeds', logout.status === 200);
    const afterLogout = await desktop.get('/api/sessions');
    check('logout takes effect immediately', afterLogout.status === 401);

    evWs.close();

    // --- gateway restart does not disturb sessions --------------------------

    web.stop();
    await waitFor('gateway exit', () => web.child.exitCode !== null, 8000);
    const web2 = launch('src/web/index.ts', sandbox.env);
    await waitFor('gateway restart', () => /listening on/.test(web2.logs()), 20000);

    const afterRestart = await phone.get(`/api/sessions/${id}`);
    check(
      'session survives a gateway restart',
      afterRestart.status === 200 && afterRestart.json.session.alive === true,
    );
    web2.stop();
  } finally {
    web.stop();
    ptyd.stop();
    await sleep(300);
    sandbox.cleanup();
  }

  summary(`--- ptyd ---\n${ptyd.logs()}\n--- web ---\n${web.logs()}`);
}

await main();
