/**
 * End-to-end test for the local command line.
 *
 * `attach` and the picker both need a real terminal on stdin, so the CLI is run
 * inside a PTY of its own — the same way a person runs it. That exercises raw
 * mode, the detach sequence and window-size forwarding for real.
 *
 *   npx tsx scripts/smoke-cli.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { PtydClient } from '../src/shared/ptyd-client.ts';
import { check, launch, makeSandbox, root, sleep, summary, waitFor } from './harness.ts';

const BIN = path.join(root, 'bin', 'ptyhub.mjs');

/** Run a CLI command without a terminal and collect its output. */
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = ptySpawn(process.execPath, [BIN, ...args], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: root,
      env: env as Record<string, string>,
    });
    let out = '';
    child.onData((d) => {
      out += d;
    });
    child.onExit(() => resolve(out));
  });
}

interface Interactive {
  pty: IPty;
  text: () => string;
  send: (data: string) => void;
  waitForText: (needle: string, timeoutMs?: number) => Promise<boolean>;
  exited: () => boolean;
}

function runInteractive(args: string[], env: NodeJS.ProcessEnv): Interactive {
  const pty = ptySpawn(process.execPath, [BIN, ...args], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: root,
    env: env as Record<string, string>,
  });
  let out = '';
  let done = false;
  pty.onData((d) => {
    out += d;
  });
  pty.onExit(() => {
    done = true;
  });
  return {
    pty,
    text: () => out,
    send: (data) => pty.write(data),
    exited: () => done,
    waitForText: (needle, timeoutMs = 10000) =>
      waitFor(`cli output ${JSON.stringify(needle)}`, () => out.includes(needle), timeoutMs),
  };
}

async function main(): Promise<void> {
  const sandbox = makeSandbox('cli');
  fs.writeFileSync(
    sandbox.configFile,
    JSON.stringify({ bind: '127.0.0.1', port: 7999, procPollMs: 1000 }, null, 2),
  );

  process.stdout.write(`cli smoke test\n  workdir ${sandbox.dir}\n\n`);

  const ptyd = launch('src/ptyd/index.ts', sandbox.env);
  await waitFor('ptyd socket', () => fs.existsSync(sandbox.socketFile), 20000);

  try {
    // --- plain commands ----------------------------------------------------

    const emptyList = await runCli(['ls'], sandbox.env);
    check('ls says so when there are no sessions', /no sessions/.test(emptyList), emptyList.trim());

    const client = await PtydClient.connect(sandbox.socketFile);
    const session = await client.create({ name: 'cli-test', argv: ['/bin/sh'], cols: 100, rows: 30 });

    const listed = await runCli(['ls'], sandbox.env);
    check(
      'ls shows a session created elsewhere',
      listed.includes('cli-test') && listed.includes(session.id),
      listed.trim(),
    );

    const status = await runCli(['status'], sandbox.env);
    check('status reports ptyd running', /ptyd\s+running/.test(status), status.trim());
    check('status reports the access token path', /access token/.test(status));

    const link = await runCli(['link'], sandbox.env);
    check('link prints a pairing URL', /http:\/\/[^\s]+\/#k=/.test(link), link.trim());

    const renamed = await runCli(['rename', session.id, 'renamed-by-cli'], sandbox.env);
    check('rename works by id', /renamed to renamed-by-cli/.test(renamed), renamed.trim());

    const byPrefix = await runCli(['rename', session.id.slice(0, 5), 'by-prefix'], sandbox.env);
    check('a session can be addressed by id prefix', /by-prefix/.test(byPrefix), byPrefix.trim());

    // --- locking from the command line -------------------------------------

    const locked = await runCli(['lock', session.id], sandbox.env);
    check('lock reports success', /is locked/.test(locked), locked.trim());

    const listedLocked = await runCli(['ls'], sandbox.env);
    check('ls marks a locked session', listedLocked.includes('🔒'), listedLocked.trim());

    const refusedKill = await runCli(['kill', session.id], sandbox.env);
    check(
      'kill refuses a locked session and says how to proceed',
      /is locked/.test(refusedKill) && /--force/.test(refusedKill),
      refusedKill.trim(),
    );
    check(
      'the refused kill left the session alone',
      (await client.list()).some((s) => s.id === session.id),
    );

    const unlocked = await runCli(['unlock', session.id], sandbox.env);
    check('unlock reports success', /is unlocked/.test(unlocked), unlocked.trim());

    // --- attach in a real terminal -----------------------------------------

    const attached = runInteractive(['attach', session.id], sandbox.env);
    check('attach announces itself', await attached.waitForText('attached to'));

    attached.send('echo cli-hello\n');
    check('typing in the attached terminal reaches the shell', await attached.waitForText('cli-hello'));

    // The web UI and the CLI are looking at the same session.
    client.sendInput(session.id, 'echo from-the-other-side\n');
    check(
      'output from another viewer shows up here too',
      await attached.waitForText('from-the-other-side'),
    );

    // Resizing the local terminal resizes the shared session.
    attached.pty.resize(70, 20);
    await sleep(400);
    const afterResize = await client.get(session.id);
    check(
      'resizing the local terminal resizes the session',
      afterResize.cols === 70 && afterResize.rows === 20,
      `${afterResize.cols}x${afterResize.rows}`,
    );

    // Ctrl+\ twice sends one literal byte instead of detaching.
    attached.send('\x1c\x1c');
    await sleep(200);
    check('the detach prefix pressed twice does not detach', !attached.exited());

    attached.send('\x03'); // clear the half-typed line
    await sleep(150);
    attached.send('\x1c' + 'd');
    check('Ctrl+\\ then d detaches', await attached.waitForText('still running', 8000));
    check('the CLI exits after detaching', await waitFor('cli exit', () => attached.exited(), 5000));

    const survived = await client.get(session.id);
    check('the session is still alive after detaching', survived.alive);

    // --- the picker ---------------------------------------------------------

    const tui = runInteractive([], sandbox.env);
    check('the picker lists sessions', await tui.waitForText('by-prefix'));
    check('the picker shows its key help', await tui.waitForText('enter attach'));

    tui.send('n');
    await sleep(300);
    check('n asks for a name', await tui.waitForText('name for the new terminal'));
    tui.send('from-tui\r');
    check('the new session appears in the list', await tui.waitForText('from-tui'));

    tui.send('q');
    check('q leaves the picker', await waitFor('picker exit', () => tui.exited(), 5000));

    const finalList = await client.list();
    check(
      'the session created in the picker really exists',
      finalList.some((s) => s.name === 'from-tui'),
      finalList.map((s) => s.name).join(', '),
    );

    client.close();
  } finally {
    ptyd.stop();
    await sleep(300);
    sandbox.cleanup();
  }

  summary(`--- ptyd ---\n${ptyd.logs()}`);
}

await main();
