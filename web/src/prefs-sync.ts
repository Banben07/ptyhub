/** Serial, retryable preference writes. Pending edits stay in this page until
 * saved, so an older response cannot discard edits made while it was in flight. */
import type { Prefs } from '../../src/shared/prefs.ts';
import { ApiError } from './api.ts';

function mergePrefs(older: Partial<Prefs> | null, newer: Partial<Prefs>): Partial<Prefs> {
  const patch = { ...older, ...newer };
  if (older?.font && newer.font) {
    patch.font = { ...older.font, ...newer.font, size: { ...older.font.size, ...newer.font.size } };
  }
  return patch;
}

export class PendingSave<T> {
  private pending: T | null = null;
  private inFlight: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private blocked = false;
  private retryDelay = 1_000;
  private reported = false;

  constructor(
    private readonly save: (patch: T) => Promise<unknown>,
    private readonly report: (err: unknown) => void,
    private readonly merge: (older: T | null, newer: T) => T = (_older, newer) => newer,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('online', this.online);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    window.removeEventListener('online', this.online);
    this.cancelTimer();
  }

  enqueue(patch: T, delay = 400): void {
    this.pending = this.merge(this.pending, patch);
    this.schedule(delay);
  }

  /** Used after successful login/boot. Permanent failures stay paused until
   * then; an online event alone must not keep retrying rejected credentials. */
  resume(): void {
    this.blocked = false;
    this.schedule(0);
  }

  /** Includes unconfirmed writes, for pagehide's best-effort keepalive save. */
  snapshot(): T | null {
    if (this.inFlight && this.pending) return this.merge(this.inFlight, this.pending);
    return this.pending ?? this.inFlight;
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (!this.running || this.blocked || !this.pending || this.inFlight) return;
    this.cancelTimer();
    // Keep the pending data while offline; online schedules the next attempt.
    if (!navigator.onLine) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (!this.running || this.blocked || !this.pending || this.inFlight) return;
    const patch = this.pending;
    this.pending = null;
    this.inFlight = patch;
    let delay = 0;
    try {
      await this.save(patch);
      this.retryDelay = 1_000;
      this.reported = false;
    } catch (err) {
      // Edits made during the request win over the failed older patch.
      this.pending = this.pending ? this.merge(patch, this.pending) : patch;
      this.blocked = !(err instanceof ApiError && err.transient);
      delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      if (!this.reported && this.running) {
        this.reported = true;
        this.report(err);
      }
    } finally {
      this.inFlight = null;
      this.schedule(delay);
    }
  }

  private online = (): void => this.schedule(0);
}

export class PrefsSync extends PendingSave<Partial<Prefs>> {
  constructor(save: (patch: Partial<Prefs>) => Promise<unknown>, report: (err: unknown) => void) {
    super(save, report, mergePrefs);
  }
}
