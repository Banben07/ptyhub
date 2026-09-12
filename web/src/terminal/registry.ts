/**
 * Module-level registry of live terminals.
 *
 * Deliberately outside the component tree: a re-render must never be able to
 * tear down a terminal. Components look terminals up by session id and mount
 * their existing DOM.
 */

import { SessionTerminal, type TerminalOptionsSource } from './session-terminal.ts';

const terminals = new Map<string, SessionTerminal>();
let optionsProvider: () => TerminalOptionsSource = () => {
  throw new Error('terminal options provider not installed');
};

export function setTerminalOptionsProvider(provider: () => TerminalOptionsSource): void {
  optionsProvider = provider;
}

export function getTerminal(id: string): SessionTerminal {
  let term = terminals.get(id);
  if (!term) {
    term = new SessionTerminal(id, optionsProvider());
    terminals.set(id, term);
  }
  return term;
}

export function peekTerminal(id: string): SessionTerminal | undefined {
  return terminals.get(id);
}

export function disposeTerminal(id: string): void {
  const term = terminals.get(id);
  if (!term) return;
  term.dispose();
  terminals.delete(id);
}

export function liveTerminalIds(): string[] {
  return [...terminals.keys()];
}

/** Push new preferences into every open terminal. */
export function applyOptionsToAll(): void {
  const options = optionsProvider();
  for (const term of terminals.values()) term.applyOptions(options);
}

/** Redraw every terminal after a font finished loading. */
export function refreshGlyphsInAll(): void {
  for (const term of terminals.values()) term.refreshGlyphs();
}

/**
 * Reconnect anything that went idle while the device was asleep. Mobile
 * browsers freeze timers in background tabs, so the backoff schedule alone
 * would leave a phone staring at a dead socket after it wakes.
 */
export function nudgeAll(): void {
  for (const term of terminals.values()) term.nudge();
}

/**
 * Whole scrollback of a terminal as plain text.
 *
 * The WebGL renderer draws to a canvas, so there is no DOM to read; this goes
 * through xterm's buffer instead. Used by the browser tests and handy when
 * something looks wrong in the console.
 */
export function readTerminalText(id: string): string {
  const term = terminals.get(id);
  if (!term) return '';
  const buffer = term.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

/**
 * Debugging seam. Everything here is already reachable from the page's own
 * JavaScript; exposing it grants no capability, and it makes the browser tests
 * able to see what the canvas renderer is drawing.
 */
(globalThis as unknown as Record<string, unknown>).__ptyhub = {
  ids: liveTerminalIds,
  read: readTerminalText,
  terminal: peekTerminal,
  size: (id: string) => {
    const term = terminals.get(id);
    return term ? { cols: term.term.cols, rows: term.term.rows } : null;
  },
  state: (id: string) => terminals.get(id)?.state.value ?? null,
  /** Viewport position and whether the scrollbar is actually reachable. */
  scroll: (id: string) => {
    const term = terminals.get(id);
    if (!term) return null;
    const buffer = term.term.buffer.active;
    const viewport = term.host.querySelector('.xterm-viewport') as HTMLElement | null;
    const screen = term.host.querySelector('.xterm-screen') as HTMLElement | null;
    // xterm keeps its own idea of the scroll position (viewportY) and the DOM
    // element keeps scrollTop. They must agree, or the next wheel event snaps
    // the view to wherever the element happens to be.
    const rowHeight = screen && term.term.rows > 0 ? screen.offsetHeight / term.term.rows : 0;
    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      atBottom: buffer.viewportY >= buffer.baseY,
      scrollTop: viewport?.scrollTop ?? 0,
      expectedScrollTop: buffer.viewportY * rowHeight,
      rowHeight,
      screenWidth: screen?.offsetWidth ?? 0,
      viewportWidth: viewport?.offsetWidth ?? 0,
      /** Non-zero means a real, always-visible scrollbar rather than an overlay. */
      scrollbarTakesSpace: viewport ? viewport.offsetWidth - viewport.clientWidth : 0,
      gutter: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--term-scrollbar'),
      ),
    };
  },
};
