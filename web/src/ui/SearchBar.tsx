/** Find text in the active terminal's buffer, including its scrollback. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { activeSessionId, searchOpen, theme } from '../state.ts';
import { peekTerminal } from '../terminal/registry.ts';
import { CloseIcon, ChevronIcon } from './icons.tsx';

export function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  const term = activeSessionId.value ? peekTerminal(activeSessionId.value) : undefined;

  useEffect(() => {
    inputRef.current?.focus();
    return () => term?.search.clearDecorations();
  }, []);

  const options = {
    caseSensitive,
    decorations: {
      matchBackground: theme.value.selectionBackground,
      activeMatchBackground: theme.value.ui.accent,
      matchOverviewRuler: theme.value.ui.accent,
      activeMatchColorOverviewRuler: theme.value.ui.accent,
    },
  };

  const find = (direction: 'next' | 'prev', value = query) => {
    if (!term || !value) return;
    if (direction === 'next') term.search.findNext(value, options);
    else term.search.findPrevious(value, options);
  };

  const close = () => {
    term?.search.clearDecorations();
    searchOpen.value = false;
    term?.focus();
  };

  return (
    <div class="searchbar">
      <input
        ref={inputRef}
        class="search-input"
        placeholder="Find in terminal"
        value={query}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          find('next', event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') find(event.shiftKey ? 'prev' : 'next');
          if (event.key === 'Escape') close();
        }}
      />
      <button
        class={`icon-btn small${caseSensitive ? ' on' : ''}`}
        title="Match case"
        onClick={() => setCaseSensitive(!caseSensitive)}
      >
        Aa
      </button>
      <button class="icon-btn small" title="Previous" onClick={() => find('prev')}>
        <ChevronIcon size={13} class="rot-up" />
      </button>
      <button class="icon-btn small" title="Next" onClick={() => find('next')}>
        <ChevronIcon size={13} class="rot-down" />
      </button>
      <button class="icon-btn small" title="Close" onClick={close}>
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
