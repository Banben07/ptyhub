/**
 * Renders the split layout and mounts terminals into panes.
 *
 * The terminal DOM is owned by the registry, not by these components. A pane
 * only decides where an existing node should live; switching tabs moves a node
 * rather than building a new one.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { LayoutNode, SplitNode } from '../layout.ts';
import { leaves, setRatio } from '../layout.ts';
import { drag } from '../dnd.ts';
import { runAction } from '../actions.ts';
import {
  activePaneId,
  assignSessionToPane,
  closePaneById,
  createSession,
  focusPane,
  layoutRoot,
  liveSessions,
  sessions,
} from '../state.ts';
import { getTerminal, peekTerminal } from '../terminal/registry.ts';
import {
  CloseIcon,
  PlusIcon,
  SplitDownIcon,
  SplitRightIcon,
  TerminalIcon,
} from './icons.tsx';

export function PaneTree() {
  return <PaneNode node={layoutRoot.value} />;
}

function PaneNode({ node }: { node: LayoutNode }) {
  if (node.kind === 'leaf') return <TerminalPane paneId={node.id} sessionId={node.sessionId} />;
  return <SplitView node={node} />;
}

function SplitView({ node }: { node: SplitNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent) => {
    const container = ref.current;
    if (!container) return;
    event.preventDefault();
    setDragging(true);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    const move = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio =
        node.direction === 'row'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      layoutRoot.value = setRatio(layoutRoot.value, node.id, ratio);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const first = `${(node.ratio * 100).toFixed(2)}%`;
  return (
    <div
      ref={ref}
      class={`split ${node.direction}${dragging ? ' dragging' : ''}`}
      style={{
        gridTemplate:
          node.direction === 'row'
            ? `1fr / ${first} 8px 1fr`
            : `${first} 8px 1fr / 1fr`,
      }}
    >
      <PaneNode node={node.first} />
      <div
        class="splitter"
        role="separator"
        aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
        onPointerDown={onPointerDown}
      />
      <PaneNode node={node.second} />
    </div>
  );
}

function TerminalPane({ paneId, sessionId }: { paneId: string; sessionId: string | null }) {
  const slot = useRef<HTMLDivElement>(null);
  const active = activePaneId.value === paneId;

  useEffect(() => {
    const host = slot.current;
    if (!host || !sessionId) return;
    const term = getTerminal(sessionId);
    term.attachTo(host);
    if (active) term.focus();
    return () => {
      // Detach only; the terminal keeps running and keeps its buffer.
      if (term.host.parentElement === host) term.unmount();
    };
  }, [sessionId, paneId]);

  const meta = sessions.value.find((s) => s.id === sessionId) ?? null;
  const term = sessionId ? peekTerminal(sessionId) : undefined;
  const state = term?.state.value;
  const exited = term?.exited.value ?? (meta && !meta.alive ? { code: meta.exitCode, signal: meta.exitSignal } : null);
  const splitOpen = leaves(layoutRoot.value).length > 1;

  const dragging = drag.value;
  const dropZone =
    dragging?.target?.kind === 'pane' && dragging.target.paneId === paneId
      ? dragging.target.zone
      : null;

  return (
    <div
      class={`pane${active ? ' active' : ''}`}
      onPointerDown={() => focusPane(paneId)}
      data-pane={paneId}
    >
      {/* Shows exactly what the drop will produce: the whole pane, or the half
          the terminal is about to occupy. */}
      {dropZone && <div class={`drop-hint ${dropZone}`} />}

      {/* Closing a split needs to be reachable by pointer, not only by
          shortcut — otherwise a pane with nothing in it has no way out. */}
      {splitOpen && (
        <div class="pane-tools">
          <button
            class="pane-tool"
            title="Split right"
            aria-label="Split this pane to the right"
            onClick={(event) => {
              event.stopPropagation();
              focusPane(paneId);
              runAction('split-right');
            }}
          >
            <SplitRightIcon size={14} />
          </button>
          <button
            class="pane-tool danger"
            title="Close pane"
            aria-label="Close this pane"
            onClick={(event) => {
              event.stopPropagation();
              closePaneById(paneId);
            }}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {sessionId ? (
        <>
          <div class="pane-slot" ref={slot} />
          {state === 'reconnecting' && (
            <div class="pane-banner warn">Reconnecting…</div>
          )}
          {exited && (
            <div class="pane-banner">
              Process exited{exited.code !== null ? ` with code ${exited.code}` : ''}.
            </div>
          )}
        </>
      ) : (
        <EmptyPane paneId={paneId} canClose={splitOpen} />
      )}
    </div>
  );
}

/**
 * What you see in a pane with nothing in it. There is always an obvious way to
 * get a terminal from here — never a dead end that says you have none.
 */
function EmptyPane({ paneId, canClose }: { paneId: string; canClose: boolean }) {
  const available = liveSessions.value;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && activePaneId.value === paneId) {
        event.preventDefault();
        void createSession();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneId]);

  return (
    <div class="empty-pane">
      <div class="empty-card">
        <TerminalIcon size={28} class="empty-icon" />
        <h2>No terminal in this pane</h2>
        <p>Start a new one, or move an existing terminal here.</p>
        <div class="empty-actions">
          <button class="btn primary" onClick={() => void createSession()}>
            <PlusIcon /> New terminal <kbd>Enter</kbd>
          </button>
          <button class="btn" onClick={() => runAction('split-right')}>
            <SplitRightIcon /> Split right
          </button>
          <button class="btn" onClick={() => runAction('split-down')}>
            <SplitDownIcon /> Split down
          </button>
          {canClose && (
            <button class="btn danger" onClick={() => closePaneById(paneId)}>
              <CloseIcon /> Close pane
            </button>
          )}
        </div>
        {available.length > 0 && (
          <div class="empty-list">
            <span class="muted">Move here:</span>
            {available.map((session) => (
              <button
                key={session.id}
                class="chip"
                onClick={() => assignSessionToPane(paneId, session.id)}
              >
                {session.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
