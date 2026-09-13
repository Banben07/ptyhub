/**
 * The session list. Shows more than the tab strip can: what is running, where
 * it is running, and how long it has been alive.
 */

import { useEffect } from 'preact/hooks';
import { runAction } from '../actions.ts';
import {
  activeSessionId,
  closeSession,
  focusSession,
  isMobile,
  isPinned,
  mobileSwitcherOpen,
  orderedSessions,
  renamingId,
  setSessionLock,
} from '../state.ts';
import { peekTerminal } from '../terminal/registry.ts';
import {
  CloseIcon,
  LockIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SplitDownIcon,
  SplitRightIcon,
  UnlockIcon,
} from './icons.tsx';

const BORING = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', '']);

function age(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function shortenPath(cwd: string): string {
  const home = cwd.match(/^\/(?:cluster\/)?home\/[^/]+/)?.[0];
  const short = home ? cwd.replace(home, '~') : cwd;
  const parts = short.split('/');
  return parts.length > 4 ? `…/${parts.slice(-2).join('/')}` : short;
}

export function Sidebar() {
  const overlay = isMobile.value;

  useEffect(() => {
    if (!overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        mobileSwitcherOpen.value = false;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [overlay]);

  return (
    <>
      {overlay && (
        <div class="mobile-switcher-backdrop" onClick={() => (mobileSwitcherOpen.value = false)} />
      )}
      <aside class={`sidebar${overlay ? ' mobile-overlay' : ''}`}>
      <div class="sidebar-head">
        <span class="sidebar-title">Terminals</span>
        <div class="sidebar-head-actions">
          <button class="icon-btn" title="Split right" onClick={() => runAction('split-right')}>
            <SplitRightIcon />
          </button>
          <button class="icon-btn" title="Split down" onClick={() => runAction('split-down')}>
            <SplitDownIcon />
          </button>
          <button class="icon-btn" title="New terminal" onClick={() => runAction('new-session')}>
            <PlusIcon />
          </button>
        </div>
      </div>

      <div class="session-list">
        {orderedSessions.value.length === 0 && (
          <button class="session-empty" onClick={() => runAction('new-session')}>
            <PlusIcon /> Create your first terminal
          </button>
        )}

        {orderedSessions.value.map((session) => {
          const active = activeSessionId.value === session.id;
          const term = peekTerminal(session.id);
          const proc = BORING.has(session.fgProc) ? null : session.fgProc;
          return (
            <div
              key={session.id}
              class={`session-row${active ? ' active' : ''}${session.alive ? '' : ' dead'}`}
              onClick={() => {
                focusSession(session.id);
                if (overlay) mobileSwitcherOpen.value = false;
              }}
            >
              <div class="session-main">
                {isPinned(session.id) && <PinIcon size={11} class="tab-badge" />}
                {session.locked && <LockIcon size={11} class="tab-badge lock" />}
                <span class="session-name">{session.name}</span>
                {!active && term?.unread.value && <span class="dot" />}
                <span class="session-proc">
                  {session.alive ? (proc ?? 'shell') : `exited ${session.exitCode ?? ''}`}
                </span>
              </div>
              <div class="session-meta">
                <span class="session-cwd" title={session.cwd}>
                  {shortenPath(session.cwd)}
                </span>
                <span class="session-age">
                  {session.cols}×{session.rows} · {age(session.createdAt)}
                </span>
              </div>
              <div class="session-actions">
                <button
                  class="icon-btn small"
                  title="Rename"
                  onClick={(event) => {
                    event.stopPropagation();
                    renamingId.value = session.id;
                  }}
                >
                  <PencilIcon size={13} />
                </button>
                <button
                  class="icon-btn small"
                  title={session.locked ? 'Unlock' : 'Lock (prevent closing)'}
                  onClick={(event) => {
                    event.stopPropagation();
                    void setSessionLock(session.id, !session.locked);
                  }}
                >
                  {session.locked ? <UnlockIcon size={13} /> : <LockIcon size={13} />}
                </button>
                <button
                  class="icon-btn small"
                  title={session.locked ? 'Locked — unlock to close' : 'Close'}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeSession(session.id);
                  }}
                >
                  <CloseIcon size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      </aside>
    </>
  );
}
