/**
 * Right-click menu for a tab.
 *
 * Home for the things that should not be one stray click away — locking,
 * pinning, closing — and the place to discover that they exist at all. The
 * terminal's own right-click still pastes; only the tab opens this.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  closeSession,
  isPinned,
  renamingId,
  sessions,
  setSessionLock,
  togglePinned,
} from '../state.ts';
import { runAction } from '../actions.ts';
import { CloseIcon, LockIcon, PencilIcon, PinIcon, SplitRightIcon, UnlockIcon } from './icons.tsx';

export interface TabMenuTarget {
  sessionId: string;
  x: number;
  y: number;
}

export function TabMenu({
  target,
  onClose,
}: {
  target: TabMenuTarget;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const session = sessions.value.find((s) => s.id === target.sessionId);

  useEffect(() => {
    const dismiss = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture so the terminal does not swallow the keystroke first.
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Keep the menu on screen when the tab is near the right edge.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
  }, []);

  if (!session) return null;

  const item = (
    label: string,
    icon: ComponentChildren,
    run: () => void,
    danger = false,
  ) => (
    <button
      class={`menu-item${danger ? ' danger' : ''}`}
      onClick={() => {
        onClose();
        run();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      class="tab-menu"
      role="menu"
      style={{ left: `${target.x}px`, top: `${target.y}px` }}
    >
      {item('Rename', <PencilIcon size={14} />, () => {
        renamingId.value = session.id;
      })}

      {item(
        isPinned(session.id) ? 'Unpin' : 'Pin to front',
        <PinIcon size={14} />,
        () => togglePinned(session.id),
      )}

      {item(
        session.locked ? 'Unlock' : 'Lock (prevent closing)',
        session.locked ? <UnlockIcon size={14} /> : <LockIcon size={14} />,
        () => void setSessionLock(session.id, !session.locked),
      )}

      {item('Split right', <SplitRightIcon size={14} />, () => runAction('split-right'))}

      <div class="menu-sep" />

      {item(
        session.locked ? 'Close (locked)' : 'Close',
        <CloseIcon size={14} />,
        () => void closeSession(session.id),
        true,
      )}
    </div>
  );
}
