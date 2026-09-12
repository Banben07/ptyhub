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

    // --- migrating a keymap saved while direct bindings still auto-registered
    // both Ctrl and Cmd ---------------------------------------------------

    {
      const migSandbox = makeSandbox('keymap-mig');
      const migPort = freePort();
      fs.writeFileSync(
        migSandbox.configFile,
        JSON.stringify({ bind: '127.0.0.1', port: migPort }, null, 2),
      );
      // A pre-fix keymap: `ctrl+z` has no Cmd sibling and must survive
      // untouched, so this proves the migration targets the specific
      // duplicate pairing rather than stripping every Ctrl entry wholesale.
      fs.writeFileSync(
        path.join(migSandbox.env.XDG_CONFIG_HOME!, 'ptyhub', 'keymap.json'),
        JSON.stringify({
          version: 3,
          directBindings: {
            'ctrl+w': 'close-session',
            'meta+w': 'close-session',
            'ctrl+z': 'clear-screen',
          },
        }),
        { mode: 0o644 },
      );

      const migPtyd = launch('src/ptyd/index.ts', migSandbox.env);
      await waitFor('mig ptyd socket', () => fs.existsSync(migSandbox.socketFile), 20000);
      const migWeb = launch('src/web/index.ts', migSandbox.env);
      await waitFor('mig gateway', () => /listening on/.test(migWeb.logs()), 20000);

      try {
        const migApi = new Client(`http://127.0.0.1:${migPort}`);
        const migTokenFile = path.join(migSandbox.env.XDG_STATE_HOME!, 'ptyhub', 'token.json');
        await waitFor('mig token', () => fs.existsSync(migTokenFile), 10000);
        const migToken = JSON.parse(fs.readFileSync(migTokenFile, 'utf8')).token as string;
        await migApi.post('/api/auth/pair', { k: migToken });

        const km = (await migApi.get('/api/keymap')).json.keymap.directBindings;
        check(
          'the Cmd entry survives the migration',
          km['meta+w'] === 'close-session',
        );
        check(
          'the duplicate Ctrl entry is dropped',
          km['ctrl+w'] === undefined,
          JSON.stringify(km),
        );
        check(
          "a Ctrl entry with no Cmd sibling is left alone — it wasn't part of the bug",
          km['ctrl+z'] === 'clear-screen',
        );
      } finally {
        migWeb.stop();
        migPtyd.stop();
        await sleep(300);
        migSandbox.cleanup();
      }
    }

    // --- a viewer that cannot keep up is disconnected, not silently desynced --
    //
    // Same regression as ptyd's own fix, one layer up: this is the browser-
    // facing leg (gateway to browser), a separate bottleneck from ptyd-to-
    // gateway — a slow phone can back this one up while the other stays
    // perfectly healthy. Silently dropping frames here risks the exact same
    // permanent desync between the browser's rendered screen and ptyd's
    // headless copy of it.
    {
      const bpSandbox = makeSandbox('web-bp');
      const bpPort = freePort();
      const bpOrigin = `http://127.0.0.1:${bpPort}`;
      fs.writeFileSync(
        bpSandbox.configFile,
        JSON.stringify({ bind: '127.0.0.1', port: bpPort }, null, 2),
      );
      const bpPtyd = launch('src/ptyd/index.ts', bpSandbox.env);
      await waitFor('bp ptyd socket', () => fs.existsSync(bpSandbox.socketFile), 20000);
      // Only the gateway leg needs shrinking; this is a wholly separate
      // buffer from ptyd's own MAX_SOCKET_BACKLOG.
      const bpWeb = launch('src/web/index.ts', {
        ...bpSandbox.env,
        PTYHUB_MAX_WS_BACKLOG: '4096',
      });
      await waitFor('bp gateway', () => /listening on/.test(bpWeb.logs()), 20000);

      try {
        const bpApi = new Client(bpOrigin);
        const bpTokenFile = path.join(bpSandbox.env.XDG_STATE_HOME!, 'ptyhub', 'token.json');
        await waitFor('bp access token', () => fs.existsSync(bpTokenFile), 10000);
        const bpToken = JSON.parse(fs.readFileSync(bpTokenFile, 'utf8')).token as string;
        await bpApi.post('/api/auth/pair', { k: bpToken });

        const created = await bpApi.post('/api/sessions', { argv: ['/bin/sh'] });
        if (created.status !== 201) {
          throw new Error(
            `bp session create failed: ${created.status} ${created.text}\n--- bp web log ---\n${bpWeb.logs()}`,
          );
        }
        const bpId: string = created.json.session.id;

        // A WebSocket that connects and subscribes, then is told to stop
        // reading entirely — standing in for a phone that fell asleep mid
        // stream. `ws`'s own frame parser normally keeps the socket draining
        // regardless of app-level listeners, so simulating a truly stalled
        // reader needs an explicit pause of the underlying transport.
        // A WS `open` event only means the handshake finished; the gateway's
        // own subscribe() to ptyd is a separate async step after that. Wait
        // for its `ready` control frame so "both attached" below is not a race.
        const waitReady = (socket: WebSocket) =>
          new Promise<void>((resolve) => {
            const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
              if (isBinary) return;
              if (JSON.parse(String(data)).t === 'ready') {
                socket.off('message', onMsg);
                resolve();
              }
            };
            socket.on('message', onMsg);
          });

        const stuckWs = new WebSocket(`${bpOrigin.replace('http', 'ws')}/ws/sessions/${bpId}`, {
          headers: { Origin: bpOrigin, Cookie: bpApi.cookieHeader },
        });
        await new Promise((resolve) => stuckWs.once('open', resolve));
        await waitReady(stuckWs);
        // Only pause once truly subscribed — pausing stops it from ever
        // seeing its own `ready` frame.
        stuckWs.pause();

        const flooder = new WebSocket(`${bpOrigin.replace('http', 'ws')}/ws/sessions/${bpId}`, {
          headers: { Origin: bpOrigin, Cookie: bpApi.cookieHeader },
        });
        await new Promise((resolve) => flooder.once('open', resolve));
        await waitReady(flooder);

        // Confirm both really are attached before flooding — otherwise a
        // "drops to 1" check below would trivially pass even if the fix did
        // nothing at all.
        const beforeFlood = await bpApi.get(`/api/sessions/${bpId}`);
        check(
          'both sockets are attached before the flood',
          beforeFlood.json.session.viewers === 2,
          `viewers = ${beforeFlood.json.session.viewers}`,
        );

        // Loopback TCP buffers auto-tune generously, so a small burst is
        // comfortably absorbed by the kernel without ever registering as
        // backpressure at the ws layer — this needs to be big enough to
        // overwhelm that, not just past the 4 KB application-level threshold.
        flooder.send(Buffer.from('yes | head -c 100000000\n'), { binary: true });

        // The property that matters: the gateway gives up on the stalled
        // socket and ptyd is told to drop that subscription, promptly and on
        // its own — not whether the frozen client ever notices, which (like
        // the ptyd-level fix) it may not do until something wakes it up.
        check(
          'the gateway drops the stalled terminal socket viewer promptly',
          await waitFor(
            'viewer count to fall',
            async () => {
              const res = await bpApi.get(`/api/sessions/${bpId}`);
              return res.json.session.viewers === 1; // just the flooder left
            },
            8000,
          ),
        );
        check(
          'the gateway logs why it disconnected the stalled socket',
          bpWeb.logs().includes('not draining'),
        );

        flooder.close();
        stuckWs.terminate();
      } finally {
        bpWeb.stop();
        bpPtyd.stop();
        await sleep(300);
        bpSandbox.cleanup();
      }
    }

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
