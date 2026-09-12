/**
 * Per-device shortcut state: the master on/off switch and the Mac-style
 * direct layer's on/off switch.
 *
 * Deliberately never synced to the server. Whether a given browser window
 * should be intercepting keys at all is a property of *that window* — a
 * plain tab versus a shortcut-free app-mode wrapper — not a taste you'd want
 * copied to every other device you sign into. `localStorage` is naturally
 * scoped to this browser profile, which is exactly the right scope here.
 *
 * Everything else about the keymap (the leader chord, what each key does)
 * syncs through the server like theme and font — see `keymap.ts` and
 * `/api/keymap`. This module only ever reads and writes local storage.
 */

import { signal } from '@preact/signals';
import {
  defaultLocalShortcuts,
  normalizeLocalShortcuts,
  type LocalShortcutState,
} from '../../src/shared/keymap.ts';

const STORAGE_KEY = 'ptyhub.localShortcuts';

function load(): LocalShortcutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeLocalShortcuts(JSON.parse(raw)) : { ...defaultLocalShortcuts };
  } catch {
    // Corrupt value, or storage disabled entirely — fall back quietly.
    return { ...defaultLocalShortcuts };
  }
}

export const localShortcuts = signal<LocalShortcutState>(load());

export function setLocalShortcuts(patch: Partial<LocalShortcutState>): void {
  const next = { ...localShortcuts.value, ...patch };
  localShortcuts.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A private-browsing quota or disabled storage still leaves the in-memory
    // signal in charge for the rest of this tab's life; nothing else to do.
  }
}
