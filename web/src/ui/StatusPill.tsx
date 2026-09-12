/**
 * Connection status, matching what the favicon is showing. Expands to the
 * details worth having when something looks wrong: round-trip time, which link
 * is down, and the version running.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { runAction } from '../actions.ts';
import {
  activeSessionId,
  eventsConnected,
  health,
  ptydStatus,
  settingsOpen,
} from '../state.ts';
import { peekTerminal } from '../terminal/registry.ts';
import { SearchIcon, SettingsIcon } from './icons.tsx';

export function StatusPill() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Clicking anywhere outside the pill or its popover closes it, the way any
  // other dropdown behaves — previously the only way out was clicking the
  // pill a second time.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const ptyd = ptydStatus.value;
  const events = eventsConnected.value;
  const term = activeSessionId.value ? peekTerminal(activeSessionId.value) : undefined;
  const termState = term?.state.value;
  const latency = term?.latencyMs.value ?? null;

  const level =
    ptyd === 'down' ? 'down'
    : ptyd === 'connecting' || !events || termState === 'reconnecting' ? 'warn'
    : 'ok';

  const label =
    level === 'down' ? 'ptyd unreachable'
    : level === 'warn' ? 'Reconnecting'
    : 'Connected';

  return (
    <div class="status-area" ref={containerRef}>
      <button class="icon-btn" title="Search in terminal" onClick={() => runAction('search')}>
        <SearchIcon />
      </button>
      <button
        class="icon-btn"
        title="Settings"
        onClick={() => (settingsOpen.value = !settingsOpen.value)}
      >
        <SettingsIcon />
      </button>

      <button
        class={`status-pill ${level}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={label}
      >
        <span class="status-dot" />
        <span class="status-label">{label}</span>
        {latency !== null && level === 'ok' && (
          <span class="status-latency">{latency} ms</span>
        )}
      </button>

      {open && (
        <div class="status-popover" role="dialog">
          <Row label="ptyd" value={ptyd} state={ptyd === 'connected' ? 'ok' : 'bad'} />
          <Row
            label="Event channel"
            value={events ? 'connected' : 'disconnected'}
            state={events ? 'ok' : 'bad'}
          />
          <Row
            label="Terminal socket"
            value={termState ?? 'none'}
            state={termState === 'open' ? 'ok' : termState ? 'bad' : 'neutral'}
          />
          {latency !== null && <Row label="Round trip" value={`${latency} ms`} state="neutral" />}
          <Row label="Version" value={health.value?.version ?? '—'} state="neutral" />
          <p class="status-note">
            Sessions keep running in ptyd whatever happens to this page.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: 'ok' | 'bad' | 'neutral';
}) {
  return (
    <div class="status-row">
      <span class="status-row-label">{label}</span>
      <span class={`status-row-value ${state}`}>{value}</span>
    </div>
  );
}
