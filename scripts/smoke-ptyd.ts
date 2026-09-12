/**
 * End-to-end smoke test for ptyd.
 *
 * Starts a real ptyd against throwaway XDG directories, drives it over the unix
 * socket, and checks the properties the whole project rests on: sessions
 * outlive their viewers, resizes reach the shell, and reconnecting restores the
 * screen.
 *
 *   npx tsx scripts/smoke-ptyd.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PtydClient, PtydError } from '../src/shared/ptyd-client.ts';
import type { Event } from '../src/shared/protocol.ts';
import { encodeJson } from '../src/shared/protocol.ts';
// Shared with the other suites on purpose: a second copy of `waitFor` is how a
// version that does not await async predicates crept back in.
import { check, sleep, summary, waitFor } from './harness.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhub-smoke-'));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(tmp, 'config'),
    XDG_STATE_HOME: path.join(tmp, 'state'),
    XDG_RUNTIME_DIR: path.join(tmp, 'run'),
  };
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  const socketFile = path.join(env.XDG_RUNTIME_DIR, 'ptyhub', 'ptyd.sock');

  process.stdout.write(`ptyd smoke test\n  workdir ${tmp}\n\n`);

  // `--import tsx` keeps ptyd in *this* process rather than behind the tsx CLI
  // wrapper, which is also how the systemd unit launches it so that MainPID,
  // Restart= and signal delivery all refer to the real daemon.
  const ptyd: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/ptyd/index.ts'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let daemonLog = '';
  ptyd.stderr?.on('data', (c: Buffer) => {
    daemonLog += c.toString();
  });

  const cleanup = () => {
    if (!ptyd.killed) ptyd.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    const up = await waitFor('ptyd socket', () => fs.existsSync(socketFile), 20000);
    check('ptyd starts and creates its socket', up, daemonLog.slice(-500));
    if (!up) return;

    check(
      'socket is owner-only (0600)',
      (fs.statSync(socketFile).mode & 0o777) === 0o600,
    );

    // --- session 1: create, attach, type -----------------------------------

    const output = new Map<string, string>();
    const events: Event[] = [];
    const append = (id: string, data: Buffer) =>
      output.set(id, (output.get(id) ?? '') + data.toString('utf8'));

    const client = await PtydClient.connect(socketFile, {
      onOutput: append,
      onEvent: (evt) => events.push(evt),
    });

    const session = await client.create({
      name: 'smoke',
      argv: ['/bin/sh'],
      cols: 80,
      rows: 24,
    });
    check('create returns a live session', session.alive && session.pid > 0);
    check('session got the requested name', session.name === 'smoke');

    await client.subscribe(session.id, { cols: 80, rows: 24 });
    client.sendInput(session.id, 'echo hello-ptyhub\n');
    check(
      'typed command produces output',
      await waitFor('echo output', () =>
        (output.get(session.id) ?? '').includes('hello-ptyhub'),
      ),
    );

    // --- resize reaches the shell ------------------------------------------

    output.set(session.id, '');
    await client.resize(session.id, 100, 40);
    await sleep(150);
    client.sendInput(session.id, 'stty size\n');
    const resized = await waitFor('stty size output', () =>
      /40\s+100/.test(output.get(session.id) ?? ''),
    );
    check('resize reaches the shell (stty size reports 40 100)', resized);

    // --- a viewer with no declared size must not resize anything -----------

    const sizedBefore = await client.get(session.id);
    const watcher = await PtydClient.connect(socketFile, {});
    await watcher.subscribe(session.id);
    await sleep(200);
    const sizedAfter = await client.get(session.id);
    check(
      'attaching without declaring a size leaves the session alone',
      sizedAfter.cols === sizedBefore.cols && sizedAfter.rows === sizedBefore.rows,
      `${sizedBefore.cols}x${sizedBefore.rows} -> ${sizedAfter.cols}x${sizedAfter.rows}`,
    );

    await watcher.resize(session.id, 0, 0);
    await sleep(200);
    const afterZero = await client.get(session.id);
    check(
      'a zero-sized resize is ignored rather than clamped to a 2x1 shell',
      afterZero.cols === sizedBefore.cols && afterZero.rows === sizedBefore.rows,
      `became ${afterZero.cols}x${afterZero.rows}`,
    );
    watcher.close();

    // --- foreground process detection --------------------------------------

    client.sendInput(session.id, 'sleep 4\n');
    const sawSleep = await waitFor(
      'foreground process to become sleep',
      () => events.some((e) => e.ev === 'proc' && e.fgProc === 'sleep'),
      6000,
    );
    check('foreground process is detected as sleep', sawSleep);

    // --- the core promise: viewers are disposable --------------------------

    client.close();
    await sleep(300);
    check('shell survives its viewer disconnecting', isAlive(session.pid));

    const client2 = await PtydClient.connect(socketFile, { onOutput: append });
    const list = await client2.list();
    check('session still listed after reconnect', list.some((s) => s.id === session.id));

    output.set(session.id, '');
    await client2.subscribe(session.id, { cols: 100, rows: 40 });
    const restored = await waitFor('snapshot replay', () =>
      (output.get(session.id) ?? '').includes('hello-ptyhub'),
    );
    check('reconnect replays a snapshot containing earlier output', restored);

    // --- rename, kill, exit reporting --------------------------------------

    const renamed = await client2.rename(session.id, 'smoke-renamed');
    check('rename takes effect', renamed.name === 'smoke-renamed');

    const lifecycleEvents: Event[] = [];
    const client3 = await PtydClient.connect(socketFile, {
      onEvent: (evt) => lifecycleEvents.push(evt),
    });

    // --- locking is enforced here, not in the UI ---------------------------

    const lockedMeta = await client2.setLock(session.id, true);
    check('setLock marks the session locked', lockedMeta.locked === true);
    check(
      'the lock is announced to other clients',
      await waitFor('locked event', () =>
        lifecycleEvents.some((e) => e.ev === 'locked' && e.id === session.id && e.locked),
      ),
    );
    check(
      'the lock shows up in the session list',
      (await client3.list()).find((s) => s.id === session.id)?.locked === true,
    );

    let refused = false;
    try {
      await client2.kill(session.id);
    } catch (err) {
      refused = err instanceof PtydError && err.code === 'session_locked';
    }
    check('a locked session refuses to be closed', refused);
    check('the shell is untouched by the refused close', isAlive(session.pid));

    await client2.setLock(session.id, false);
    check(
      'unlocking is announced too',
      await waitFor('unlocked event', () =>
        lifecycleEvents.some(
          (e) => e.ev === 'locked' && e.id === session.id && e.locked === false,
        ),
      ),
    );

    // Re-lock so the force path is exercised against a real lock.
    await client2.setLock(session.id, true);

    // Closing something is one action: it goes away rather than lingering as a
    // corpse the user has to dismiss separately.
    await client2.kill(session.id, 'SIGKILL', true);
    check(
      'force closes a locked session',
      await waitFor('removed event', () =>
        lifecycleEvents.some((e) => e.ev === 'removed' && e.id === session.id),
      ),
    );
    await sleep(200);
    check('shell process is gone', !isAlive(session.pid));
    check(
      'a closed session is gone from the list',
      (await client3.list()).every((s) => s.id !== session.id),
    );

    // A session that ends by itself is kept, because then the exit status is
    // the interesting part.
    const selfExiting = await client3.create({
      name: 'self-exit',
      argv: ['/bin/sh', '-c', 'exit 3'],
    });
    check(
      'a session that exits on its own stays listed',
      await waitFor('self exit', async () => {
        const found = (await client3.list()).find((s) => s.id === selfExiting.id);
        return found !== undefined && found.alive === false && found.exitCode === 3;
      }),
    );
    await client3.kill(selfExiting.id);
    check(
      'closing an exited session removes it',
      (await client3.list()).every((s) => s.id !== selfExiting.id),
    );

    const stats = await client3.stats();
    check('stats reports the daemon pid', stats.pid === ptyd.pid);

    client2.close();
    client3.close();

    // --- a viewer that cannot keep up is disconnected, not silently desynced --
    //
    // Regression coverage for a real bug: the old behaviour just skipped
    // output past a backlog threshold and kept the connection open as if
    // nothing had happened. For a full-screen program that gap can never be
    // recovered — the client's rendered screen permanently diverges from
    // ptyd's own headless copy, with nothing in the protocol able to detect
    // it. Disconnecting instead forces the client back through subscribe,
    // which always replays a correct, complete snapshot.
    {
      const bpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhub-bp-'));
      const bpEnv = {
        ...process.env,
        XDG_CONFIG_HOME: path.join(bpTmp, 'config'),
        XDG_STATE_HOME: path.join(bpTmp, 'state'),
        XDG_RUNTIME_DIR: path.join(bpTmp, 'run'),
        // Shrunk so a small, fast burst of output triggers the same condition
        // that would otherwise need megabytes of real, unread traffic.
        PTYHUB_MAX_SOCKET_BACKLOG: '4096',
      };
      fs.mkdirSync(bpEnv.XDG_RUNTIME_DIR, { recursive: true });
      const bpSocketFile = path.join(bpEnv.XDG_RUNTIME_DIR, 'ptyhub', 'ptyd.sock');

      const bpPtyd = spawn(process.execPath, ['--import', 'tsx', 'src/ptyd/index.ts'], {
        cwd: root,
        env: bpEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bpLog = '';
      bpPtyd.stderr?.on('data', (c: Buffer) => {
        bpLog += c.toString();
      });

      try {
        await waitFor('backpressure ptyd socket', () => fs.existsSync(bpSocketFile), 20000);

        const bpClient = await PtydClient.connect(bpSocketFile);
        const bpSession = await bpClient.create({
          name: 'bp-test',
          argv: ['/bin/sh'],
          cols: 80,
          rows: 24,
        });

        // A second, independent viewer that subscribes but never reads a
        // single byte back — standing in for a suspended phone or a wedged
        // SSH tunnel. Deliberately raw `net.Socket`, no 'data' listener and no
        // .resume(): it stays paused, so replies and PTY output pile up
        // unread on ptyd's side of the connection.
        const stuck = net.connect(bpSocketFile);
        await new Promise<void>((resolve, reject) => {
          stuck.once('connect', () => resolve());
          stuck.once('error', reject);
        });
        stuck.write(
          encodeJson({ t: 'req', rid: 1, op: 'subscribe', id: bpSession.id, snapshot: false }),
        );

        // Comfortably more than 4 KB, fast, from a single line of input.
        bpClient.sendInput(bpSession.id, 'yes | head -c 2000000\n');

        // The property that actually matters: ptyd forgets about a stalled
        // subscriber promptly, on its own, regardless of whether that client
        // ever notices. A socket that is truly never read from (as opposed to
        // a real client, which always reads at least via its own control
        // loop) can sit there indefinitely without locally observing the
        // remote close — Node/the kernel do not surface it without an attempt
        // to read or write — so the session's own viewer count is the
        // reliable, deterministic signal, not the dead client's socket state.
        check(
          'ptyd drops the stalled viewer from the session promptly',
          await waitFor(
            'viewer count to fall',
            async () => (await bpClient.get(bpSession.id)).viewers === 0,
            5000,
          ),
        );
        check('ptyd logs why it disconnected the stuck viewer', bpLog.includes('not draining'));

        // The dead client does find out, the moment it tries to do anything
        // with the connection — exactly what a real viewer's own control
        // traffic (a resize, a ping) would trigger before long.
        const wroteAfterDrop = await new Promise<boolean>((resolve) => {
          stuck.write('probe-after-drop', (err) => resolve(!err));
        });
        check(
          "the dead connection surfaces an error as soon as it's used again",
          !wroteAfterDrop,
        );

        // The session itself, and a normal viewer, are unaffected by the
        // other viewer's disconnection.
        const output = { text: '' };
        const healthy = await PtydClient.connect(bpSocketFile, {
          onOutput: (_id, data) => {
            output.text += data.toString('utf8');
          },
        });
        await healthy.subscribe(bpSession.id, { snapshot: false });
        healthy.sendInput(bpSession.id, '\x03'); // stop the `yes` flood first
        await sleep(300);
        healthy.sendInput(bpSession.id, 'echo still-alive\n');
        check(
          'the session and a well-behaved viewer are unaffected',
          await waitFor('still-alive output', () => output.text.includes('still-alive'), 8000),
        );

        healthy.close();
        bpClient.close();
        stuck.destroy();
      } finally {
        bpPtyd.kill('SIGTERM');
        await waitFor('backpressure ptyd exit', () => bpPtyd.exitCode !== null, 5000);
        fs.rmSync(bpTmp, { recursive: true, force: true });
      }
    }

    // --- shutdown -----------------------------------------------------------

    ptyd.kill('SIGTERM');
    const stopped = await waitFor('ptyd exit', () => ptyd.exitCode !== null, 8000);
    check('ptyd shuts down on SIGTERM', stopped);
    check('socket file is removed on shutdown', !fs.existsSync(socketFile));
  } finally {
    cleanup();
  }

  summary(`--- ptyd log ---\n${daemonLog}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

await main();
