/** WebSocket recovery shared by terminals and the session list. A dead route
 * can leave a socket OPEN indefinitely, so onclose alone is not sufficient. */
export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';

const CONNECT_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 5_000;
const PONG_TIMEOUT_MS = 15_000;
const RESUME_TIMEOUT_MS = 8_000;
const STABLE_MS = 10_000;
const MIN_RETRY_MS = 300;
const MAX_RETRY_MS = 5_000;
const MAX_INPUT_BACKLOG = 64 * 1024;

interface Handlers {
  url(): string;
  state(state: SocketState): void;
  /** Call ready after applying the initial snapshot. It returns false if that
   * connection was replaced while an asynchronous terminal write was pending. */
  message(data: string | ArrayBuffer, ready: () => boolean): void;
  latency?(ms: number | null): void;
}

export class ReconnectingSocket {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private usable = false;
  private backoff = MIN_RETRY_MS;
  private readyAt = 0;
  private pendingPing: number | null = null;
  private pingSequence = 0;
  private pingSentAt = 0;
  private resumeProbe = false;

  constructor(private readonly handlers: Handlers) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
    this.handlers.state('connecting');
    this.connect();
  }

  private connect(): void {
    if (!this.running || this.socket) return;
    if (!navigator.onLine) {
      this.handlers.state('reconnecting');
      return;
    }
    const socket = new WebSocket(this.handlers.url());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.arm(CONNECT_TIMEOUT_MS, () => this.failed(socket));
    socket.onopen = () => {
      if (this.socket === socket) this.arm(SYNC_TIMEOUT_MS, () => this.failed(socket));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === 'string') {
        let msg: { t?: string; ts?: number } | null;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'pong') {
          // Incoming output alone doesn't prove that the upstream path works.
          if (this.pendingPing !== null && msg.ts === this.pendingPing) {
            this.pendingPing = null;
            this.resumeProbe = false;
            this.handlers.latency?.(Math.max(0, Date.now() - this.pingSentAt));
            if (Date.now() - this.readyAt >= STABLE_MS) this.backoff = MIN_RETRY_MS;
            this.arm(PING_INTERVAL_MS, () => this.probe());
          }
          return;
        }
      }
      // A slow but progressing snapshot must not restart from scratch.
      if (!this.usable) this.arm(SYNC_TIMEOUT_MS, () => this.failed(socket));
      this.handlers.message(event.data as string | ArrayBuffer, () => {
        if (this.socket !== socket || !this.running) return false;
        if (!this.usable) {
          this.usable = true;
          this.readyAt = Date.now();
          this.handlers.state('open');
          this.probe();
        }
        return true;
      });
    };
    socket.onclose = () => this.failed(socket);
    socket.onerror = () => this.failed(socket);
  }

  private arm(ms: number, action: () => void): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      action();
    }, ms);
  }

  private probe(): void {
    const socket = this.socket;
    if (!socket || !this.usable || this.pendingPing !== null) return;
    this.pingSentAt = Date.now();
    this.pendingPing = ++this.pingSequence;
    this.arm(PONG_TIMEOUT_MS, () => this.failed(socket));
    try {
      socket.send(JSON.stringify({ t: 'ping', ts: this.pendingPing }));
    } catch {
      this.failed(socket);
    }
  }

  private release(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    this.usable = false;
    this.pendingPing = null;
    this.resumeProbe = false;
    this.handlers.latency?.(null);
    if (socket) {
      // Start recovery without waiting for a close handshake on a broken route.
      // Late events must never clear or write into the replacement connection.
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  private failed(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.release();
    if (!this.running) return;
    this.handlers.state('reconnecting');
    this.schedule();
  }

  private schedule(): void {
    if (this.retry !== null || !this.running || !navigator.onLine) return;
    // Jitter keeps tabs and panes from all reconnecting at the same instant.
    const delay = Math.min(MAX_RETRY_MS, this.backoff * (0.8 + Math.random() * 0.4));
    this.backoff = Math.min(this.backoff * 2, MAX_RETRY_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  /** Never replay input already submitted to a socket: the shell may have
   * executed it even if the reply was lost. Callers must surface a false result. */
  send(data: string | Uint8Array): boolean {
    const socket = this.socket;
    if (!this.usable || !socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_INPUT_BACKLOG) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      this.failed(socket);
      return false;
    }
  }

  /** Probe a woken page without discarding a healthy connection. A fresh probe
   * gets a grace period even when the previous deadline expired during sleep. */
  nudge(): void {
    if (!this.running || !navigator.onLine) return;
    if (!this.socket) {
      if (this.retry !== null) clearTimeout(this.retry);
      this.retry = null;
      this.connect();
    } else if (this.usable && !this.resumeProbe) {
      this.pendingPing = null;
      this.resumeProbe = true;
      this.probe();
      const socket = this.socket;
      if (socket) this.arm(RESUME_TIMEOUT_MS, () => this.failed(socket));
    }
  }

  private offline = (): void => {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.release();
    this.handlers.state('reconnecting');
  };

  private online = (): void => this.nudge();

  stop(): void {
    this.running = false;
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.release();
    this.handlers.state('closed');
  }
}
