/**
 * Dragging a tab.
 *
 * Two destinations: somewhere else in the tab strip (reorder), or onto a pane
 * (show it there, or split that pane and show it in the new half).
 *
 * Built on pointer events rather than HTML5 drag-and-drop, which does not fire
 * on touch screens at all. Phones and tablets are a first-class target here, so
 * the native API is not an option.
 */

import { signal } from '@preact/signals';

/** How far the pointer must travel before a press becomes a drag, not a click. */
const DRAG_THRESHOLD_PX = 5;
/** Fraction of a pane's width/height that counts as an edge drop zone. */
const EDGE_FRACTION = 0.25;

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export type DropTarget =
  | { kind: 'pane'; paneId: string; zone: DropZone }
  | { kind: 'tabs'; index: number }
  | null;

export interface DragState {
  sessionId: string;
  label: string;
  x: number;
  y: number;
  target: DropTarget;
}

export const drag = signal<DragState | null>(null);

/**
 * Where a drop would land, from the element under the pointer.
 *
 * Panes are found by the `data-pane` attribute they already carry, and the tab
 * strip by `data-tabstrip`; no registry of rectangles to keep in sync.
 */
export function hitTest(x: number, y: number): DropTarget {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;

  const strip = element.closest<HTMLElement>('[data-tabstrip]');
  if (strip) {
    const tabs = [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')];
    let index = tabs.length;
    for (const [i, tab] of tabs.entries()) {
      const rect = tab.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) {
        index = i;
        break;
      }
    }
    return { kind: 'tabs', index };
  }

  const pane = element.closest<HTMLElement>('[data-pane]');
  if (pane) {
    const rect = pane.getBoundingClientRect();
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;

    // Whichever edge the pointer is nearest, if it is near one at all. Compared
    // as fractions so a tall narrow pane still behaves sensibly.
    const distances: { zone: DropZone; d: number }[] = [
      { zone: 'left', d: fx },
      { zone: 'right', d: 1 - fx },
      { zone: 'top', d: fy },
      { zone: 'bottom', d: 1 - fy },
    ];
    const nearest = distances.reduce((best, c) => (c.d < best.d ? c : best));
    const zone: DropZone = nearest.d < EDGE_FRACTION ? nearest.zone : 'center';
    return { kind: 'pane', paneId: pane.dataset.pane!, zone };
  }

  return null;
}

export interface DragHandlers {
  /** Called once the pointer has moved far enough to count as a drag. */
  onStart?: () => void;
  onDrop: (target: DropTarget) => void;
}

/**
 * Begin tracking a potential drag from a pointerdown on a tab.
 *
 * Returns true if the press was consumed as a drag; the caller keeps treating
 * a plain press as a click.
 */
export function beginTabDrag(
  event: PointerEvent,
  sessionId: string,
  label: string,
  handlers: DragHandlers,
): void {
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;

  const move = (ev: PointerEvent) => {
    if (!started) {
      const far =
        Math.abs(ev.clientX - startX) > DRAG_THRESHOLD_PX ||
        Math.abs(ev.clientY - startY) > DRAG_THRESHOLD_PX;
      if (!far) return;
      started = true;
      handlers.onStart?.();
      document.body.classList.add('dragging-tab');
    }
    // Stop the terminal from selecting text under the pointer mid-drag.
    ev.preventDefault();
    drag.value = {
      sessionId,
      label,
      x: ev.clientX,
      y: ev.clientY,
      target: hitTest(ev.clientX, ev.clientY),
    };
  };

  const finish = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('dragging-tab');
    if (!started) return;
    const target = hitTest(ev.clientX, ev.clientY);
    drag.value = null;
    handlers.onDrop(target);
  };

  const cancel = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('dragging-tab');
    drag.value = null;
  };

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}
