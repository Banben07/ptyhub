/**
 * The virtual key bar.
 *
 * A phone keyboard has no Esc, no Tab, no Ctrl and no arrows, which makes vim,
 * less and any interactive CLI unusable. Ctrl and Alt latch for one keystroke,
 * so Ctrl then C sends an interrupt.
 */

import { useState } from 'preact/hooks';
import { activeSessionId, isMobile } from '../state.ts';
import { peekTerminal } from '../terminal/registry.ts';

interface KeyDef {
  label: string;
  /** Raw sequence, or a letter that gets transformed when a modifier latches. */
  send?: string;
  letter?: string;
  wide?: boolean;
}

const ROW_ONE: KeyDef[] = [
  { label: 'Esc', send: '\x1b' },
  { label: 'Tab', send: '\t' },
  { label: 'Ctrl' },
  { label: 'Alt' },
  { label: '↑', send: '\x1b[A' },
  { label: '↓', send: '\x1b[B' },
  { label: '←', send: '\x1b[D' },
  { label: '→', send: '\x1b[C' },
];

const ROW_TWO: KeyDef[] = [
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '/', send: '/' },
  { label: '-', send: '-' },
  { label: '_', send: '_' },
  { label: '$', send: '$' },
  { label: '^C', letter: 'c' },
  { label: '^D', letter: 'd' },
  { label: '^Z', letter: 'z' },
];

export function MobileKeys() {
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);

  if (!isMobile.value) return null;

  const send = (text: string) => {
    const id = activeSessionId.value;
    if (!id) return;
    peekTerminal(id)?.paste(text);
  };

  const press = (key: KeyDef) => {
    if (key.label === 'Ctrl') {
      setCtrl(!ctrl);
      return;
    }
    if (key.label === 'Alt') {
      setAlt(!alt);
      return;
    }

    if (key.letter) {
      // Explicit control keys like ^C ignore the latches.
      send(String.fromCharCode(key.letter.toUpperCase().charCodeAt(0) - 64));
      return;
    }

    let text = key.send ?? '';
    if (ctrl && text.length === 1 && /[a-z@[\]\\^_]/i.test(text)) {
      text = String.fromCharCode(text.toUpperCase().charCodeAt(0) - 64);
      setCtrl(false);
    }
    if (alt) {
      text = `\x1b${text}`;
      setAlt(false);
    }
    send(text);
  };

  const render = (keys: KeyDef[]) =>
    keys.map((key) => {
      const latched =
        (key.label === 'Ctrl' && ctrl) || (key.label === 'Alt' && alt);
      return (
        <button
          key={key.label}
          class={`vkey${latched ? ' latched' : ''}${key.wide ? ' wide' : ''}`}
          // Keep the software keyboard up: focus must not leave the terminal.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => press(key)}
        >
          {key.label}
        </button>
      );
    });

  return (
    <div class="vkeys">
      <div class="vkey-row">{render(ROW_ONE)}</div>
      <div class="vkey-row">{render(ROW_TWO)}</div>
    </div>
  );
}
