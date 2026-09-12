/**
 * Everything the user can ask for, in one place. The keyboard, the command
 * palette and the toolbar buttons all go through `runAction`, so a shortcut and
 * a click can never drift apart.
 */

import type { ActionId } from '../../src/shared/keymap.ts';
import { defaultPrefs } from '../../src/shared/prefs.ts';
import {
  activeSessionId,
  closeActivePane,
  createSession,
  cyclePane,
  cycleSession,
  deviceClass,
  closeSession,
  paletteOpen,
  prefs,
  renamingId,
  searchOpen,
  selectSessionByIndex,
  settingsOpen,
  setFontSize,
  sidebarOpen,
  splitActive,
} from './state.ts';
import { peekTerminal } from './terminal/registry.ts';

const FONT_MIN = 8;
const FONT_MAX = 40;

export function runAction(action: ActionId): void {
  switch (action) {
    case 'new-session':
      void createSession();
      return;

    case 'close-session':
      if (activeSessionId.value) void closeSession(activeSessionId.value);
      return;

    case 'rename-session':
      renamingId.value = activeSessionId.value;
      return;

    case 'next-session':
      cycleSession(1);
      return;

    case 'prev-session':
      cycleSession(-1);
      return;

    case 'split-right':
      splitActive('row');
      return;

    case 'split-down':
      splitActive('column');
      return;

    case 'close-pane':
      closeActivePane();
      return;

    case 'next-pane':
      cyclePane(1);
      return;

    case 'search':
      searchOpen.value = true;
      return;

    case 'command-palette':
      paletteOpen.value = !paletteOpen.value;
      return;

    case 'settings':
      settingsOpen.value = !settingsOpen.value;
      return;

    case 'toggle-sidebar':
      sidebarOpen.value = !sidebarOpen.value;
      return;

    case 'font-bigger':
      adjustFont(1);
      return;

    case 'font-smaller':
      adjustFont(-1);
      return;

    case 'font-reset':
      setFontSize(defaultPrefs.font.size[deviceClass.value]);
      return;

    case 'clear-screen': {
      const id = activeSessionId.value;
      if (!id) return;
      const term = peekTerminal(id);
      // Send the shell's own clear rather than wiping the buffer locally, so
      // the server-side screen state stays in step with what you see.
      term?.paste('\f');
      return;
    }

    default: {
      const index = /^select-session-(\d)$/.exec(action);
      if (index) selectSessionByIndex(Number(index[1]) - 1);
    }
  }
}

function adjustFont(delta: number): void {
  const current = prefs.value.font.size[deviceClass.value];
  setFontSize(Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta)));
}
