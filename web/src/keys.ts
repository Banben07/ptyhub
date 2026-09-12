/**
 * Global keyboard handling.
 *
 * Three things can intercept a keystroke before the terminal sees it: the
 * leader chord and the key that follows it, and — when the direct layer is
 * turned on — a single modifier+key chord matched with no leader at all.
 * Everything else, including every Ctrl combination a shell or vim expects,
 * passes straight through. The master switch (`keymap.value.enabled`) can
 * disable both at once.
 */

import {
  chordFromEvent,
  chordId,
  chordMatches,
  normalizeKey,
} from '../../src/shared/keymap.ts';
import { runAction } from './actions.ts';
import {
  keymap,
  leaderArmed,
  paletteOpen,
  renamingId,
  searchOpen,
  settingsOpen,
} from './state.ts';

const LEADER_TIMEOUT_MS = 2500;

export function installKeyHandler(): () => void {
  let timer: number | null = null;

  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    leaderArmed.value = false;
  };

  const arm = () => {
    leaderArmed.value = true;
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(disarm, LEADER_TIMEOUT_MS);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const chord = chordFromEvent(event);

    // Modifier keys on their own never complete or arm anything.
    if (['control', 'alt', 'shift', 'meta'].includes(chord.key)) return;

    // Escape dismissing an open overlay is ordinary UI behaviour, not a
    // shortcut a user opted into — keep it working even with the master
    // switch off. Skipped while the leader is armed, where Escape means
    // "cancel the pending chord" instead (handled below).
    if (chord.key === 'escape' && !leaderArmed.value) {
      if (paletteOpen.value || settingsOpen.value || searchOpen.value || renamingId.value) {
        event.preventDefault();
        event.stopPropagation();
        paletteOpen.value = false;
        settingsOpen.value = false;
        searchOpen.value = false;
        renamingId.value = null;
        return;
      }
    }

    // The master switch reads live off the signal, so flipping it in Settings
    // takes effect immediately without needing to reinstall this listener.
    if (!keymap.value.enabled) return;

    if (leaderArmed.value) {
      event.preventDefault();
      event.stopPropagation();
      disarm();
      if (chord.key === 'escape') return;
      const action = keymap.value.bindings[normalizeKey(event.key)];
      if (action) runAction(action);
      return;
    }

    // Direct bindings match a complete chord, so they cannot collide with the
    // leader (a single specific chord) or with plain typing (no modifier).
    if (keymap.value.direct) {
      const action = keymap.value.directBindings[chordId(chord)];
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        runAction(action);
        return;
      }
    }

    if (chordMatches(keymap.value.leader, chord)) {
      event.preventDefault();
      event.stopPropagation();
      arm();
    }
  };

  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', disarm);

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', disarm);
    disarm();
  };
}
