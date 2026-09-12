/** The tab following the pointer during a drag. */

import { drag } from '../dnd.ts';
import { TerminalIcon } from './icons.tsx';

export function DragGhost() {
  const state = drag.value;
  if (!state) return null;
  return (
    <div
      class="drag-ghost"
      style={{ left: `${state.x}px`, top: `${state.y}px` }}
      aria-hidden="true"
    >
      <TerminalIcon size={13} />
      <span>{state.label}</span>
    </div>
  );
}
