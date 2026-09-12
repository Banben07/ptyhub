/**
 * Global keyboard handling.
 *
 * Only two things are intercepted before the terminal sees them: the leader
 * chord, and the single key that follows it. Everything else — including every
 * Ctrl combination a shell or vim expects — passes straight through.
 */

import { chordFromEvent, chordMatches, normalizeKey } from '../../src/shared/keymap.ts';
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

    if (leaderArmed.value) {
      event.preventDefault();
      event.stopPropagation();
      disarm();
      if (chord.key === 'escape') return;
      const action = keymap.value.bindings[normalizeKey(event.key)];
      if (action) runAction(action);
      return;
    }

    if (chordMatches(keymap.value.leader, chord)) {
      event.preventDefault();
      event.stopPropagation();
      arm();
      return;
    }

    // Escape closes whatever overlay is open, and only then falls through.
    if (chord.key === 'escape') {
      if (paletteOpen.value || settingsOpen.value || searchOpen.value || renamingId.value) {
        event.preventDefault();
        event.stopPropagation();
        paletteOpen.value = false;
        settingsOpen.value = false;
        searchOpen.value = false;
        renamingId.value = null;
      }
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
