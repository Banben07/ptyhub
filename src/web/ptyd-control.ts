/**
 * The gateway's long-lived control connection to ptyd.
 *
 * The gateway is deliberately stateless about sessions: it caches metadata only
 * to answer the UI quickly, and re-syncs from ptyd on every reconnect. If ptyd
 * is briefly unreachable the gateway keeps serving and retrying rather than
 * dying, because a restarting gateway must never look like a lost session.
 */

import type { Event, PtydStatus, SessionMeta } from '../shared/protocol.ts';
import { PtydClient, PtydError } from '../shared/ptyd-client.ts';

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

export class PtydControl {
  private client: PtydClient | null = null;
  private status: PtydStatus = 'connecting';
  private retryDelay = RECONNECT_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private sessions = new Map<string, SessionMeta>();

  private readonly eventListeners = new Set<(evt: Event) => void>();
  private readonly statusListeners = new Set<(status: PtydStatus) => void>();

  constructor(
    private readonly socketFile: string,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.close();
    this.client = null;
  }

  get currentStatus(): PtydStatus {
    return this.status;
  }

  /** Cached session list; authoritative as long as the control link is up. */
  listCached(): SessionMeta[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  onEvent(listener: (evt: Event) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: PtydStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** The live client, or a typed failure the REST layer turns into a 503. */
  require(): PtydClient {
    if (!this.client || this.client.isClosed) {
      throw new PtydError('ptyd_unavailable', 'ptyd is not reachable');
    }
    return this.client;
  }

  // -------------------------------------------------------------------------

  private setStatus(status: PtydStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.client ? 'connecting' : this.status);

    PtydClient.connect(this.socketFile, {
      onEvent: (evt) => this.handleEvent(evt),
      onClose: () => this.handleClose(),
    })
      .then(async (client) => {
        this.client = client;
        this.retryDelay = RECONNECT_MIN_MS;
        try {
          const sessions = await client.list();
          this.sessions = new Map(sessions.map((s) => [s.id, s]));
        } catch (err) {
          this.log(`initial session sync failed: ${String(err)}`);
        }
        this.setStatus('connected');
        this.log('control connection to ptyd established');
      })
      .catch((err) => {
        this.client = null;
        this.setStatus('down');
        this.scheduleRetry(err as Error);
      });
  }

  private handleClose(): void {
    if (this.stopped) return;
    this.client = null;
    this.setStatus('down');
    this.scheduleRetry(new Error('control connection closed'));
  }

  private scheduleRetry(err: Error): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
    this.log(`ptyd unreachable (${err.message}); retrying in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /** Keep the metadata cache in step, then pass the event on to the UI. */
  private handleEvent(evt: Event): void {
    switch (evt.ev) {
      case 'created':
        this.sessions.set(evt.session.id, evt.session);
        break;
      case 'removed':
        this.sessions.delete(evt.id);
        break;
      case 'renamed':
        this.patch(evt.id, { name: evt.name });
        break;
      case 'proc':
        this.patch(evt.id, { fgProc: evt.fgProc });
        break;
      case 'title':
        this.patch(evt.id, { title: evt.title });
        break;
      case 'resized':
        this.patch(evt.id, { cols: evt.cols, rows: evt.rows });
        break;
      case 'viewers':
        this.patch(evt.id, { viewers: evt.viewers });
        break;
      case 'locked':
        this.patch(evt.id, { locked: evt.locked });
        break;
      case 'exited':
        this.patch(evt.id, {
          alive: false,
          exitCode: evt.exitCode,
          exitSignal: evt.exitSignal,
          exitedAt: Date.now(),
          fgProc: '',
        });
        break;
      case 'ready':
        break;
    }
    for (const listener of this.eventListeners) listener(evt);
  }

  private patch(id: string, fields: Partial<SessionMeta>): void {
    const current = this.sessions.get(id);
    if (current) this.sessions.set(id, { ...current, ...fields });
  }
}
