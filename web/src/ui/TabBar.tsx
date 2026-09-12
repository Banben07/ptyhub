/**
 * The tab strip. Tabs address sessions, panes are viewports onto them: clicking
 * a tab shows that session in the pane you are focused on, and dragging one
 * into a pane moves or splits it there.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { runAction } from '../actions.ts';
import { beginTabDrag, drag } from '../dnd.ts';
import {
  activeSessionId,
  applyTabDrop,
  closeSession,
  focusSession,
  isPinned,
  orderedSessions,
  renameSession,
  renamingId,
  sessions,
  sidebarOpen,
  isMobile,
} from '../state.ts';
import { peekTerminal } from '../terminal/registry.ts';
import { CloseIcon, LockIcon, PinIcon, PlusIcon, SidebarIcon } from './icons.tsx';
import { TabMenu, type TabMenuTarget } from './TabMenu.tsx';

/** Hide the shell itself; showing "bash" on every tab tells you nothing. */
const BORING = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', '']);

export function TabBar() {
  const [menu, setMenu] = useState<TabMenuTarget | null>(null);
  const dragging = drag.value;
  const insertAt =
    dragging?.target?.kind === 'tabs' ? dragging.target.index : null;

  return (
    <div class="tabbar">
      {!isMobile.value && (
        <button
          class="icon-btn"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          onClick={() => (sidebarOpen.value = !sidebarOpen.value)}
        >
          <SidebarIcon />
        </button>
      )}

      <div class="tabs" role="tablist" data-tabstrip>
        {orderedSessions.value.map((session, index) => (
          <>
            {insertAt === index && <span class="tab-insert" key={`ins-${index}`} />}
            <Tab key={session.id} id={session.id} onMenu={setMenu} />
          </>
        ))}
        {insertAt === orderedSessions.value.length && <span class="tab-insert" />}
      </div>

      <button
        class="icon-btn"
        title="New terminal"
        aria-label="New terminal"
        onClick={() => runAction('new-session')}
      >
        <PlusIcon />
      </button>

      {menu && <TabMenu target={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Tab({
  id,
  onMenu,
}: {
  id: string;
  onMenu: (target: TabMenuTarget) => void;
}) {
  const session = sessions.value.find((s) => s.id === id);
  const term = peekTerminal(id);
  const active = activeSessionId.value === id;
  const renaming = renamingId.value === id;
  const beingDragged = drag.value?.sessionId === id;
  const longPress = useRef<number | null>(null);
  if (!session) return null;

  const proc = BORING.has(session.fgProc) ? null : session.fgProc;
  const unread = !active && term?.unread.value === true;

  const openMenu = (x: number, y: number) => onMenu({ sessionId: id, x, y });

  return (
    <div
      class={
        `tab${active ? ' active' : ''}${session.alive ? '' : ' dead'}` +
        `${beingDragged ? ' dragging' : ''}${session.locked ? ' locked' : ''}`
      }
      role="tab"
      aria-selected={active}
      data-tab-id={id}
      onPointerDown={(event) => {
        if (renaming || event.button === 2) return;
        // A press that travels becomes a drag; one that does not stays a click.
        beginTabDrag(event, id, session.name, {
          onDrop: (target) => applyTabDrop(id, target),
        });
        // Long press opens the menu on touch, where there is no right button.
        if (event.pointerType === 'touch') {
          longPress.current = window.setTimeout(
            () => openMenu(event.clientX, event.clientY),
            500,
          );
        }
      }}
      onPointerUp={() => {
        if (longPress.current !== null) clearTimeout(longPress.current);
        longPress.current = null;
      }}
      onClick={() => {
        if (!drag.value) focusSession(id);
      }}
      onDblClick={() => (renamingId.value = id)}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      }}
      title={`${session.name}${proc ? ` — ${proc}` : ''}\n${session.cwd}`}
    >
      {unread && <span class="dot" aria-label="new output" />}
      {isPinned(id) && <PinIcon size={11} class="tab-badge" />}
      {session.locked && <LockIcon size={11} class="tab-badge lock" />}

      {renaming ? (
        <RenameField id={id} initial={session.name} />
      ) : (
        <>
          <span class="tab-name">{session.name}</span>
          {proc && <span class="tab-proc">{proc}</span>}
          {!session.alive && <span class="tab-proc dim">exited</span>}
        </>
      )}

      <button
        class="tab-close"
        aria-label={session.locked ? 'Locked — unlock to close' : 'Close terminal'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void closeSession(id);
        }}
      >
        {session.locked ? <LockIcon size={13} /> : <CloseIcon size={13} />}
      </button>
    </div>
  );
}

function RenameField({ id, initial }: { id: string; initial: string }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      class="tab-rename"
      value={initial}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => void renameSession(id, event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') void renameSession(id, event.currentTarget.value);
        if (event.key === 'Escape') renamingId.value = null;
      }}
    />
  );
}
