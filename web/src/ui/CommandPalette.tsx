/**
 * Command palette: jump to a terminal or run any action, without needing to
 * remember which key it is bound to.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  actions,
  directShortcutFor,
  shortcutFor,
  type ActionId,
} from '../../../src/shared/keymap.ts';
import { runAction } from '../actions.ts';
import { focusSession, keymap, paletteOpen, sessions } from '../state.ts';
import { TerminalIcon } from './icons.tsx';

interface Entry {
  key: string;
  label: string;
  hint: string;
  group: string;
  run: () => void;
}

/** Subsequence match, the usual "type the initials" behaviour. */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  let at = 0;
  for (const ch of needle.toLowerCase()) {
    const found = lower.indexOf(ch, at);
    if (found < 0) return null;
    // Consecutive and word-start matches rank higher.
    score += found === at ? 3 : 1;
    if (found === 0 || /[\s\-_/·]/.test(lower[found - 1] ?? '')) score += 2;
    at = found + 1;
  }
  return score - haystack.length * 0.01;
}

export function CommandPalette() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const entries = useMemo<Entry[]>(() => {
    const sessionEntries: Entry[] = sessions.value.map((session) => ({
      key: `session:${session.id}`,
      label: session.name,
      hint: session.alive ? (session.fgProc || 'shell') : 'exited',
      group: 'Terminals',
      run: () => focusSession(session.id),
    }));

    const actionEntries: Entry[] = actions.map((action) => {
      // Prefer the direct Mac-style chord when it is actually active — it is
      // the shorter, more familiar hint for whoever turned that layer on.
      const direct = keymap.value.direct ? directShortcutFor(keymap.value, action.id) : null;
      return {
        key: `action:${action.id}`,
        label: action.label,
        hint: direct ?? shortcutFor(keymap.value, action.id as ActionId) ?? '',
        group: action.group,
        run: () => runAction(action.id),
      };
    });

    return [...sessionEntries, ...actionEntries];
  }, [sessions.value, keymap.value]);

  const results = useMemo(() => {
    const scored = entries
      .map((entry) => ({ entry, score: fuzzyScore(query, `${entry.label} ${entry.hint}`) }))
      .filter((row): row is { entry: Entry; score: number } => row.score !== null)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 40).map((row) => row.entry);
  }, [entries, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    paletteOpen.value = false;
    entry.run();
  };

  return (
    <div class="overlay" onPointerDown={() => (paletteOpen.value = false)}>
      <div class="palette" onPointerDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          class="palette-input"
          placeholder="Jump to a terminal, or run a command…"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((c) => Math.min(results.length - 1, c + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(results[cursor]);
            } else if (event.key === 'Escape') {
              paletteOpen.value = false;
            }
          }}
        />
        <div class="palette-list">
          {results.length === 0 && <div class="palette-empty">Nothing matches.</div>}
          {results.map((entry, index) => (
            <button
              key={entry.key}
              class={`palette-row${index === cursor ? ' selected' : ''}`}
              onPointerEnter={() => setCursor(index)}
              onClick={() => choose(entry)}
            >
              {entry.group === 'Terminals' && <TerminalIcon size={14} class="palette-icon" />}
              <span class="palette-label">{entry.label}</span>
              <span class="palette-group">{entry.group}</span>
              {entry.hint && <span class="palette-hint">{entry.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
