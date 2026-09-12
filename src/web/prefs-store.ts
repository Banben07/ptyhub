/**
 * Server-side storage for appearance preferences, so a new device inherits your
 * theme and font instead of starting from defaults.
 */

import { paths, readJson, writeJson } from '../shared/config.ts';
import type { Prefs } from '../shared/prefs.ts';
import { defaultPrefs, normalizePrefs } from '../shared/prefs.ts';

export class PrefsStore {
  private cache: Prefs | null = null;

  read(): Prefs {
    if (!this.cache) {
      this.cache = normalizePrefs(readJson<unknown>(paths.prefs, defaultPrefs));
    }
    return this.cache;
  }

  /** Merge a partial update in, validate the result, persist it. */
  update(patch: unknown): Prefs {
    const current = this.read();
    const merged = {
      ...current,
      ...(patch as Partial<Prefs>),
      font: {
        ...current.font,
        ...((patch as Partial<Prefs>)?.font ?? {}),
        size: {
          ...current.font.size,
          ...((patch as Partial<Prefs>)?.font?.size ?? {}),
        },
      },
    };
    this.cache = normalizePrefs(merged);
    writeJson(paths.prefs, this.cache, 0o644);
    return this.cache;
  }
}
