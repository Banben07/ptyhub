/**
 * Application state.
 *
 * Signals rather than a reducer: almost everything here is a small independent
 * fact (the session list, the current theme, which pane is focused) and the
 * expensive thing on screen — the terminals — is deliberately not managed by
 * the component tree at all.
 */

import { batch, computed, signal } from '@preact/signals';
import type { PtydStatus, SessionMeta } from '../../src/shared/protocol.ts';
import type { DeviceClass, Prefs } from '../../src/shared/prefs.ts';
import { defaultPrefs, deviceClassFor } from '../../src/shared/prefs.ts';
import type { SharedKeymap } from '../../src/shared/keymap.ts';
import { defaultSharedKeymap, mergeKeymap } from '../../src/shared/keymap.ts';
import { api, ApiError, type AuthStatus, type Health } from './api.ts';
import { localShortcuts, setLocalShortcuts } from './local-shortcuts.ts';
import {
  closePane,
  deserializeLayout,
  findLeaf,
  leaves,
  makeLeaf,
  pruneMissingSessions,
  setPaneSession,
  splitPane,
  type LayoutNode,
} from './layout.ts';
import type { DropTarget } from './dnd.ts';
import { resolveTheme } from './theme.ts';
import {
  applyOptionsToAll,
  disposeTerminal,
  getTerminal,
  liveTerminalIds,
  peekTerminal,
} from './terminal/registry.ts';

// --- Server-derived state ---------------------------------------------------

export const sessions = signal<SessionMeta[]>([]);
export const ptydStatus = signal<PtydStatus>('connecting');
export const eventsConnected = signal(false);
export const health = signal<Health | null>(null);
export const authStatus = signal<AuthStatus | null>(null);
export const prefs = signal<Prefs>(defaultPrefs);

/** What each key does — synced across devices, fetched from `/api/keymap`. */
export const sharedKeymap = signal<SharedKeymap>(defaultSharedKeymap);

/**
 * The full keymap `keys.ts` and the UI read from: the synced bindings plus
 * this device's own on/off switches (`local-shortcuts.ts`), merged. Read-only
 * — write to `sharedKeymap`/`saveSharedKeymap` or `setLocalShortcuts`
 * depending on which half actually changed.
 */
export const keymap = computed(() => mergeKeymap(sharedKeymap.value, localShortcuts.value));

export { localShortcuts, setLocalShortcuts };

/** True while the leader key is armed and waiting for the next keystroke. */
export const leaderArmed = signal(false);

// --- Local UI state ---------------------------------------------------------

const initialPane = makeLeaf(null);
export const layoutRoot = signal<LayoutNode>(initialPane);
export const activePaneId = signal<string>(initialPane.id);
export const deviceClass = signal<DeviceClass>('desktop');

const SIDEBAR_STORAGE_KEY = 'ptyhub.sidebarOpen';

function loadSidebarOpen(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

/**
 * Whether the sidebar shows. Per-device like `local-shortcuts.ts` — a
 * window's layout habit, not something worth carrying to your other devices.
 */
export const sidebarOpen = signal(loadSidebarOpen());

export function setSidebarOpen(open: boolean): void {
  sidebarOpen.value = open;
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Private-browsing quota or storage disabled; the in-memory signal still works.
  }
}

export const paletteOpen = signal(false);
export const settingsOpen = signal(false);
export const searchOpen = signal(false);
/** The session-switcher overlay on phones, where the tab strip only fits one at a time. */
export const mobileSwitcherOpen = signal(false);
export const renamingId = signal<string | null>(null);
export const toast = signal<{ text: string; kind: 'info' | 'error' } | null>(null);
export const bootError = signal<string | null>(null);

// --- Derived ----------------------------------------------------------------

export const theme = computed(() => resolveTheme(prefs.value));
export const fontSize = computed(() => prefs.value.font.size[deviceClass.value]);
export const isMobile = computed(() => deviceClass.value === 'mobile');
/**
 * Sessions in the order the tab bar and sidebar show them: pinned first, then
 * whatever order the user has dragged them into, then anything new by age.
 *
 * Both lists live in preferences rather than in the session protocol, because
 * ordering is a property of how you like to look at your terminals, not of the
 * terminals themselves — and preferences already sync across your devices.
 */
export const orderedSessions = computed(() => {
  const pinned = prefs.value.pinned;
  const manual = prefs.value.sessionOrder;
  const rank = (id: string) => {
    const pinIndex = pinned.indexOf(id);
    if (pinIndex >= 0) return { tier: 0, index: pinIndex };
    const orderIndex = manual.indexOf(id);
    if (orderIndex >= 0) return { tier: 1, index: orderIndex };
    return { tier: 2, index: Number.MAX_SAFE_INTEGER };
  };

  return [...sessions.value].sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    if (ra.tier !== rb.tier) return ra.tier - rb.tier;
    if (ra.index !== rb.index) return ra.index - rb.index;
    return a.createdAt - b.createdAt;
  });
});

export const liveSessions = computed(() =>
  orderedSessions.value.filter((s) => s.alive),
);

export const isPinned = (id: string): boolean => prefs.value.pinned.includes(id);

export const activeSessionId = computed(() => {
  const leaf = findLeaf(layoutRoot.value, activePaneId.value);
  return leaf?.sessionId ?? null;
});

export const activeSession = computed(
  () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null,
);

/**
 * Phones in "scale" mode watch without driving: the session keeps the size the
 * desktop gave it and the phone shrinks it to fit, instead of narrowing the
 * shell for everyone.
 */
export const drivesSize = computed(
  () => !(isMobile.value && prefs.value.mobileFit === 'scale'),
);

export function terminalOptions() {
  return {
    prefs: prefs.value,
    fontSize: fontSize.value,
    drivesSize: drivesSize.value,
  };
}

// Extend the registry's debugging seam with the bits only this module knows.
Object.assign((globalThis as unknown as Record<string, any>).__ptyhub ?? {}, {
  active: () => activeSessionId.value,
  sessions: () => sessions.value,
  prefs: () => prefs.value,
});

// --- Notifications ----------------------------------------------------------

let toastTimer: number | null = null;

export function notify(text: string, kind: 'info' | 'error' = 'info'): void {
  toast.value = { text, kind };
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
  }, kind === 'error' ? 6000 : 3000);
}

function reportError(err: unknown, fallback: string): void {
  if (err instanceof ApiError && err.unauthenticated) {
    authStatus.value = { authenticated: false, user: null, openAccess: false, passwordConfigured: true };
    return;
  }
  notify(err instanceof Error ? err.message : fallback, 'error');
}

// --- Device class -----------------------------------------------------------

export function trackDeviceClass(): () => void {
  const update = () => {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const next = deviceClassFor(window.innerWidth, coarse);
    if (next !== deviceClass.value) {
      deviceClass.value = next;
      applyOptionsToAll();
    }
  };
  update();
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  return () => {
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
  };
}

// --- Session actions --------------------------------------------------------

export function applySessionList(list: SessionMeta[]): void {
  batch(() => {
    sessions.value = list;
    reconcileLayout(list);
  });
}

export function applySessionEvent(patch: (list: SessionMeta[]) => SessionMeta[]): void {
  batch(() => {
    sessions.value = patch(sessions.value);
    reconcileLayout(sessions.value);
  });
}

/**
 * Insert or update one session.
 *
 * Creating a session produces two independent notifications — the REST reply
 * and the `created` event on the event channel — and they can arrive in either
 * order. Appending blindly would show the same terminal twice.
 */
export function upsertSession(session: SessionMeta): void {
  applySessionEvent((list) =>
    list.some((s) => s.id === session.id)
      ? list.map((s) => (s.id === session.id ? session : s))
      : [...list, session],
  );
}

/**
 * Session ids in most-recently-focused order, most recent first.
 *
 * This is what decides which terminal reappears when the one a pane was
 * showing closes: the tab you looked at just before this one, not whichever
 * happens to be oldest by creation time. Purely local UI memory, not synced
 * or persisted — it only needs to survive for the length of this tab's life.
 */
const mruSessionIds: string[] = [];

function touchMru(id: string): void {
  const at = mruSessionIds.indexOf(id);
  if (at === 0) return;
  if (at > 0) mruSessionIds.splice(at, 1);
  mruSessionIds.unshift(id);
}

/** Alive session ids ordered by recency of focus, falling back to creation
 * order (the server's own list order) for anything never actually visited. */
function byRecency(aliveIds: string[]): string[] {
  const alive = new Set(aliveIds);
  const recent = mruSessionIds.filter((id) => alive.has(id));
  const rest = aliveIds.filter((id) => !recent.includes(id));
  return [...recent, ...rest];
}

function reconcileLayout(list: SessionMeta[]): void {
  const existing = new Set(list.map((s) => s.id));
  for (let i = mruSessionIds.length - 1; i >= 0; i--) {
    if (!existing.has(mruSessionIds[i]!)) mruSessionIds.splice(i, 1);
  }
  // Prefer whichever living session was looked at most recently when filling
  // a pane whose terminal disappeared.
  const pruned = pruneMissingSessions(
    layoutRoot.value,
    existing,
    byRecency(list.filter((s) => s.alive).map((s) => s.id)),
  );
  if (pruned !== layoutRoot.value) {
    layoutRoot.value = pruned;
    if (!findLeaf(pruned, activePaneId.value)) {
      activePaneId.value = leaves(pruned)[0]!.id;
    }
  }
  // Terminals for sessions that no longer exist have nothing to reconnect to.
  for (const id of liveTerminalIds()) {
    if (!existing.has(id)) disposeTerminal(id);
  }
}

export function focusSession(id: string): void {
  layoutRoot.value = setPaneSession(layoutRoot.value, activePaneId.value, id);
  queueMicrotask(() => peekTerminal(id)?.focus());
  persistLayoutSoon();
  touchMru(id);
}

export function focusPane(paneId: string): void {
  activePaneId.value = paneId;
  const leaf = findLeaf(layoutRoot.value, paneId);
  if (!leaf?.sessionId) return;
  const term = peekTerminal(leaf.sessionId);
  term?.focus();
  // Clicking into a pane means this device is the one in use, even if the
  // terminal already had focus and no focus event fired.
  term?.claimSize();
  touchMru(leaf.sessionId);
}

export function assignSessionToPane(paneId: string, sessionId: string | null): void {
  layoutRoot.value = setPaneSession(layoutRoot.value, paneId, sessionId);
  persistLayoutSoon();
}

export async function createSession(name?: string): Promise<void> {
  try {
    // Start at the size of the pane it is about to appear in, so the shell
    // never draws its first prompt at the wrong width.
    const current = activeSessionId.value
      ? peekTerminal(activeSessionId.value)?.term
      : undefined;
    const { session } = await api.createSession({
      name,
      cols: current?.cols,
      rows: current?.rows,
    });
    upsertSession(session);
    focusSession(session.id);
    getTerminal(session.id);
  } catch (err) {
    reportError(err, 'could not create a session');
  }
}

/**
 * Close a session and drop it from the list, in one action.
 *
 * The list updates straight away rather than waiting for the round trip, so the
 * tab disappears on the click that closed it.
 */
export async function closeSession(id: string, force = false): Promise<void> {
  const session = sessions.value.find((s) => s.id === id);
  if (session?.locked && !force) {
    notify(`${session.name} is locked — unlock it first`, 'error');
    return;
  }

  const previous = sessions.value;
  applySessionEvent((list) => list.filter((s) => s.id !== id));
  disposeTerminal(id);
  try {
    await api.killSession(id, { force });
  } catch (err) {
    // Put it back: the session is still there and pretending otherwise would
    // hide a running shell from the only UI that can reach it.
    applySessionEvent(() => previous);
    reportError(err, 'could not close the session');
  }
}

export async function setSessionLock(id: string, locked: boolean): Promise<void> {
  try {
    const { session } = await api.setSessionLock(id, locked);
    applySessionEvent((list) => list.map((s) => (s.id === id ? session : s)));
  } catch (err) {
    // A ptyd predating the lock feature rejects the operation outright. Say
    // what to do instead of showing a raw protocol error.
    if (err instanceof ApiError && err.code === 'bad_op') {
      notify('locking needs a newer ptyd — restart it when convenient', 'error');
      return;
    }
    reportError(err, 'could not change the lock');
  }
}

export function togglePinned(id: string): void {
  const pinned = prefs.value.pinned;
  updatePrefs({
    pinned: pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id],
  });
}

/** Persist the tab order after a drag. */
export function setSessionOrder(ids: string[]): void {
  updatePrefs({ sessionOrder: ids });
}

export async function renameSession(id: string, name: string): Promise<void> {
  try {
    const { session } = await api.renameSession(id, name);
    applySessionEvent((list) => list.map((s) => (s.id === id ? session : s)));
  } catch (err) {
    reportError(err, 'could not rename the session');
  } finally {
    renamingId.value = null;
  }
}

// --- Layout actions ---------------------------------------------------------

export function splitActive(direction: 'row' | 'column'): void {
  const { root, newPaneId } = splitPane(layoutRoot.value, activePaneId.value, direction);
  batch(() => {
    layoutRoot.value = root;
    activePaneId.value = newPaneId;
  });
  persistLayoutSoon();
}

/**
 * Close one pane. The session inside it keeps running — a pane is a viewport,
 * not the thing being viewed.
 */
export function closePaneById(paneId: string): void {
  if (leaves(layoutRoot.value).length <= 1) return;
  const next = closePane(layoutRoot.value, paneId);
  batch(() => {
    layoutRoot.value = next;
    if (!findLeaf(next, activePaneId.value)) {
      activePaneId.value = leaves(next)[0]!.id;
    }
  });
  persistLayoutSoon();
}

export function closeActivePane(): void {
  closePaneById(activePaneId.value);
}

/**
 * Apply a tab drop: reorder the strip, move a terminal into a pane, or split a
 * pane and put the terminal in the new half.
 *
 * The pane the terminal came from is deliberately left empty rather than being
 * refilled with something else — you moved one terminal, so one thing should
 * change. The empty pane has its own close button and a list to pick from.
 */
export function applyTabDrop(sessionId: string, target: DropTarget): void {
  if (!target) return;

  if (target.kind === 'tabs') {
    const ids = orderedSessions.value.map((s) => s.id);
    const from = ids.indexOf(sessionId);
    if (from < 0) return;
    ids.splice(from, 1);
    // The removal shifts everything after it left by one.
    ids.splice(target.index > from ? target.index - 1 : target.index, 0, sessionId);
    setSessionOrder(ids);
    return;
  }

  if (target.zone === 'center') {
    assignSessionToPane(target.paneId, sessionId);
    focusPane(target.paneId);
    return;
  }

  const direction = target.zone === 'left' || target.zone === 'right' ? 'row' : 'column';
  const before = target.zone === 'left' || target.zone === 'top';
  const { root, newPaneId } = splitPane(layoutRoot.value, target.paneId, direction, {
    before,
    sessionId,
  });

  batch(() => {
    // setPaneSession clears the terminal from wherever it used to be shown.
    layoutRoot.value = setPaneSession(root, newPaneId, sessionId);
    activePaneId.value = newPaneId;
  });
  persistLayoutSoon();
  queueMicrotask(() => peekTerminal(sessionId)?.focus());
}

export function cyclePane(step: number): void {
  const all = leaves(layoutRoot.value);
  if (all.length <= 1) return;
  const index = all.findIndex((leaf) => leaf.id === activePaneId.value);
  const next = all[(index + step + all.length) % all.length]!;
  focusPane(next.id);
}

export function selectSessionByIndex(index: number): void {
  const session = liveSessions.value[index];
  if (session) focusSession(session.id);
}

export function cycleSession(step: number): void {
  const list = sessions.value;
  if (list.length === 0) return;
  const current = activeSessionId.value;
  const index = list.findIndex((s) => s.id === current);
  const next = list[(index + step + list.length) % list.length]!;
  focusSession(next.id);
}

// --- Preferences ------------------------------------------------------------

let prefsTimer: number | null = null;

export function updatePrefs(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch };
  applyOptionsToAll();
  schedulePrefsSave();
}

export function updateFontPrefs(patch: Partial<Prefs['font']>): void {
  prefs.value = { ...prefs.value, font: { ...prefs.value.font, ...patch } };
  applyOptionsToAll();
  schedulePrefsSave();
}

export function setFontSize(size: number): void {
  updateFontPrefs({
    size: { ...prefs.value.font.size, [deviceClass.value]: size },
  });
}

function schedulePrefsSave(): void {
  if (prefsTimer !== null) clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => {
    prefsTimer = null;
    void api.savePrefs(prefs.value).catch((err) => reportError(err, 'could not save preferences'));
  }, 400);
}

/**
 * Write preferences out immediately, even if the page is going away.
 *
 * Without this, dragging a tab and then reloading within the debounce window
 * silently loses the new order. `keepalive` lets the request outlive the
 * document, which a normal fetch would not.
 */
export function flushPrefs(): void {
  if (prefsTimer === null && layoutTimer === null) return;
  if (prefsTimer !== null) clearTimeout(prefsTimer);
  if (layoutTimer !== null) clearTimeout(layoutTimer);
  prefsTimer = null;
  layoutTimer = null;

  const body = JSON.stringify({ prefs: { ...prefs.value, layout: layoutRoot.value } });
  void fetch('/api/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {
    // The page is unloading; there is nothing useful left to do about it.
  });
}

let layoutTimer: number | null = null;

function persistLayoutSoon(): void {
  if (layoutTimer !== null) clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => {
    layoutTimer = null;
    prefs.value = { ...prefs.value, layout: layoutRoot.value };
    void api.savePrefs({ layout: layoutRoot.value }).catch(() => {
      // Layout is a nicety; a failure here should not shout at the user.
    });
  }, 800);
}

// --- Boot -------------------------------------------------------------------

export async function boot(): Promise<void> {
  try {
    const status = await api.authStatus();
    authStatus.value = status;
    if (!status.authenticated) return;
  } catch (err) {
    bootError.value = err instanceof Error ? err.message : 'cannot reach the server';
    return;
  }

  try {
    const [healthRes, prefsRes, keymapRes, sessionRes] = await Promise.all([
      api.health(),
      api.prefs(),
      api.keymap(),
      api.listSessions(),
    ]);
    batch(() => {
      health.value = healthRes;
      ptydStatus.value = healthRes.ptyd;
      prefs.value = prefsRes.prefs;
      sharedKeymap.value = keymapRes.keymap;
      sessions.value = sessionRes.sessions;
    });

    const stored = deserializeLayout(prefsRes.prefs.layout);
    if (stored) {
      const known = new Set(sessionRes.sessions.map((s) => s.id));
      const restored = pruneMissingSessions(stored, known);
      batch(() => {
        layoutRoot.value = restored;
        activePaneId.value = leaves(restored)[0]!.id;
      });
    }

    await ensureFirstSession();
  } catch (err) {
    reportError(err, 'could not load the workspace');
  }
}

/**
 * Never land on an empty screen. The server decides whether to auto-create and
 * serialises the call, so opening three tabs at once still yields one session.
 */
async function ensureFirstSession(): Promise<void> {
  if (activeSessionId.value) return;
  const alive = liveSessions.value;
  if (alive.length > 0) {
    focusSession(alive[0]!.id);
    return;
  }
  try {
    const { session } = await api.ensureSession(120, 30);
    if (session) {
      upsertSession(session);
      focusSession(session.id);
    }
  } catch (err) {
    reportError(err, 'could not create the first session');
  }
}

export { ensureFirstSession };
