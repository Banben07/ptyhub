/**
 * Keyboard bindings.
 *
 * There are two layers, and either can be switched off independently of the
 * other via the master switch below.
 *
 * **Leader bindings** go through a prefix chord. A terminal needs almost every
 * plain key combination for itself, and a browser has already claimed
 * Ctrl/Cmd+N, +W, +T and +K, so a prefix is the only scheme that steals
 * nothing. The default leader is Ctrl+\, also the detach prefix in `ptyhub
 * attach`. It is deliberately NOT Ctrl+Space: that is the input-method toggle
 * on Windows, macOS and Linux, so for anyone typing Chinese, Japanese or Korean
 * the keystroke is swallowed by the IME and the browser never sees it.
 *
 * **Direct bindings** fire on a single modifier+key chord with no leader —
 * Cmd+W to close, Cmd+1 to jump to terminal 1, the shape of a native Mac app.
 * The shipped defaults use Cmd (`meta`) only, deliberately not Ctrl: Ctrl+key
 * is exactly the space bash/readline and vim already use for line editing
 * (Ctrl+W deletes a word, Ctrl+K kills to end of line, Ctrl+F/B/D and more),
 * so binding it here by default would break ordinary shell editing the moment
 * this layer is turned on. Cmd is never touched by any of that. In an ordinary
 * browser tab several Cmd combos (+W, +T, +N and their Shift variants) are
 * reserved by the browser itself and cannot be intercepted by page
 * JavaScript, by design, so users get trapped in an unclosable tab. They work
 * as intended in a window that does not have that browser chrome to begin
 * with — an installed PWA in standalone mode, or a browser launched in
 * app/kiosk mode — which is why this layer defaults to off and is a
 * deliberate opt-in for people running ptyhub that way.
 *
 * The master switch turns off both layers at once, a safety valve for anyone
 * who just wants a plain page with no keystrokes intercepted at all.
 *
 * **On/off is per device, not synced.** Whether a browser should be
 * intercepting keys at all depends on what that specific browser window is —
 * a plain tab, or a shortcut-free app-mode wrapper — which is a property of
 * the device, not a taste you'd want copied everywhere you sign in. So
 * `enabled` and `direct` live in that browser's own `localStorage` and never
 * touch the server; `SharedKeymap` (the leader chord and both binding tables —
 * "what does each key do") is what actually syncs, the same way theme and font
 * do. `Keymap` is the two merged together, and is what the rest of the app
 * reads from.
 *
 * Browser-safe: types and pure functions only.
 */

export type ActionId =
  | 'new-session'
  | 'close-session'
  | 'rename-session'
  | 'next-session'
  | 'prev-session'
  | 'select-session-1'
  | 'select-session-2'
  | 'select-session-3'
  | 'select-session-4'
  | 'select-session-5'
  | 'select-session-6'
  | 'select-session-7'
  | 'select-session-8'
  | 'select-session-9'
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'next-pane'
  | 'search'
  | 'command-palette'
  | 'settings'
  | 'toggle-sidebar'
  | 'font-bigger'
  | 'font-smaller'
  | 'font-reset'
  | 'clear-screen';

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: 'Sessions' | 'Panes' | 'View';
}

export const actions: ActionInfo[] = [
  { id: 'new-session', label: 'New terminal', group: 'Sessions' },
  { id: 'close-session', label: 'Close terminal', group: 'Sessions' },
  { id: 'rename-session', label: 'Rename terminal', group: 'Sessions' },
  { id: 'next-session', label: 'Next terminal', group: 'Sessions' },
  { id: 'prev-session', label: 'Previous terminal', group: 'Sessions' },
  { id: 'split-right', label: 'Split right', group: 'Panes' },
  { id: 'split-down', label: 'Split down', group: 'Panes' },
  { id: 'close-pane', label: 'Close pane', group: 'Panes' },
  { id: 'next-pane', label: 'Focus next pane', group: 'Panes' },
  { id: 'search', label: 'Search in terminal', group: 'View' },
  { id: 'command-palette', label: 'Command palette', group: 'View' },
  { id: 'settings', label: 'Settings', group: 'View' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', group: 'View' },
  { id: 'font-bigger', label: 'Increase font size', group: 'View' },
  { id: 'font-smaller', label: 'Decrease font size', group: 'View' },
  { id: 'font-reset', label: 'Reset font size', group: 'View' },
  { id: 'clear-screen', label: 'Clear screen', group: 'View' },
];

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Lowercase `KeyboardEvent.key`, with ' ' spelled `space`. */
  key: string;
}

/** Bumped when a stored keymap needs migrating; see `normalizeKeymap`. */
export const KEYMAP_VERSION = 4;

/** The part that syncs across devices: what each key does. */
export interface SharedKeymap {
  version?: number;
  leader: Chord;
  /** Key pressed after the leader, mapped to an action. */
  bindings: Record<string, ActionId>;
  /** Keyed by `chordId()`, so each entry is a complete chord including its modifier. */
  directBindings: Record<string, ActionId>;
}

/** The part that stays on this device: whether either layer is active right now. */
export interface LocalShortcutState {
  /** Master switch. False disables both the leader and the direct layer. */
  enabled: boolean;
  /** Enables the Mac-style modifier+key layer. Off by default. */
  direct: boolean;
}

/** Everything merged together — what `keys.ts` and the UI actually read. */
export type Keymap = SharedKeymap & LocalShortcutState;

export function mergeKeymap(shared: SharedKeymap, local: LocalShortcutState): Keymap {
  return { ...shared, ...local };
}

export function normalizeKey(key: string): string {
  if (key === ' ') return 'space';
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

export function chordFromEvent(event: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  key: string;
}): Chord {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key: normalizeKey(event.key),
  };
}

export function chordMatches(chord: Chord, event: Chord): boolean {
  return (
    chord.ctrl === event.ctrl &&
    chord.alt === event.alt &&
    chord.meta === event.meta &&
    // Shift is ignored for space so Ctrl+Shift+Space still works as a leader.
    (chord.key === 'space' || chord.shift === event.shift) &&
    chord.key === event.key
  );
}

/**
 * Stable dictionary key for a full chord, modifiers included. Used for the
 * direct-binding map, where — unlike the leader's single-key bindings — the
 * modifier is part of what distinguishes one shortcut from another.
 */
export function chordId(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('ctrl');
  if (chord.alt) parts.push('alt');
  if (chord.shift) parts.push('shift');
  if (chord.meta) parts.push('meta');
  parts.push(chord.key);
  return parts.join('+');
}

/** True when a chord carries no modifier — unsafe as a direct binding. */
export function isBareKey(chord: Chord): boolean {
  return !chord.ctrl && !chord.alt && !chord.meta;
}

export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.key === 'space' ? 'Space' : chord.key.toUpperCase());
  return parts.join('+');
}

/** Mac-style rendering for the direct layer: ⌘⇧D rather than Meta+Shift+D. */
export function formatChordMac(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('⌃');
  if (chord.alt) parts.push('⌥');
  if (chord.shift) parts.push('⇧');
  if (chord.meta) parts.push('⌘');
  parts.push(chord.key === 'space' ? 'Space' : chord.key.toUpperCase());
  return parts.join('');
}

/**
 * Explain why a chord is a bad leader, or null when it is fine.
 *
 * These are combinations something upstream of the page consumes, so the
 * binding would appear to do nothing at all with no way to tell why.
 */
export function leaderConflict(chord: Chord): string | null {
  if (chord.key === 'space' && (chord.ctrl || chord.meta)) {
    return 'switches input method on Windows, macOS and Linux, so the browser never sees it';
  }
  if ((chord.ctrl || chord.meta) && !chord.shift && !chord.alt) {
    const browserKeys: Record<string, string> = {
      t: 'opens a browser tab',
      n: 'opens a browser window',
      w: 'closes the browser tab',
      l: 'focuses the address bar',
      d: 'bookmarks the page',
      f: 'opens the browser find bar',
      r: 'reloads the page',
      p: 'opens the print dialog',
      k: 'is the search shortcut in some browsers',
      q: 'quits the browser on macOS',
    };
    const reason = browserKeys[chord.key];
    if (reason) return `${reason}, so the browser takes it first`;
  }
  if (['f5', 'f11', 'f12'].includes(chord.key)) {
    return 'is reserved by the browser';
  }
  return null;
}

/**
 * Explain why a chord is unsafe or unlikely to work as a direct binding, or
 * null when it is fine. Distinct from `leaderConflict`: a direct binding IS
 * exactly a bare modifier+key combo by design, so the bar here is "does this
 * specific one still get eaten upstream", not "does any modifier combo".
 */
export function directConflict(chord: Chord): string | null {
  if (isBareKey(chord)) {
    return 'needs at least one modifier key — a bare key would fire while typing';
  }
  if ((chord.ctrl || chord.meta) && !chord.shift && !chord.alt) {
    const reserved: Record<string, string> = {
      t: 'new tab',
      n: 'new window',
      w: 'close tab',
      q: 'quit the browser',
    };
    const reason = reserved[chord.key];
    if (reason) {
      return `reserved by the browser for "${reason}" in a normal tab — works in an installed/standalone or app-mode window`;
    }
  }
  return null;
}

/**
 * Mac-idiom defaults for the direct layer, bound under Cmd (`meta`) only —
 * deliberately not also under Ctrl.
 *
 * Ctrl+key is exactly the space bash/readline and vim already use for line
 * editing: Ctrl+W deletes the previous word while typing a command, Ctrl+K
 * kills to end of line, Ctrl+F/B move forward/back a character, Ctrl+D is
 * EOF. Auto-binding those as "direct shortcuts" the moment this layer is
 * turned on would break ordinary shell editing. Cmd, by contrast, is never
 * touched by any of that — no shell or readline binds it — which is exactly
 * why it is the one modifier safe to hijack here. Anyone who wants a specific
 * action on a Ctrl combo instead can still record one by hand below; it just
 * is not force-installed for everyone.
 *
 * Chosen from existing, well-known conventions rather than invented: tab
 * lifecycle and navigation match iTerm2/Terminal.app (Cmd+T/W, Cmd+D and
 * Cmd+Shift+D for splits, Cmd+Shift+[ / ] for prev/next, Cmd+K to clear,
 * Cmd+1..9 to jump), and the rest match universal Mac app conventions
 * (Cmd+, for preferences, Cmd+F to find, Cmd+B to toggle a sidebar, Cmd+Shift+P
 * for a command palette as in VS Code, Cmd+=/-/0 to zoom).
 */
const DIRECT_DEFAULTS: { key: string; shift?: boolean; action: ActionId }[] = [
  { key: 't', action: 'new-session' },
  { key: 'w', action: 'close-session' },
  { key: 'd', action: 'split-right' },
  { key: 'd', shift: true, action: 'split-down' },
  { key: ']', shift: true, action: 'next-session' },
  { key: '[', shift: true, action: 'prev-session' },
  { key: ',', action: 'settings' },
  { key: 'f', action: 'search' },
  { key: 'p', shift: true, action: 'command-palette' },
  { key: 'b', action: 'toggle-sidebar' },
  { key: 'k', action: 'clear-screen' },
  { key: '=', action: 'font-bigger' },
  { key: '+', action: 'font-bigger' },
  { key: '-', action: 'font-smaller' },
  { key: '_', action: 'font-smaller' },
  { key: '0', action: 'font-reset' },
  ...Array.from({ length: 9 }, (_, i) => ({
    key: String(i + 1),
    action: `select-session-${i + 1}` as ActionId,
  })),
];

function buildDefaultDirectBindings(): Record<string, ActionId> {
  const out: Record<string, ActionId> = {};
  for (const entry of DIRECT_DEFAULTS) {
    const id = chordId({
      ctrl: false,
      meta: true,
      alt: false,
      shift: entry.shift ?? false,
      key: entry.key,
    });
    out[id] = entry.action;
  }
  return out;
}

export const defaultLocalShortcuts: LocalShortcutState = {
  enabled: true,
  // Off by default: safe for a plain browser tab, where several direct combos
  // would otherwise be swallowed by the browser instead of the page.
  direct: false,
};

export const defaultSharedKeymap: SharedKeymap = {
  version: KEYMAP_VERSION,
  leader: { ctrl: true, alt: false, shift: false, meta: false, key: '\\' },
  bindings: {
    c: 'new-session',
    x: 'close-session',
    r: 'rename-session',
    n: 'next-session',
    p: 'prev-session',
    '1': 'select-session-1',
    '2': 'select-session-2',
    '3': 'select-session-3',
    '4': 'select-session-4',
    '5': 'select-session-5',
    '6': 'select-session-6',
    '7': 'select-session-7',
    '8': 'select-session-8',
    '9': 'select-session-9',
    '|': 'split-right',
    '\\': 'split-right',
    '-': 'split-down',
    w: 'close-pane',
    o: 'next-pane',
    f: 'search',
    k: 'command-palette',
    ',': 'settings',
    b: 'toggle-sidebar',
    '+': 'font-bigger',
    '=': 'font-bigger',
    _: 'font-smaller',
    '0': 'font-reset',
    l: 'clear-screen',
  },
  directBindings: buildDefaultDirectBindings(),
};

/** For convenience where a single fully-populated `Keymap` is handy (tests, fallbacks). */
export const defaultKeymap: Keymap = mergeKeymap(defaultSharedKeymap, defaultLocalShortcuts);

/**
 * Every valid binding target, for validating stored keymaps.
 *
 * Deliberately NOT the same set as `actions`: that list is what the command
 * palette and rebind tables show, and leaves out `select-session-1..9` since
 * nine near-identical "jump to terminal N" rows would not be worth showing
 * there. But a keymap can legitimately bind a key to one of them (both the
 * leader's digit keys and the direct layer's Cmd+1..9 do), so validation has
 * to check against the full `ActionId` space, not the display list — using
 * the display list here silently stripped every digit binding on the very
 * first server round trip.
 */
const SELECT_SESSION_IDS: ActionId[] = Array.from(
  { length: 9 },
  (_, i) => `select-session-${i + 1}` as ActionId,
);
const actionIds = new Set<string>([...actions.map((a) => a.id), ...SELECT_SESSION_IDS]);

/** The leader we shipped first, which turned out to collide with every IME. */
function isRetiredDefaultLeader(chord: Chord): boolean {
  return chord.ctrl && !chord.alt && !chord.meta && chord.key === 'space';
}

function normalizeChord(value: unknown, fallback: Chord): Chord {
  if (!value || typeof value !== 'object' || typeof (value as Chord).key !== 'string') {
    return fallback;
  }
  const raw = value as Partial<Chord>;
  return {
    ctrl: raw.ctrl === true,
    alt: raw.alt === true,
    shift: raw.shift === true,
    meta: raw.meta === true,
    key: normalizeKey(raw.key!),
  };
}

/**
 * Validate a stored or received `SharedKeymap`.
 *
 * Note this deliberately does not read `enabled`/`direct` even if a caller
 * passes an object that has them (e.g. a full `Keymap`) — those two live on
 * the device, never on the server, so this function has no opinion on them.
 */
export function normalizeSharedKeymap(input: unknown): SharedKeymap {
  const raw = (input ?? {}) as Partial<SharedKeymap>;

  const bindings: Record<string, ActionId> = {};
  for (const [key, action] of Object.entries(raw.bindings ?? {})) {
    if (typeof key === 'string' && key.length > 0 && actionIds.has(String(action))) {
      bindings[normalizeKey(key)] = action as ActionId;
    }
  }

  const directBindings: Record<string, ActionId> = {};
  for (const [id, action] of Object.entries(raw.directBindings ?? {})) {
    if (typeof id === 'string' && id.length > 0 && actionIds.has(String(action))) {
      directBindings[id] = action as ActionId;
    }
  }

  // Migrate keymaps written while direct bindings still auto-registered under
  // both Ctrl and Cmd. Ctrl+key is exactly what shell line editing already
  // uses (Ctrl+W deletes a word, Ctrl+K kills to end of line, and more), so a
  // Ctrl entry sitting alongside a Cmd entry for the very same action was
  // never a deliberate choice — nothing in the UI can produce that pairing any
  // other way, since recording a new chord for an action replaces every
  // existing entry for it first. Keep the Cmd one, drop the Ctrl one.
  if ((raw.version ?? 1) < 4) {
    const actionsWithMeta = new Set(
      Object.entries(directBindings)
        .filter(([id]) => id.split('+').slice(0, -1).includes('meta'))
        .map(([, action]) => action),
    );
    for (const [id, action] of Object.entries(directBindings)) {
      const modifiers = id.split('+').slice(0, -1);
      if (!modifiers.includes('meta') && actionsWithMeta.has(action)) {
        delete directBindings[id];
      }
    }
  }

  let resolvedLeader = normalizeChord(raw.leader, defaultSharedKeymap.leader);

  // Migrate keymaps written before the leader moved off Ctrl+Space. That value
  // was never a real choice — it was our default, and it does not work at all
  // for anyone with an input method installed.
  if ((raw.version ?? 1) < 2 && isRetiredDefaultLeader(resolvedLeader)) {
    resolvedLeader = defaultSharedKeymap.leader;
  }

  return {
    version: KEYMAP_VERSION,
    leader: resolvedLeader,
    bindings: Object.keys(bindings).length > 0 ? bindings : defaultSharedKeymap.bindings,
    directBindings:
      Object.keys(directBindings).length > 0
        ? directBindings
        : defaultSharedKeymap.directBindings,
  };
}

/** Validate a device's local on/off state, e.g. as read from `localStorage`. */
export function normalizeLocalShortcuts(input: unknown): LocalShortcutState {
  const raw = (input ?? {}) as Partial<LocalShortcutState>;
  return {
    enabled: raw.enabled !== false,
    direct: raw.direct === true,
  };
}

/** Human-readable leader shortcut for an action, e.g. "Ctrl+\ C". */
export function shortcutFor(keymap: SharedKeymap, action: ActionId): string | null {
  const entry = Object.entries(keymap.bindings).find(([, id]) => id === action);
  if (!entry) return null;
  const key = entry[0] === 'space' ? 'Space' : entry[0]!.toUpperCase();
  return `${formatChord(keymap.leader)} ${key}`;
}

/** Mac-style direct shortcut for an action, e.g. "⌘W", or null if unbound. */
export function directShortcutFor(keymap: SharedKeymap, action: ActionId): string | null {
  // Prefer the Meta-modifier entry when both Ctrl and Meta variants exist —
  // it is the one worth showing since this layer is styled after macOS.
  const entries = Object.entries(keymap.directBindings).filter(([, id]) => id === action);
  if (entries.length === 0) return null;
  const [id] = entries.find(([key]) => key.includes('meta')) ?? entries[0]!;
  const parts = id.split('+');
  const key = parts.pop()!;
  return formatChordMac({
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    meta: parts.includes('meta'),
    key,
  });
}
