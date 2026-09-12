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

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';

const PADDING = 10;
/** Below this the pane is mid-layout, not genuinely tiny. */
const MIN_USABLE_COLS = 8;
const MIN_USABLE_ROWS = 3;
const RECONNECT_MIN_MS = 300;
const RECONNECT_MAX_MS = 10_000;
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

  private readonly scaler: HTMLDivElement;
  private readonly mount: HTMLDivElement;
  private readonly observer: ResizeObserver;

  private ws: WebSocket | null = null;
  private webgl: WebglAddon | null = null;
  private opened = false;
  private disposed = false;
  private focused = false;
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private resizeTimer: number | null = null;
  private pingTimer: number | null = null;
  private proposedCols = 0;
  private proposedRows = 0;
  private viewers = 1;
  private lastClaim = 0;
  private options: TerminalOptionsSource;

  constructor(
    readonly id: string,
    options: TerminalOptionsSource,
  ) {
    this.options = options;

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

    this.term.onData((data) => this.sendInput(data));
    this.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
      this.sendBytes(bytes);
    });

    this.observer = new ResizeObserver(() => this.scheduleMeasure());
    this.observer.observe(this.host);
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
      this.connect();
    }
    this.scheduleMeasure();
  }

  unmount(): void {
    this.host.remove();
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

  private connect(): void {
    if (this.disposed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const size =
      this.proposedCols > 0
        ? `?cols=${this.proposedCols}&rows=${this.proposedRows}`
        : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws/sessions/${this.id}${size}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.state.value = this.state.value === 'closed' ? 'connecting' : this.state.value;

    ws.onopen = () => {
      this.backoff = RECONNECT_MIN_MS;
      this.state.value = 'open';
      this.startPing();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleControl(JSON.parse(ev.data) as ServerWsMessage);
        return;
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      this.term.write(bytes);
      if (!this.focused) this.unread.value = true;
    };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.disposed) return;
      this.state.value = 'reconnecting';
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // `onclose` always follows; retry logic lives there.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.disposed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Reconnect right now, e.g. when the tab becomes visible again. */
  nudge(): void {
    if (this.disposed || this.ws) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = RECONNECT_MIN_MS;
    this.connect();
  }

  private handleControl(msg: ServerWsMessage): void {
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
        // snapshot bytes arrive, or the restored screen would wrap wrong.
        this.term.reset();
        this.applyServerSize(msg.session.cols, msg.session.rows);
        break;

      case 'ready':
        this.applyServerSize(msg.cols, msg.rows);
        this.scheduleMeasure();
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
        this.latencyMs.value = Date.now() - msg.ts;
        break;

      case 'error':
        this.term.write(`\r\n\x1b[31m[ptyhub: ${msg.message}]\x1b[0m\r\n`);
        break;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.sendControl({ t: 'ping', ts: Date.now() });
    }, 15_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
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
   * Whether this viewer sets the session's window size.
   *
   * A phone in "scale" mode normally yields, so joining a session a laptop is
   * driving does not squeeze the laptop's shell. But when it is the only client
   * attached there is nobody to yield to, and deferring would leave it staring
   * at somebody else's old geometry shrunk to a third of its size.
   */
  private shouldDrive(): boolean {
    return this.options.drivesSize || this.viewers <= 1;
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

    const availW = this.host.clientWidth - PADDING * 2;
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
    if (this.shouldDrive() && (cols !== this.term.cols || rows !== this.term.rows)) {
      this.proposedCols = cols;
      this.proposedRows = rows;
      // Resize locally straight away so dragging the window feels immediate;
      // ptyd confirms with a `resized` message a moment later.
      this.term.resize(cols, rows);
      this.sendControl({ t: 'resize', cols, rows });
    }
    this.applyScale();
  }

  /** Fit the authoritative grid into our pane without reflowing the shell. */
  private applyScale(): void {
    const cell = this.cellSize();
    if (!cell) return;
    const naturalW = cell.w * this.term.cols + PADDING * 2;
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

  private sendControl(msg: ClientWsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendInput(data: string): void {
    // Typing is the clearest statement of which client is in use.
    this.claimSize();
    this.sendBytes(new TextEncoder().encode(data));
  }

  private sendBytes(bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  /** Type text into the session, used by the mobile key bar and the palette. */
  paste(text: string): void {
    this.sendInput(text);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.observer.disconnect();
    this.ws?.close();
    this.ws = null;
    this.term.dispose();
    this.host.remove();
    this.state.value = 'closed';
  }
}
