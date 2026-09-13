/**
 * Browser end-to-end test.
 *
 * Drives the real UI in headless Chromium against a real gateway and a real
 * ptyd. This is the only place that can prove the parts users actually touch:
 * the terminal renders, typing reaches the shell, resizing the window resizes
 * the shell, reloading the page restores the screen, and the shortcuts work.
 *
 *   npm run build && npx tsx scripts/smoke-ui.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { check, launch, makeSandbox, root, sleep, summary, waitFor, freePort } from './harness.ts';

const SHOT_DIR = path.join(root, '.screenshots');

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hub = (window as any).__ptyhub;
    return hub.ids().map((id: string) => hub.read(id)).join('\n');
  });
}

/**
 * Size of the terminal the user is looking at. Reading `ids()[0]` instead would
 * pick up a terminal that is no longer mounted in any pane, and an unmounted
 * terminal never resizes — which looks exactly like a resize bug.
 */
async function activeSize(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const hub = (window as any).__ptyhub;
    const id = hub.active();
    return id ? hub.size(id) : null;
  });
}

async function waitForText(page: Page, needle: string, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await terminalText(page)).includes(needle)) return true;
    await sleep(120);
  }
  return false;
}

/**
 * Drag from one point to another with real pointer events.
 *
 * Playwright's `dragTo` drives HTML5 drag-and-drop, which this UI deliberately
 * does not use — and it would not let us assert on the drop indicator halfway
 * through, which is where the zone logic actually lives.
 */
async function dragFromTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  midway?: () => Promise<void>,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several steps: the first few pixels only arm the drag, and the UI needs a
  // frame or two to hit-test and paint the indicator.
  await page.mouse.move(from.x + 12, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await sleep(220);
  if (midway) await midway();
  await page.mouse.up();
  await sleep(350);
}

async function centerOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function tabNames(page: Page): Promise<string[]> {
  return page.locator('.tab .tab-name').allTextContents();
}

/**
 * Dispatch a synthetic keydown directly to the document.
 *
 * Real key presses for combos like Ctrl+W go through the browser's own
 * accelerator table first, which is exactly the behaviour the direct-shortcut
 * feature is opting out of (or into, in an app-mode window) — but it makes
 * `page.keyboard.press` an unreliable way to test our handler, since a real
 * browser might act on the combo before our JavaScript ever sees it. A
 * synthetic event dispatched straight to the document exercises our listener
 * deterministically, independent of what a real OS/browser would do with it.
 */
async function dispatchChord(
  page: Page,
  opts: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean },
): Promise<void> {
  await page.evaluate((o) => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: o.key,
        ctrlKey: !!o.ctrl,
        altKey: !!o.alt,
        shiftKey: !!o.shift,
        metaKey: !!o.meta,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, opts);
  await sleep(250);
}

/**
 * Leader chord followed by a key, the way a user would press it.
 *
 * Ctrl+Backslash, not Ctrl+Space: the latter is the input-method toggle on
 * every desktop OS and never reaches the page for anyone typing CJK.
 */
async function leader(page: Page, key: string): Promise<void> {
  await page.keyboard.press('Control+Backslash');
  await sleep(60);
  await page.keyboard.press(key);
  await sleep(220);
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(root, 'public', 'index.html'))) {
    process.stderr.write('build the UI first: npm run build\n');
    process.exit(1);
  }

  const sandbox = makeSandbox('ui');
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    sandbox.configFile,
    JSON.stringify({ bind: '127.0.0.1', port, procPollMs: 1000 }, null, 2),
  );
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // If this machine has already run `ptyhub fetch-font nerd`, copy the font
  // into the sandbox so the font-loading path can be exercised for real.
  const realFonts = path.join(
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '', '.local', 'state'),
    'ptyhub',
    'fonts',
  );
  const sandboxFonts = path.join(sandbox.env.XDG_STATE_HOME!, 'ptyhub', 'fonts');
  let nerdFontAvailable = false;
  if (fs.existsSync(path.join(realFonts, 'JetBrainsMonoNerdFont-Regular.ttf'))) {
    fs.mkdirSync(sandboxFonts, { recursive: true });
    for (const file of fs.readdirSync(realFonts)) {
      fs.copyFileSync(path.join(realFonts, file), path.join(sandboxFonts, file));
    }
    nerdFontAvailable = true;
  }

  process.stdout.write(`browser smoke test\n  ${origin}\n\n`);

  const ptyd = launch('src/ptyd/index.ts', sandbox.env);
  await waitFor('ptyd socket', () => fs.existsSync(sandbox.socketFile), 20000);
  const web = launch('src/web/index.ts', sandbox.env);
  await waitFor('gateway', () => /listening on/.test(web.logs()), 20000);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  // Dark is the default posture of the app, and headless Chromium reports light
  // unless told otherwise; emulate a dark desktop so the theme tests exercise
  // the palette people will actually see.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  // The test deliberately stops the gateway, and the browser logs a network
  // error for every socket that was open at the time. Those are the browser
  // reporting reality, not the app misbehaving; the reconnect assertions below
  // are what prove we handled them.
  const expectedDuringOutage = /WebSocket connection to|ERR_CONNECTION_REFUSED|Failed to fetch/;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !expectedDuringOutage.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    // First visit carries the access token in the URL fragment, exactly as a
    // user would after running `ptyhub link`. Later reloads use the cookie.
    const tokenFile = path.join(sandbox.env.XDG_STATE_HOME!, 'ptyhub', 'token.json');
    await waitFor('access token', () => fs.existsSync(tokenFile), 10000);
    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token as string;

    await page.goto(`${origin}/#k=${token}`, { waitUntil: 'domcontentloaded' });

    // --- first load creates a session with no empty state ------------------

    const gotTerminal = await page
      .waitForSelector('.xterm-screen', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check('a terminal appears on first load without being asked', gotTerminal);
    if (!gotTerminal) return;

    check(
      'the access token is scrubbed from the address bar',
      !page.url().includes('#k='),
      page.url(),
    );

    check(
      'exactly one tab is open',
      (await page.locator('.tab').count()) === 1,
    );

    check(
      'the terminal socket reaches the open state',
      await waitFor(
        'socket open',
        async () =>
          (await page.evaluate(() => {
            const hub = (window as any).__ptyhub;
            return hub.state(hub.active());
          })) === 'open',
        10000,
      ),
    );

    await page.click('.pane-slot');
    await sleep(400);

    // --- typing ------------------------------------------------------------

    await page.keyboard.type('echo browser-hello\n');
    check('typing in the browser reaches the shell', await waitForText(page, 'browser-hello'));

    // --- resize follows the window ----------------------------------------

    const before = await activeSize(page);
    check(
      'the terminal fills the window rather than its own content',
      !!before && before.rows > 20 && before.cols > 80,
      `${before?.cols}×${before?.rows} in a 1280×800 window`,
    );

    await page.setViewportSize({ width: 760, height: 600 });
    await sleep(700);
    const after = await activeSize(page);
    check(
      'resizing the window resizes the terminal',
      !!before && !!after && after.cols < before.cols,
      `${before?.cols} -> ${after?.cols} columns`,
    );

    await page.keyboard.type('stty size\n');
    // Compare against the size as it stands each time we look: the terminal may
    // still be settling, and asserting against a stale snapshot is a flake.
    const reported = await waitFor(
      'stty size matching the terminal',
      async () => {
        const size = await activeSize(page);
        if (!size) return false;
        return (await terminalText(page)).includes(`${size.rows} ${size.cols}`);
      },
      12000,
    );
    check('the shell itself sees the new size', reported, `terminal is ${JSON.stringify(await activeSize(page))}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(500);

    // --- reload restores the screen ---------------------------------------

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20000 });
    check(
      'reloading the page restores the earlier output',
      await waitForText(page, 'browser-hello'),
    );

    // --- full-screen program survives a reload ----------------------------

    await page.click('.pane-slot');
    await page.keyboard.type('printf "\\033[2J\\033[H"; printf "TOP-LEFT"; tput cup 5 10; printf "MIDDLE-MARK"\n');
    await sleep(600);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20000 });
    check(
      'a redrawn screen comes back intact after reload',
      await waitForText(page, 'MIDDLE-MARK'),
    );

    // --- keyboard shortcuts -------------------------------------------------

    await page.click('.pane-slot');
    await leader(page, 'c');
    check(
      'leader C opens a second terminal',
      await waitFor('second tab', async () => (await page.locator('.tab').count()) === 2, 8000),
    );

    await leader(page, '|');
    check(
      'leader | splits the view',
      await waitFor('two panes', async () => (await page.locator('.pane').count()) === 2, 4000),
    );

    // A split pane must be closable by pointer. Before this, a pane with no
    // terminal in it had no visible control at all and could only be closed by
    // a shortcut the user might not have working.
    check(
      'a split pane shows a close button',
      await page.locator('.pane-tool.danger').first().isVisible(),
    );
    check(
      'an empty pane offers to close itself',
      await page.locator('.empty-actions .btn.danger').first().isVisible(),
    );
    await page.locator('.empty-actions .btn.danger').first().click();
    check(
      'that button closes the pane',
      await waitFor('one pane', async () => (await page.locator('.pane').count()) === 1, 4000),
    );

    await leader(page, '|');
    await waitFor('two panes', async () => (await page.locator('.pane').count()) === 2, 4000);
    await page.locator('.pane-tool.danger').last().click();
    check(
      'the pane toolbar close button works too',
      await waitFor('one pane', async () => (await page.locator('.pane').count()) === 1, 4000),
    );

    await leader(page, '|');
    await waitFor('two panes', async () => (await page.locator('.pane').count()) === 2, 4000);
    await leader(page, 'w');
    check(
      'leader W closes the pane again',
      await waitFor('one pane', async () => (await page.locator('.pane').count()) === 1, 4000),
    );

    // Closing a terminal is one click, not two.
    const tabsBefore = await page.locator('.tab').count();
    await page.locator('.tab.active .tab-close').click();
    check(
      'closing a terminal takes a single click',
      await waitFor(
        'tab to disappear',
        async () => (await page.locator('.tab').count()) === tabsBefore - 1,
        6000,
      ),
      `${tabsBefore} tabs before`,
    );

    // --- closing a terminal returns to whichever one you looked at before it,
    // not whichever happens to be oldest ----------------------------------

    // Three throwaway terminals, visited out of creation order, so recency and
    // creation order disagree about which one should reappear.
    await leader(page, 'c');
    await waitFor('tab A', async () => (await page.locator('.tab').count()) === 2, 6000);
    const idA = await page.locator('.tab').nth(1).getAttribute('data-tab-id');
    await leader(page, 'c');
    await waitFor('tab B', async () => (await page.locator('.tab').count()) === 3, 6000);
    const idB = await page.locator('.tab').nth(2).getAttribute('data-tab-id');
    await leader(page, 'c');
    await waitFor('tab C', async () => (await page.locator('.tab').count()) === 4, 6000);
    const idC = await page.locator('.tab').nth(3).getAttribute('data-tab-id');

    // Visit order: A, then C, then B. B ends up active; C — not A, the oldest
    // survivor — is what "last visited before this one" actually means here.
    await page.locator(`[data-tab-id="${idA}"]`).click();
    await sleep(150);
    await page.locator(`[data-tab-id="${idC}"]`).click();
    await sleep(150);
    await page.locator(`[data-tab-id="${idB}"]`).click();
    await sleep(150);

    await page.locator(`[data-tab-id="${idB}"] .tab-close`).click();
    await sleep(400);
    const afterClose = await page.evaluate(() => (window as any).__ptyhub.active());
    check(
      'closing the active terminal reveals the one visited just before it',
      afterClose === idC,
      `landed on ${afterClose}, expected ${idC} (oldest survivor was ${idA})`,
    );

    // Clean up the remaining two throwaway tabs.
    await page.locator(`[data-tab-id="${idC}"] .tab-close`).click();
    await sleep(300);
    await page.locator(`[data-tab-id="${idA}"] .tab-close`).click();
    await waitFor('back to one tab', async () => (await page.locator('.tab').count()) === 1, 4000);

    await leader(page, 'k');
    const paletteOpen = await page.locator('.palette').isVisible().catch(() => false);
    check('leader K opens the command palette', paletteOpen);
    await page.keyboard.press('Escape');
    await sleep(150);

    await leader(page, ',');
    const settingsVisible = await page.locator('.settings').isVisible().catch(() => false);
    check('leader , opens settings', settingsVisible);
    // Settings' own backdrop covers the whole viewport, tab strip included;
    // close it before touching anything in the tab bar.
    await page.keyboard.press('Escape');
    await sleep(250);

    // --- leader digit shortcuts survive a real server round trip -----------

    // Regression coverage for a bug the direct-shortcut work below turned up:
    // the keymap validated stored bindings against the command-palette display
    // list, which leaves out select-session-1..9, so every digit binding — on
    // the leader AND, once added, the direct layer — was silently stripped the
    // first time the keymap crossed the network. `keymap.value` here already
    // went through exactly that round trip during boot().
    await leader(page, 'c');
    await waitFor(
      'a second tab for leader-digit switching',
      async () => (await page.locator('.tab').count()) === 2,
      8000,
    );
    const digitTargetId = await page.locator('.tab').nth(0).getAttribute('data-tab-id');
    await leader(page, '1');
    await sleep(300);
    const afterLeaderDigit = await page.evaluate(() => (window as any).__ptyhub.active());
    check(
      'leader 1 switches to the first terminal after a real save/load round trip',
      afterLeaderDigit === digitTargetId,
      `${afterLeaderDigit} vs ${digitTargetId}`,
    );
    await page.locator('.tab').last().locator('.tab-close').click();
    await waitFor('back to one tab', async () => (await page.locator('.tab').count()) === 1, 4000);

    // --- master switch and Mac-style direct shortcuts -----------------------

    await page.click('button[title="Settings"]');
    await sleep(200);
    await page.click('.settings-tab:has-text("Keyboard")');
    await sleep(200);
    check(
      'the master switch and Mac-style toggle are both in Settings',
      (await page.locator('.setting:has-text("Enable keyboard shortcuts")').count()) === 1 &&
        (await page.locator('.setting:has-text("Enable Mac-style shortcuts")').count()) === 1,
    );
    // The gear button opens Settings but cannot close it: the panel's own
    // full-screen backdrop sits on top of the topbar and swallows the click.
    // Escape is the way out, and it works regardless of the master switch.
    await page.keyboard.press('Escape');
    await sleep(300);

    // A throwaway tab so this section cannot disturb the sessions later parts
    // of the run depend on.
    await leader(page, 'c');
    await waitFor(
      'throwaway tab',
      async () => (await page.locator('.tab').count()) >= 1,
      6000,
    );
    const tabsAtStart = await page.locator('.tab').count();

    check(
      'Mac-style shortcuts are off by default, so ⌘W does nothing in a plain tab',
      await (async () => {
        await dispatchChord(page, { key: 'w', meta: true });
        return (await page.locator('.tab').count()) === tabsAtStart;
      })(),
    );

    // Turn the direct layer on.
    await page.click('button[title="Settings"]');
    await sleep(200);
    await page.click('.settings-tab:has-text("Keyboard")');
    await page.locator('.setting:has-text("Enable Mac-style shortcuts") .toggle').click();
    await page.keyboard.press('Escape');
    await sleep(300);

    await page.click('.pane-slot');
    check(
      '⌘W closes the current terminal once Mac-style shortcuts are on',
      await (async () => {
        await dispatchChord(page, { key: 'w', meta: true });
        return waitFor(
          'tab count to drop',
          async () => (await page.locator('.tab').count()) === tabsAtStart - 1,
          4000,
        );
      })(),
    );

    // Ctrl+W must do nothing: bash/readline/vim already use Ctrl+<key> for
    // line editing (Ctrl+W deletes a word), so the direct layer only ever
    // binds Cmd by default — auto-binding Ctrl too would fight the shell.
    await leader(page, 'c');
    await waitFor('a tab for the Ctrl check', async () => (await page.locator('.tab').count()) >= 1, 6000);
    const tabsForCtrlCheck = await page.locator('.tab').count();
    await page.click('.pane-slot');
    await dispatchChord(page, { key: 'w', ctrl: true });
    await sleep(400);
    check(
      'Ctrl+W does not close a terminal, only ⌘W does',
      (await page.locator('.tab').count()) === tabsForCtrlCheck,
    );
    // Clean up the throwaway tab this check needed, via the UI itself since
    // Ctrl+W correctly failed to do it.
    await page.locator('.tab.active .tab-close').click();
    await waitFor(
      'back to the tab count before the Ctrl+W check',
      async () => (await page.locator('.tab').count()) === tabsForCtrlCheck - 1,
      4000,
    );

    // ⌘1 / ⌘2 jump straight to a terminal by position, no leader required.
    await leader(page, 'c');
    await waitFor('second tab for switching', async () => (await page.locator('.tab').count()) === 2, 6000);
    const idAtSlot1 = await page.locator('.tab').nth(0).getAttribute('data-tab-id');
    await dispatchChord(page, { key: '2', meta: true });
    await sleep(200);
    const afterMeta2 = await page.evaluate(() => (window as any).__ptyhub.active());
    const idAtSlot2 = await page.locator('.tab').nth(1).getAttribute('data-tab-id');
    check('⌘2 switches directly to the second terminal', afterMeta2 === idAtSlot2, `${afterMeta2} vs ${idAtSlot2}`);
    await dispatchChord(page, { key: '1', meta: true });
    await sleep(200);
    const afterMeta1 = await page.evaluate(() => (window as any).__ptyhub.active());
    check('⌘1 switches back to the first terminal', afterMeta1 === idAtSlot1, `${afterMeta1} vs ${idAtSlot1}`);

    // The master switch gates the direct layer too, not just the leader.
    await page.click('button[title="Settings"]');
    await sleep(200);
    await page.click('.settings-tab:has-text("Keyboard")');
    await page.locator('.setting:has-text("Enable keyboard shortcuts") .toggle').click();
    await page.keyboard.press('Escape');
    await sleep(300);

    const tabsWithMasterOff = await page.locator('.tab').count();
    await page.click('.pane-slot');
    await page.keyboard.press('Control+Backslash');
    await sleep(300);
    check(
      'the master switch off stops the leader from arming',
      (await page.locator('.leader-hint').count()) === 0,
    );
    await dispatchChord(page, { key: 'w', meta: true });
    check(
      'the master switch off also disables the Mac-style layer',
      (await page.locator('.tab').count()) === tabsWithMasterOff,
    );

    // Restore defaults so the remaining leader-based checks below keep working.
    await page.click('button[title="Settings"]');
    await sleep(200);
    await page.click('.settings-tab:has-text("Keyboard")');
    await page.locator('.setting:has-text("Enable keyboard shortcuts") .toggle').click();
    await page.locator('.setting:has-text("Enable Mac-style shortcuts") .toggle').click();
    await sleep(200);
    await page.keyboard.press('Escape');
    await sleep(300);

    // This section leaves one throwaway tab behind (the ⌘1/⌘2 target); close it
    // so the rest of the file starts from the single-tab state it expects.
    await page.locator('.tab').nth(1).locator('.tab-close').click();
    await waitFor('back to one tab', async () => (await page.locator('.tab').count()) === 1, 4000);

    // --- shortcut on/off is per device, not synced --------------------------

    // The server's own response is the strongest proof: it must not carry
    // enabled/direct at all, since those never leave the browser that set them.
    const rawKeymapResponse = await page.evaluate(async () => {
      const res = await fetch('/api/keymap', { credentials: 'same-origin' });
      return res.json();
    });
    check(
      'the server keymap response carries no on/off state',
      !('enabled' in rawKeymapResponse.keymap) && !('direct' in rawKeymapResponse.keymap),
      JSON.stringify(Object.keys(rawKeymapResponse.keymap)),
    );

    // Turn Mac-style shortcuts on for this "device" (this browser context).
    await page.click('button[title="Settings"]');
    await sleep(200);
    await page.click('.settings-tab:has-text("Keyboard")');
    await page.locator('.setting:has-text("Enable Mac-style shortcuts") .toggle').click();
    await page.keyboard.press('Escape');
    await sleep(300);

    check(
      'the on/off state lives in localStorage, not a cookie or the server',
      await page.evaluate(() => localStorage.getItem('ptyhub.localShortcuts')?.includes('"direct":true') ?? false),
    );

    // A second, independent browser profile signing into the very same
    // account must NOT inherit that — it is a different device.
    const otherDevice = await browser.newContext();
    const otherPage = await otherDevice.newPage();
    await otherPage.goto(`${origin}/#k=${token}`, { waitUntil: 'domcontentloaded' });
    await otherPage.waitForSelector('.xterm-screen', { timeout: 20000 });
    await sleep(500);
    await otherPage.click('button[title="Settings"]');
    await sleep(200);
    await otherPage.click('.settings-tab:has-text("Keyboard")');
    await sleep(200);
    const otherDeviceDirectOn = await otherPage
      .locator('.setting:has-text("Enable Mac-style shortcuts") .toggle.on')
      .count();
    check(
      'a second device signing into the same account starts with its own defaults',
      otherDeviceDirectOn === 0,
    );
    await otherDevice.close();

    // Meanwhile the ORIGINAL device's choice survives a reload, because it
    // is sitting in that browser's own localStorage.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20000 });
    await sleep(600);
    await page.click('button[title="Settings"]');
    await sleep(200);
    await page.click('.settings-tab:has-text("Keyboard")');
    await sleep(200);
    check(
      "this device's own choice survives a reload",
      (await page.locator('.setting:has-text("Enable Mac-style shortcuts") .toggle.on').count()) === 1,
    );

    // Clean up: back to the default (off) so later checks in this file are
    // unaffected by the direct layer being on.
    await page.locator('.setting:has-text("Enable Mac-style shortcuts") .toggle').click();
    await page.keyboard.press('Escape');
    await sleep(300);

    // --- scrollback: the newest output, and a reachable scrollbar ----------

    // The settings check just above left the panel open; it covers the screen.
    await page.keyboard.press('Escape');
    await sleep(250);

    await page.click('.pane-slot');
    await page.keyboard.type('seq 1 300\n');
    check(
      'a long output produces scrollback',
      await waitForText(page, '300', 10000),
    );
    await sleep(600);

    const scrollInfo = async () =>
      page.evaluate(() => {
        const hub = (window as any).__ptyhub;
        return hub.scroll(hub.active());
      });

    // The canvas must stop short of the scrollbar. xterm paints the screen over
    // the viewport, so a grid sized to the full width hides the scrollbar
    // completely and it cannot be dragged.
    const geometry = await scrollInfo();
    check(
      'the terminal leaves room for its own scrollbar',
      geometry.gutter > 0 &&
        geometry.screenWidth <= geometry.viewportWidth - geometry.gutter + 1,
      `screen ${geometry.screenWidth}px, viewport ${geometry.viewportWidth}px, ` +
        `gutter ${geometry.gutter}px`,
    );
    // Whether that gutter holds a classic scrollbar or an overlay one is the
    // browser's business — this headless Chromium gives every scroll container
    // an overlay, even a plain div. The part that is ours, and the part that
    // was broken, is that the canvas no longer covers it.

    check('a fresh terminal sits at the newest output', (await scrollInfo()).atBottom);

    // Switching away and back must not jump to the top of the scrollback:
    // taking the node out of the DOM discards its scroll position.
    await leader(page, 'c');
    await waitFor('second tab', async () => (await page.locator('.tab').count()) === 2, 8000);
    await sleep(500);
    await page.locator('.tab').first().click();
    await sleep(800);
    const returned = await scrollInfo();
    check(
      'returning to a tab shows the newest output, not the top',
      returned.atBottom,
      JSON.stringify(returned),
    );

    // The root cause of the old jump: xterm's scroll position and the DOM
    // element's scrollTop drifted apart while the node was detached, and only
    // reconciled on the next wheel event.
    check(
      'the scroll position and the DOM scrollTop agree after returning',
      Math.abs(returned.scrollTop - returned.expectedScrollTop) <= 2,
      `scrollTop ${returned.scrollTop} vs expected ${returned.expectedScrollTop}`,
    );

    // And the symptom itself: one notch of the wheel must move by about one
    // notch, not fling the view somewhere else.
    const beforeWheel = await scrollInfo();
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, 120);
    await sleep(400);
    const afterWheel = await scrollInfo();
    check(
      'a wheel notch scrolls by a little, it does not jump',
      Math.abs(afterWheel.viewportY - beforeWheel.viewportY) <= 6,
      `viewportY ${beforeWheel.viewportY} -> ${afterWheel.viewportY}`,
    );

    // A deliberate scroll back should survive the same round trip.
    await page.evaluate(() => {
      const hub = (window as any).__ptyhub;
      hub.terminal(hub.active()).term.scrollToLine(5);
    });
    await sleep(300);
    await page.locator('.tab').last().click();
    await sleep(500);
    await page.locator('.tab').first().click();
    await sleep(800);
    const afterReturn = await scrollInfo();
    check(
      'a deliberate scroll position is kept across a tab switch',
      afterReturn.viewportY === 5,
      JSON.stringify(afterReturn),
    );

    // Back to the bottom for the rest of the run.
    await page.evaluate(() => {
      const hub = (window as any).__ptyhub;
      hub.terminal(hub.active()).term.scrollToBottom();
    });

    // --- lock, pin, and the tab menu ---------------------------------------

    // The scrollback section above already opened a second tab to switch to.
    check(
      'two tabs are open for the tab-bar tests',
      (await page.locator('.tab').count()) === 2,
    );

    const first = await centerOf(page, '.tab');
    await page.mouse.click(first.x, first.y, { button: 'right' });
    check(
      'right-clicking a tab opens its menu',
      await waitFor('menu', async () => page.locator('.tab-menu').isVisible(), 4000),
    );

    await page.locator('.menu-item', { hasText: 'Lock' }).first().click();
    check(
      'the tab shows as locked once locked',
      await waitFor(
        'locked class',
        async () => (await page.locator('.tab.locked').count()) === 1,
        6000,
      ),
    );

    const beforeLockedClose = await page.locator('.tab').count();
    await page.locator('.tab.locked .tab-close').click();
    await sleep(400);
    check(
      'clicking the lock icon unlocks the tab instead of closing it',
      (await page.locator('.tab').count()) === beforeLockedClose &&
        (await page.locator('.tab.locked').count()) === 0,
    );

    // Re-lock it so the pin/unlock-via-menu checks below see a locked tab.
    await page.mouse.click(first.x, first.y, { button: 'right' });
    await page.locator('.menu-item', { hasText: 'Lock' }).first().click();
    await waitFor('re-locked', async () => (await page.locator('.tab.locked').count()) === 1, 6000);

    await page.mouse.click(first.x, first.y, { button: 'right' });
    await page.locator('.menu-item', { hasText: 'Pin to front' }).first().click();
    await sleep(400);
    check(
      'pinning moves the tab to the front',
      (await page.locator('.tab').first().getAttribute('class'))?.includes('locked') === true,
    );

    // Unlock again so the rest of the run can close things normally.
    await page.mouse.click(
      (await centerOf(page, '.tab')).x,
      (await centerOf(page, '.tab')).y,
      { button: 'right' },
    );
    await page.locator('.menu-item', { hasText: 'Unlock' }).first().click();
    await sleep(300);
    await page.mouse.click(
      (await centerOf(page, '.tab')).x,
      (await centerOf(page, '.tab')).y,
      { button: 'right' },
    );
    await page.locator('.menu-item', { hasText: 'Unpin' }).first().click();
    await sleep(400);

    // --- dragging tabs -------------------------------------------------------

    const orderBefore = await tabNames(page);
    const firstTab = await centerOf(page, '.tab');
    const lastTabBox = await page.locator('.tab').last().boundingBox();
    await dragFromTo(
      page,
      firstTab,
      { x: lastTabBox!.x + lastTabBox!.width - 4, y: lastTabBox!.y + lastTabBox!.height / 2 },
      async () => {
        check(
          'dragging a tab shows a drop indicator in the strip',
          (await page.locator('.tab-insert').count()) > 0,
        );
      },
    );
    const orderAfter = await tabNames(page);
    check(
      'dragging a tab reorders the strip',
      orderAfter[orderAfter.length - 1] === orderBefore[0] && orderAfter.length === orderBefore.length,
      `${orderBefore.join(',')} -> ${orderAfter.join(',')}`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20000 });
    await sleep(600);
    check(
      'the new order survives a reload',
      (await tabNames(page)).join(',') === orderAfter.join(','),
      (await tabNames(page)).join(','),
    );

    // Drag a tab onto the right edge of the pane: it should split, with the
    // dragged terminal in the new right-hand half.
    const paneBox = (await page.locator('.pane').first().boundingBox())!;
    const dragTab = await centerOf(page, '.tab');
    await dragFromTo(
      page,
      dragTab,
      { x: paneBox.x + paneBox.width * 0.92, y: paneBox.y + paneBox.height / 2 },
      async () => {
        check(
          'dragging over a pane edge previews a split',
          (await page.locator('.drop-hint.right').count()) === 1,
        );
      },
    );
    check(
      'dropping on the edge splits the pane',
      await waitFor('two panes', async () => (await page.locator('.pane').count()) === 2, 5000),
    );

    const paneSessions = await page.evaluate(() =>
      [...document.querySelectorAll('[data-pane]')].map((p) =>
        p.querySelector('.pane-slot') ? 'terminal' : 'empty',
      ),
    );
    check(
      'the dragged terminal landed in the new right-hand pane',
      paneSessions[1] === 'terminal',
      paneSessions.join(','),
    );

    // Dragging a tab that was not on screen leaves the original pane alone —
    // one terminal moved, so one thing changed.
    check(
      'the pane that was already showing something keeps it',
      paneSessions[0] === 'terminal',
      paneSessions.join(','),
    );

    // Collapse back to one pane for the rest of the run.
    await page.locator('.pane-tool.danger').last().click();
    await waitFor('one pane', async () => (await page.locator('.pane').count()) === 1, 5000);
    await sleep(300);

    // --- theme and font settings apply live --------------------------------

    // The tab and pane work above dismissed the settings panel; open it again.
    if (!(await page.locator('.settings').isVisible().catch(() => false))) {
      await page.click('.pane-slot');
      await leader(page, ',');
    }
    const settingsReady = await page.locator('.settings').isVisible().catch(() => false);
    check('settings can be reopened after working in the tab bar', settingsReady);

    if (settingsReady) {
      await page.click('.theme-swatch[title="Tokyo Night"]');
      await sleep(300);
      const base = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--base').trim(),
      );
      check('choosing a theme repaints the interface', base === '#16161e', `--base = ${base}`);

      const bg = await page.evaluate(() => {
        const hub = (window as any).__ptyhub;
        return hub.terminal(hub.ids()[0]).term.options.theme.background;
      });
      check('the terminal picks up the same theme', bg === '#1a1b26', `terminal bg = ${bg}`);

      await page.click('.settings-tab:has-text("Font")');
      await sleep(200);
      const sizeBefore = await activeSize(page);
      await page.locator('.setting:has-text("Size on this") input[type=range]').fill('22');
      await sleep(800);
      const sizeAfter = await activeSize(page);
      check(
        'a bigger font means fewer columns',
        !!sizeBefore && !!sizeAfter && sizeAfter.cols < sizeBefore.cols,
        `${sizeBefore?.cols} -> ${sizeAfter?.cols} columns`,
      );

      await page.locator('.setting:has-text("Size on this") input[type=range]').fill('14');
      await sleep(500);

      // Canvas text does not trigger lazy @font-face loading, so the Nerd Font
      // has to be loaded explicitly or every glyph silently becomes a box.
      // Only meaningful where the font has actually been fetched.
      if (nerdFontAvailable) {
        await page.locator('.setting:has-text("Nerd Font glyphs") .toggle').click();
        const loaded = await waitFor(
          'nerd font to load',
          () => page.evaluate(() => document.fonts.check('14px "JetBrains Mono Nerd Font"')),
          15000,
        );
        check('enabling the Nerd Font actually loads the glyphs', loaded);
        await page.locator('.setting:has-text("Nerd Font glyphs") .toggle').click();
        await sleep(300);
      }

      await page.click('.settings-close');
      await sleep(200);
    }

    // --- preferences persist across a reload -------------------------------

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20000 });
    const baseAfterReload = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--base').trim(),
    );
    check('the chosen theme survives a reload', baseAfterReload === '#16161e');

    // --- sidebar visibility is per-device, and survives a reload -----------

    await page.click('[aria-label="Toggle sidebar"]');
    await sleep(150);
    check('hiding the sidebar removes it from the page', (await page.locator('.sidebar').count()) === 0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20000 });
    check(
      'the sidebar stays hidden after a reload',
      (await page.locator('.sidebar').count()) === 0,
    );

    await page.click('[aria-label="Toggle sidebar"]');
    await sleep(150);
    check('toggling it back on restores the sidebar', (await page.locator('.sidebar').count()) === 1);

    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop.png') });

    // --- gateway restart, from the browser's point of view -----------------

    web.stop();
    await waitFor('gateway stop', () => web.child.exitCode !== null, 8000);
    await sleep(600);
    const warned = await page.locator('.status-pill.warn, .status-pill.down').count();
    check('the status pill reports the gateway going away', warned > 0);

    const web2 = launch('src/web/index.ts', sandbox.env);
    await waitFor('gateway restart', () => /listening on/.test(web2.logs()), 20000);
    check(
      'the page reconnects on its own once it comes back',
      await waitFor(
        'reconnect',
        async () => (await page.locator('.status-pill.ok').count()) > 0,
        25000,
      ),
    );
    // Only visible sessions have a terminal attached, so bring each one up in
    // turn until the marker shows. The tab order has been shuffled by the drag
    // tests above, so "the first tab" is not the one we want.
    let found = false;
    const tabCount = await page.locator('.tab').count();
    for (let i = 0; i < tabCount && !found; i++) {
      await page.locator('.tab').nth(i).click();
      await sleep(400);
      found = await waitForText(page, 'MIDDLE-MARK', 6000);
    }
    check('the session was never touched by the restart', found);
    web2.stop();


    // --- phone and desktop sharing one session ------------------------------

    const web4 = launch('src/web/index.ts', sandbox.env);
    await waitFor('gateway for the shared test', () => /listening on/.test(web4.logs()), 20000);

    const sharedPhone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const sharedPage = await sharedPhone.newPage();
    await sharedPage.goto(`${origin}/#k=${token}`, { waitUntil: 'domcontentloaded' });
    await sharedPage.waitForSelector('.xterm-screen', { timeout: 20000 });

    // Put both devices on the same session.
    await page.locator('.tab').first().click();
    await sharedPage.locator('.tab').first().click();
    await sleep(800);
    const sharedId = await page.evaluate(() => (window as any).__ptyhub.active());
    const phoneId = await sharedPage.evaluate(() => (window as any).__ptyhub.active());
    check('both devices are looking at the same session', sharedId === phoneId, `${sharedId} vs ${phoneId}`);

    // Using the phone gives the phone a readable window, rather than leaving it
    // showing the desktop's geometry shrunk to a third of its size.
    await sharedPage.click('.pane-slot');
    const narrowed = await waitFor(
      'session to follow the phone',
      async () => {
        const size = await activeSize(sharedPage);
        return !!size && size.cols < 70;
      },
      10000,
    );
    const phoneCols = (await activeSize(sharedPage))?.cols;
    check('using the phone sizes the session for the phone', narrowed, `${phoneCols} columns`);

    // Going back to the desktop hands the size straight back.
    await page.click('.pane-slot');
    const restored = await waitFor(
      'session to follow the desktop again',
      async () => {
        const size = await activeSize(page);
        return !!size && size.cols > 90;
      },
      10000,
    );
    check(
      'going back to the desktop takes the size back',
      restored,
      `${(await activeSize(page))?.cols} columns`,
    );

    await sharedPhone.close();
    web4.stop();

    // --- mobile layout ------------------------------------------------------

    // Close the desktop so the phone below is genuinely the only viewer.
    await context.close();
    await sleep(400);

    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const web3 = launch('src/web/index.ts', sandbox.env);
    await waitFor('gateway for phone', () => /listening on/.test(web3.logs()), 20000);
    const phonePage = await phone.newPage();
    // A new device is a new context with no cookie, so it pairs with the token
    // the same way a phone would after scanning `ptyhub link --qr`.
    await phonePage.goto(`${origin}/#k=${token}`, { waitUntil: 'domcontentloaded' });
    await phonePage.waitForSelector('.xterm-screen', { timeout: 20000 });
    check('the phone layout shows the virtual key bar', await phonePage.locator('.vkeys').isVisible());
    check('the sidebar is hidden on a phone', (await phonePage.locator('.sidebar').count()) === 0);

    // A phone that is the only viewer must size the session for itself rather
    // than scaling somebody else's geometry down to nothing.
    await waitFor(
      'phone socket open',
      async () =>
        (await phonePage.evaluate(() => {
          const hub = (window as any).__ptyhub;
          return hub.state(hub.active());
        })) === 'open',
      10000,
    );
    await sleep(600);
    await phonePage.click('.pane-slot');
    await phonePage.keyboard.type('echo phone-hello\n');
    const phoneSize = await activeSize(phonePage);
    check(
      'a phone attached on its own sizes the shell to fit its screen',
      !!phoneSize && phoneSize.cols > 20 && phoneSize.cols < 70,
      `${phoneSize?.cols}x${phoneSize?.rows} on a 390px screen`,
    );
    check(
      'typing works from the virtual keyboard layout',
      await waitForText(phonePage, 'phone-hello'),
    );

    // The End key is a local scroll-to-bottom, not a byte sent to the shell —
    // needs real scrollback to scroll away from, then confirm it snaps back.
    await phonePage.keyboard.type('seq 1 200\n');
    await waitForText(phonePage, '200');
    await phonePage.evaluate(() => {
      const hub = (window as any).__ptyhub;
      hub.terminal(hub.active()).term.scrollToTop();
    });
    const phoneScrollInfo = await phonePage.evaluate(() => {
      const hub = (window as any).__ptyhub;
      return hub.scroll(hub.active());
    });
    check(
      'scrolling up leaves the phone view off the bottom',
      phoneScrollInfo?.atBottom === false,
      JSON.stringify(phoneScrollInfo),
    );
    await phonePage.locator('.vkey:has-text("End")').click();
    const backAtBottom = await waitFor(
      'phone view back at bottom',
      async () =>
        (await phonePage.evaluate(() => {
          const hub = (window as any).__ptyhub;
          return hub.scroll(hub.active())?.atBottom;
        })) === true,
      3000,
    );
    check('the End key on the mobile bar scrolls back to the bottom', backAtBottom);

    await phonePage.locator('.vkey:has-text("Esc")').click();
    await phonePage.screenshot({ path: path.join(SHOT_DIR, 'mobile.png') });
    web3.stop();

    check(
      'no uncaught errors in the console',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 4).join('\n       '),
    );
  } finally {
    await browser.close().catch(() => {});
    web.stop();
    ptyd.stop();
    await sleep(300);
    sandbox.cleanup();
  }

  process.stdout.write(`\nscreenshots in ${SHOT_DIR}\n`);
  summary(`--- ptyd ---\n${ptyd.logs()}\n--- web ---\n${web.logs()}`);
}

await main();
