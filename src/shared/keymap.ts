/**
 * Keyboard bindings.
 *
 * Everything goes through a leader prefix. A terminal needs almost every plain
 * key combination for itself, and a browser has already claimed Ctrl/Cmd+N, +W,
 * +T and +K, so a prefix is the only scheme that steals nothing.
 *
 * The default leader is Ctrl+\, which is also the detach prefix in `ptyhub
 * attach`. It is deliberately NOT Ctrl+Space: that is the input-method toggle
 * on Windows, macOS and Linux, so for anyone typing Chinese, Japanese or Korean
 * the keystroke is swallowed by the IME and the browser never sees it.
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
export const KEYMAP_VERSION = 2;

export interface Keymap {
  version?: number;
  leader: Chord;
  /** Key pressed after the leader, mapped to an action. */
  bindings: Record<string, ActionId>;
}

export const defaultKeymap: Keymap = {
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
};

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

export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.key === 'space' ? 'Space' : chord.key.toUpperCase());
  return parts.join('+');
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

const actionIds = new Set<string>(actions.map((a) => a.id));

/** The leader we shipped first, which turned out to collide with every IME. */
function isRetiredDefaultLeader(chord: Chord): boolean {
  return chord.ctrl && !chord.alt && !chord.meta && chord.key === 'space';
}

export function normalizeKeymap(input: unknown): Keymap {
  const raw = (input ?? {}) as Partial<Keymap>;
  const leader = raw.leader;
  const bindings: Record<string, ActionId> = {};

  for (const [key, action] of Object.entries(raw.bindings ?? {})) {
    if (typeof key === 'string' && key.length > 0 && actionIds.has(String(action))) {
      bindings[normalizeKey(key)] = action as ActionId;
    }
  }

  let resolvedLeader =
    leader && typeof leader === 'object' && typeof leader.key === 'string'
      ? {
          ctrl: leader.ctrl === true,
          alt: leader.alt === true,
          shift: leader.shift === true,
          meta: leader.meta === true,
          key: normalizeKey(leader.key),
        }
      : defaultKeymap.leader;

  // Migrate keymaps written before the leader moved off Ctrl+Space. That value
  // was never a real choice — it was our default, and it does not work at all
  // for anyone with an input method installed.
  if ((raw.version ?? 1) < 2 && isRetiredDefaultLeader(resolvedLeader)) {
    resolvedLeader = defaultKeymap.leader;
  }

  return {
    version: KEYMAP_VERSION,
    leader: resolvedLeader,
    bindings: Object.keys(bindings).length > 0 ? bindings : defaultKeymap.bindings,
  };
}

/** Human-readable shortcut for an action, e.g. "Ctrl+Space C". */
export function shortcutFor(keymap: Keymap, action: ActionId): string | null {
  const entry = Object.entries(keymap.bindings).find(([, id]) => id === action);
  if (!entry) return null;
  const key = entry[0] === 'space' ? 'Space' : entry[0]!.toUpperCase();
  return `${formatChord(keymap.leader)} ${key}`;
}
