/**
 * One attached terminal in the browser.
 *
 * Instances live in a module-level registry, not in the component tree, and
 * their DOM is created once and moved between panes. Switching tabs therefore
 * never disposes a terminal, never re-replays a snapshot, and never drops
 * scroll position.
 *
 * Sizing has two halves. We propose the size our pane can display; ptyd decides
 * the authoritative size across every attached client and tells us what it
 * picked. Whenever those differ — a phone looking at a session a laptop is
 * driving — we render at the authoritative size and scale the whole terminal to
 * fit, rather than reflowing the shell out from under the other viewer.
 */

import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import { signal, type Signal } from '@preact/signals';
import type {
  ClientWsMessage,
  ServerWsMessage,
  SessionMeta,
} from '../../../src/shared/protocol.ts';
import type { Prefs } from '../../../src/shared/prefs.ts';
import { resolveFontFamily } from '../../../src/shared/prefs.ts';
import { resolveTheme, xtermTheme } from '../theme.ts';
import { ReconnectingSocket, type SocketState } from '../reconnecting-socket.ts';

export type ConnState = SocketState;

const PADDING = 10;
/** Below this the pane is mid-layout, not genuinely tiny. */
const MIN_USABLE_COLS = 8;
const MIN_USABLE_ROWS = 3;
const RESIZE_DEBOUNCE_MS = 80;

export interface TerminalOptionsSource {
  prefs: Prefs;
  fontSize: number;
  /** False on phones in "scale" mode: we watch, we do not drive the size. */
  drivesSize: boolean;
}

export class SessionTerminal {
  readonly host: HTMLDivElement;
  readonly term: Terminal;
  readonly search: SearchAddon;

  readonly state: Signal<ConnState> = signal<ConnState>('connecting');
  readonly unread = signal(false);
  readonly meta: Signal<SessionMeta | null> = signal<SessionMeta | null>(null);
  readonly exited = signal<{ code: number | null; signal: number | null } | null>(null);
  readonly latencyMs = signal<number | null>(null);
  readonly inputNotice = signal<string | null>(null);

  private readonly scaler: HTMLDivElement;
  private readonly mount: HTMLDivElement;
  private readonly observer: ResizeObserver;

  private readonly connection: ReconnectingSocket;
  private webgl: WebglAddon | null = null;
  private opened = false;
  private disposed = false;
  private focused = false;
  private sentInput = false;
  private resizeTimer: number | null = null;
  private proposedCols = 0;
  private proposedRows = 0;
  private viewers = 1;
  /** True while the snapshot from a (re)connect is being parsed. */
  private replaying = false;
  private lastClaim = 0;
  private savedScroll: { line: number; atBottom: boolean } | null = null;
  private options: TerminalOptionsSource;

  constructor(
    readonly id: string,
    options: TerminalOptionsSource,
  ) {
    this.options = options;
    this.connection = new ReconnectingSocket({
      url: () => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const size = this.proposedCols > 0 && this.inUse()
          ? `?cols=${this.proposedCols}&rows=${this.proposedRows}`
          : '';
        return `${proto}//${location.host}/ws/sessions/${this.id}${size}`;
      },
      state: (state) => {
        if (state === 'reconnecting' && this.sentInput) {
          this.inputNotice.value ??= 'Connection interrupted. Check the last command before typing it again.';
          this.sentInput = false;
        }
        this.state.value = state;
      },
      latency: (ms) => { this.latencyMs.value = ms; },
      message: (data, ready) => {
        if (typeof data === 'string') {
          this.handleControl(JSON.parse(data) as ServerWsMessage, ready);
        } else {
          this.term.write(new Uint8Array(data));
          if (!this.focused) this.unread.value = true;
        }
      },
    });

    this.host = document.createElement('div');
    this.host.className = 'term-host';
    this.scaler = document.createElement('div');
    this.scaler.className = 'term-scaler';
    this.mount = document.createElement('div');
    this.mount.className = 'term-mount';
    this.scaler.appendChild(this.mount);
    this.host.appendChild(this.scaler);

    const theme = resolveTheme(options.prefs);
    this.term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      fontFamily: resolveFontFamily(options.prefs),
      fontSize: options.fontSize,
      lineHeight: options.prefs.font.lineHeight,
      letterSpacing: options.prefs.font.letterSpacing,
      cursorStyle: options.prefs.cursorStyle,
      cursorBlink: options.prefs.cursorBlink,
      scrollback: options.prefs.scrollback,
      theme: xtermTheme(theme),
      macOptionIsMeta: true,
      // Option-drag selects text even while a program has captured the mouse
      // (Claude Code's fullscreen mode, vim with `mouse=a`). Other platforms
      // get the same bypass with Shift, which xterm always honours.
      macOptionClickForcesSelection: true,
      // The shell owns the screen; a local right-click menu would fight it.
      rightClickSelectsWord: false,
    });

    this.search = new SearchAddon();
    this.term.loadAddon(this.search);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    if (options.prefs.linkify) {
      this.term.loadAddon(new WebLinksAddon());
    }

    this.term.onSelectionChange(() => {
      if (!this.options.prefs.copyOnSelect) return;
      const selection = this.term.getSelection();
      if (selection) {
        void navigator.clipboard?.writeText(selection).catch(() => {
          // Clipboard writes need a secure context; ignore when unavailable.
        });
      }
    });

    // OSC 52: a program asking the terminal to put text on the clipboard. It
    // is how full-screen programs copy — Claude Code's fullscreen mode copies
    // its own mouse selection this way whenever it thinks it is on the far end
    // of SSH, which from a browser it always effectively is. Writes only; a
    // program reading the clipboard back ("?") is never answered.
    this.term.parser.registerOscHandler(52, (data) => {
      this.handleClipboardWrite(data);
      return true;
    });

    this.term.onData((data) => this.sendInput(data));
    this.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
      this.sendBytes(bytes);
    });

    this.observer = new ResizeObserver(() => this.scheduleMeasure());
    this.observer.observe(this.host);
    this.installTouchScroll();
  }

  /**
   * Let a finger scroll programs that own the whole screen.
   *
   * A full-screen program (Claude Code's fullscreen mode, less, vim) has no
   * scrollback for the finger to move; it scrolls itself in response to the
   * mouse wheel. And once such a program turns on mouse reporting, xterm stops
   * looking at touches entirely. So a one-finger vertical drag is turned into
   * wheel events, one per row travelled, handed to xterm's own wheel handling:
   * it reports them to a program that asked for the mouse, and turns them into
   * arrow keys for one that did not — the same as a real wheel would.
   *
   * Ordinary shell output is left to xterm's native touch scrolling.
   */
  private installTouchScroll(): void {
    let lastY: number | null = null;
    let carry = 0;
    const ownsScreen = () =>
      this.term.buffer.active.type === 'alternate' ||
      this.term.modes.mouseTrackingMode !== 'none';

    this.host.addEventListener(
      'touchstart',
      (ev) => {
        lastY = ev.touches.length === 1 && ownsScreen() ? ev.touches[0]!.clientY : null;
        carry = 0;
      },
      { passive: true, capture: true },
    );

    this.host.addEventListener(
      'touchmove',
      (ev) => {
        if (lastY === null || ev.touches.length !== 1) return;
        const touch = ev.touches[0]!;
        // Keep the page from scrolling or bouncing instead. Cancelling the
        // first move also stops the browser synthesising a click at the end,
        // so a drag is never mistaken for a tap by the program.
        ev.preventDefault();
        carry += lastY - touch.clientY;
        lastY = touch.clientY;

        const screen = this.mount.querySelector('.xterm-screen');
        if (!screen) return;
        // On screen, so it already accounts for any scale-to-fit transform.
        const rowHeight = screen.getBoundingClientRect().height / this.term.rows;
        if (!(rowHeight > 0)) return;
        while (Math.abs(carry) >= rowHeight) {
          const direction = Math.sign(carry);
          carry -= direction * rowHeight;
          // Finger moving up means content moves up: later lines, wheel down.
          screen.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: direction,
              deltaMode: WheelEvent.DOM_DELTA_LINE,
              clientX: touch.clientX,
              clientY: touch.clientY,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      { passive: false, capture: true },
    );

    const end = () => {
      lastY = null;
    };
    this.host.addEventListener('touchend', end, { capture: true });
    this.host.addEventListener('touchcancel', end, { capture: true });
  }

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------

  attachTo(parent: HTMLElement): void {
    if (this.host.parentElement === parent) return;
    parent.appendChild(this.host);

    if (!this.opened) {
      this.opened = true;
      this.term.open(this.mount);
      this.syncRenderer();
      this.mount.addEventListener('contextmenu', (event) => {
        if (!this.options.prefs.rightClickPaste) return;
        event.preventDefault();
        void navigator.clipboard
          ?.readText()
          .then((text) => text && this.paste(text))
          .catch(() => {
            // Clipboard read can be denied; nothing useful to do about it.
          });
      });
      this.term.element?.addEventListener('focusin', () => {
        this.focused = true;
        this.unread.value = false;
        this.claimSize();
      });
      this.term.element?.addEventListener('focusout', () => {
        this.focused = false;
      });
      this.connection.start();
    }
    this.scheduleMeasure();
    this.restoreScroll();
  }

  unmount(): void {
    // Taking the node out of the document discards the viewport's scroll
    // position, so remember it. Without this, coming back to a tab lands you at
    // the top of the scrollback instead of at the newest output.
    const buffer = this.term.buffer.active;
    this.savedScroll = {
      line: buffer.viewportY,
      atBottom: buffer.viewportY >= buffer.baseY,
    };
    this.host.remove();
  }

  /**
   * Put the viewport back where it was, or at the newest output.
   *
   * Re-attaching the node resets the scroll container's `scrollTop` to zero
   * while xterm still believes it is wherever it was. Nothing reconciles the
   * two until the next scroll event, which is why one notch of the wheel used
   * to fling the view somewhere else.
   *
   * Simply asking for the position we want is not enough: if xterm already
   * holds that position the call is a no-op and it never rewrites `scrollTop`.
   * So move somewhere else first, forcing a genuine change that makes xterm
   * synchronise the DOM, then move to where we actually want to be.
   */
  private restoreScroll(): void {
    const saved = this.savedScroll;
    // After a layout pass: the viewport has no scroll range until it is sized.
    requestAnimationFrame(() => {
      const buffer = this.term.buffer.active;
      if (buffer.baseY === 0) return; // Nothing to scroll; scrollTop 0 is right.

      const target =
        !saved || saved.atBottom ? buffer.baseY : Math.min(saved.line, buffer.baseY);
      this.forceScrollTo(target);
    });
  }

  /** Move the view to `line` in a way that always rewrites the DOM scrollTop. */
  private forceScrollTo(line: number): void {
    const buffer = this.term.buffer.active;
    if (buffer.baseY === 0) return;
    this.term.scrollToLine(line === 0 ? buffer.baseY : 0);
    this.term.scrollToLine(line);
  }

  focus(): void {
    this.term.focus();
    this.unread.value = false;
  }

  /**
   * Pick a renderer. WebGL keeps heavy output smooth but cannot draw ligatures,
   * so turning ligatures on drops back to the DOM renderer, which can. This is
   * the only real trade-off behind that switch and the settings copy says so.
   */
  private syncRenderer(): void {
    if (!this.opened) return;
    const wantsWebgl = !this.options.prefs.font.ligatures;

    if (wantsWebgl && !this.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          this.webgl = null;
        });
        this.term.loadAddon(webgl);
        this.webgl = webgl;
      } catch {
        // No WebGL available; the DOM renderer is a fine fallback.
      }
    } else if (!wantsWebgl && this.webgl) {
      this.webgl.dispose();
      this.webgl = null;
    }

    const screen = this.mount.querySelector('.xterm') as HTMLElement | null;
    if (screen) {
      screen.style.fontVariantLigatures = this.options.prefs.font.ligatures
        ? 'normal'
        : 'none';
    }
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /** Probe even a socket that still appears open after sleep or a route change. */
  nudge(): void {
    this.connection.nudge();
  }

  private handleControl(msg: ServerWsMessage, ready: () => boolean): void {
    switch (msg.t) {
      case 'viewers':
        this.viewers = msg.viewers;
        this.scheduleMeasure();
        break;

      case 'hello':
        this.meta.value = msg.session;
        this.viewers = msg.session.viewers;
        this.exited.value = msg.session.alive
          ? null
          : { code: msg.session.exitCode, signal: msg.session.exitSignal };
        // Reset then size to the authoritative geometry, both before the
        // snapshot bytes are parsed, or the restored screen would wrap wrong.
        // The reset goes through the write queue: xterm's `reset()` does not
        // discard bytes from the previous socket that are still waiting to be
        // parsed, so calling it directly would let a stale screenful land on
        // top of the fresh terminal. The resize stays synchronous so that the
        // later, authoritative size from `ready` is the one that sticks.
        this.term.write(new Uint8Array(0), () => {
          if (this.disposed) return;
          this.term.reset();
          this.replaying = true;
        });
        this.applyServerSize(msg.session.cols, msg.session.rows);
        break;

      case 'ready':
        this.term.write(new Uint8Array(0), () => {
          if (this.disposed || !ready()) return;
          this.replaying = false;
          this.scheduleMeasure();
        });
        this.applyServerSize(msg.cols, msg.rows);
        this.scheduleMeasure();
        // The snapshot has just replayed a screenful of scrollback; show the
        // end of it, which is what the session actually looks like now.
        this.savedScroll = null;
        requestAnimationFrame(() => this.forceScrollTo(this.term.buffer.active.baseY));
        break;

      case 'resized':
        this.applyServerSize(msg.cols, msg.rows);
        break;

      case 'proc':
        if (this.meta.value) {
          this.meta.value = { ...this.meta.value, fgProc: msg.fgProc };
        }
        break;

      case 'title':
        if (this.meta.value) {
          this.meta.value = { ...this.meta.value, title: msg.title };
        }
        break;

      case 'exit': {
        this.exited.value = { code: msg.exitCode, signal: msg.exitSignal };
        const how: string[] = [];
        if (msg.exitCode !== null) how.push(`code ${msg.exitCode}`);
        if (msg.exitSignal) how.push(`signal ${msg.exitSignal}`);
        this.term.write(
          `\r\n\x1b[2m[process exited${how.length ? ` with ${how.join(', ')}` : ''}]\x1b[0m\r\n`,
        );
        break;
      }

      case 'pong':
        // Consumed by the shared connection watchdog.
        break;

      case 'error':
        this.term.write(`\r\n\x1b[31m[ptyhub: ${msg.message}]\x1b[0m\r\n`);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  private applyServerSize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (cols !== this.term.cols || rows !== this.term.rows)) {
      this.term.resize(cols, rows);
    }
    this.applyScale();
  }

  private scheduleMeasure(): void {
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.measure();
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Cell metrics read back from the renderer. More reliable than guessing from
   * the font, and correct for any font, ligature setting or zoom level.
   */
  private cellSize(): { w: number; h: number } | null {
    const screen = this.mount.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen || this.term.cols === 0 || this.term.rows === 0) return null;
    const w = screen.offsetWidth / this.term.cols;
    const h = screen.offsetHeight / this.term.rows;
    return w > 0 && h > 0 ? { w, h } : null;
  }

  /**
   * Width to keep clear on the right for the scrollbar.
   *
   * xterm paints `.xterm-screen` above `.xterm-viewport` — both are positioned
   * and the screen comes later in the DOM — so a grid sized to the full width
   * draws straight over the scrollbar and it can be neither seen nor grabbed.
   *
   * This cannot be measured from the element: on platforms with overlay
   * scrollbars `offsetWidth - clientWidth` is zero even though the scrollbar is
   * drawn, and it is still covered. So the gutter comes from the stylesheet,
   * which is also what sets the scrollbar's width.
   */
  private scrollbarWidth(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      '--term-scrollbar',
    );
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 14;
  }

  /**
   * Whether this viewer sets the session's window size.
   *
   * A phone in "scale" mode normally yields, so joining a session a laptop is
   * driving does not squeeze the laptop's shell. But when it is the only client
   * attached there is nobody to yield to, and deferring would leave it staring
   * at somebody else's old geometry shrunk to a third of its size.
   */
  /**
   * Put text a program sent via OSC 52 on the clipboard.
   *
   * Skipped while a reconnect replays the screen, so old output cannot
   * overwrite whatever was copied since, and on pages nobody is looking at, so
   * a second device watching the same session does not copy along.
   */
  private handleClipboardWrite(data: string): void {
    if (this.replaying || !document.hasFocus()) return;
    const semi = data.indexOf(';');
    if (semi < 0) return;
    const payload = data.slice(semi + 1);
    if (payload === '' || payload === '?') return;

    let text: string;
    try {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch {
      return; // Not base64; nothing sensible to copy.
    }
    void writeClipboard(text);
  }

  private shouldDrive(): boolean {
    return this.options.drivesSize || this.viewers <= 1;
  }

  /**
   * Whether somebody is looking at this page right now.
   *
   * Under the "active client wins" policy every size a viewer declares takes
   * the window, so a hidden tab or an unfocused window must stay quiet. When
   * it is the only viewer there is nobody to take the window from.
   */
  private inUse(): boolean {
    if (this.viewers <= 1) return true;
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  /**
   * Say "this is the client being used" and take the window size back.
   *
   * Focus alone is not a reliable signal here: two devices are two independent
   * browsers, and the desktop keeps DOM focus the whole time somebody is
   * typing on their phone. So clicking into a pane and typing both claim it,
   * throttled so ordinary typing does not turn into a stream of resizes.
   */
  claimSize(): void {
    const now = Date.now();
    if (now - this.lastClaim < 500) return;
    this.lastClaim = now;
    this.measure();
  }

  private measure(): void {
    if (!this.opened || this.disposed) return;
    const cell = this.cellSize();
    if (!cell) return;

    const availW = this.host.clientWidth - PADDING * 2 - this.scrollbarWidth();
    const availH = this.host.clientHeight - PADDING * 2;

    // A pane that is hidden, detached, or still being laid out reports a size
    // that would compute to a two-column terminal. Proposing that would really
    // resize the shell, so wait: the ResizeObserver fires again once the pane
    // has its final size.
    const laidOut = availW >= cell.w * MIN_USABLE_COLS && availH >= cell.h * MIN_USABLE_ROWS;
    if (!laidOut) {
      this.applyScale();
      return;
    }

    const cols = Math.max(2, Math.floor(availW / cell.w));
    const rows = Math.max(1, Math.floor(availH / cell.h));

    // Compare against the size the session is actually at, not against what we
    // last asked for. That way focusing a pane whose window no longer matches
    // hands control back to it — which is what the "active client wins" policy
    // is supposed to mean, and what makes a phone and a laptop usable in turn.
    if (
      this.shouldDrive() &&
      this.inUse() &&
      (cols !== this.term.cols || rows !== this.term.rows)
    ) {
      this.proposedCols = cols;
      this.proposedRows = rows;
      // Resize locally straight away so dragging the window feels immediate;
      // ptyd confirms with a `resized` message a moment later.
      // Don't change geometry while a snapshot is still being parsed. The
      // ready callback measures again once input and resizing are safe.
      if (this.state.value === 'open' && this.sendControl({ t: 'resize', cols, rows })) {
        this.term.resize(cols, rows);
      }
    }
    this.applyScale();
  }

  /** Fit the authoritative grid into our pane without reflowing the shell. */
  private applyScale(): void {
    const cell = this.cellSize();
    if (!cell) return;
    const naturalW = cell.w * this.term.cols + PADDING * 2 + this.scrollbarWidth();
    const naturalH = cell.h * this.term.rows + PADDING * 2;
    const scale = Math.min(
      1,
      this.host.clientWidth / naturalW,
      this.host.clientHeight / naturalH,
    );
    if (scale > 0.995) {
      this.scaler.style.transform = '';
      this.scaler.style.width = '100%';
      this.scaler.style.height = '100%';
    } else {
      this.scaler.style.transform = `scale(${scale})`;
      this.scaler.style.width = `${naturalW}px`;
      this.scaler.style.height = `${naturalH}px`;
    }
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  /**
   * Redraw after a font becomes available.
   *
   * The WebGL renderer caches rasterised glyphs in a texture atlas, so a font
   * that finishes loading after the first paint would otherwise never appear —
   * the cached boxes would keep being drawn.
   */
  refreshGlyphs(): void {
    this.webgl?.clearTextureAtlas();
    this.proposedCols = 0;
    this.proposedRows = 0;
    this.term.refresh(0, this.term.rows - 1);
    this.scheduleMeasure();
  }

  applyOptions(options: TerminalOptionsSource): void {
    this.options = options;
    const { prefs, fontSize } = options;
    const theme = resolveTheme(prefs);

    this.term.options.fontFamily = resolveFontFamily(prefs);
    this.term.options.fontSize = fontSize;
    this.term.options.lineHeight = prefs.font.lineHeight;
    this.term.options.letterSpacing = prefs.font.letterSpacing;
    this.term.options.cursorStyle = prefs.cursorStyle;
    this.term.options.cursorBlink = prefs.cursorBlink;
    this.term.options.scrollback = prefs.scrollback;
    this.term.options.theme = xtermTheme(theme);
    this.syncRenderer();

    // Cell metrics change with the font, so re-fit once the glyphs are ready.
    void document.fonts.ready.then(() => {
      this.proposedCols = 0;
      this.proposedRows = 0;
      this.scheduleMeasure();
    });
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  private sendControl(msg: ClientWsMessage): boolean {
    return this.connection.send(JSON.stringify(msg));
  }

  private sendInput(data: string): void {
    // Typing is the clearest statement of which client is in use.
    this.claimSize();
    this.sendBytes(new TextEncoder().encode(data));
  }

  private sendBytes(bytes: Uint8Array): void {
    if (this.connection.send(bytes)) {
      this.sentInput = true;
      this.inputNotice.value = null;
    } else {
      this.inputNotice.value = 'Input was not sent. Wait for the connection, then check the terminal before typing again.';
    }
  }

  /** Type text into the session, used by the mobile key bar and the palette. */
  paste(text: string): void {
    this.sendInput(text);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.stop();
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.observer.disconnect();
    this.term.dispose();
    this.host.remove();
    this.state.value = 'closed';
  }
}

/**
 * Write text to the clipboard. The async API needs a secure context (https or
 * localhost); over plain http to another host fall back to the old
 * select-and-copy trick, which works while the page still has focus.
 */
async function writeClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // Nothing else to try.
  } finally {
    area.remove();
    previous?.focus();
  }
}
