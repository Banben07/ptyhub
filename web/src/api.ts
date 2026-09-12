/**
 * REST client. Every call goes through here so authentication failures have a
 * single place to surface from.
 */

import type { PtydStatus, ResizePolicy, SessionMeta } from '../../src/shared/protocol.ts';
import type { Prefs } from '../../src/shared/prefs.ts';
import type { SharedKeymap } from '../../src/shared/keymap.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  get unauthenticated(): boolean {
    return this.status === 401;
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON bodies only happen for static fallbacks.
    }
  }

  if (!res.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'http_error',
      error?.message ?? `${method} ${path} failed with ${res.status}`,
    );
  }
  return json as T;
}

export interface Health {
  ok: boolean;
  version: string;
  ptyd: PtydStatus;
  autoCreateFirstSession: boolean;
  resizePolicy: ResizePolicy;
  user: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  user: string | null;
  openAccess: boolean;
  passwordConfigured: boolean;
}

export interface DeviceSummary {
  id: string;
  label: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
}

export const api = {
  health: () => call<Health>('GET', '/api/health'),

  authStatus: () => call<AuthStatus>('GET', '/api/auth/status'),

  login: (user: string, password: string, remember: boolean) =>
    call<{ user: string }>('POST', '/api/auth/login', { user, password, remember }),

  pair: (k: string) => call<{ user: string }>('POST', '/api/auth/pair', { k }),

  logout: () => call<{ ok: true }>('POST', '/api/auth/logout'),

  devices: () => call<{ devices: DeviceSummary[] }>('GET', '/api/auth/devices'),

  revokeDevice: (id: string) => call<{ ok: true }>('DELETE', `/api/auth/devices/${id}`),

  listSessions: () => call<{ sessions: SessionMeta[] }>('GET', '/api/sessions'),

  createSession: (opts: {
    name?: string;
    cwd?: string;
    argv?: string[];
    cols?: number;
    rows?: number;
  }) => call<{ session: SessionMeta }>('POST', '/api/sessions', opts),

  ensureSession: (cols: number, rows: number) =>
    call<{ session: SessionMeta | null; created: boolean }>(
      'POST',
      '/api/sessions/ensure',
      { cols, rows },
    ),

  renameSession: (id: string, name: string) =>
    call<{ session: SessionMeta }>('PATCH', `/api/sessions/${id}`, { name }),

  setSessionLock: (id: string, locked: boolean) =>
    call<{ session: SessionMeta }>('PATCH', `/api/sessions/${id}`, { locked }),

  killSession: (id: string, opts: { signal?: string; force?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (opts.signal) query.set('signal', opts.signal);
    if (opts.force) query.set('force', '1');
    const suffix = query.size > 0 ? `?${query}` : '';
    return call<{ id: string }>('DELETE', `/api/sessions/${id}${suffix}`);
  },

  prefs: () => call<{ prefs: Prefs }>('GET', '/api/prefs'),

  savePrefs: (prefs: Partial<Prefs>) =>
    call<{ prefs: Prefs }>('PUT', '/api/prefs', { prefs }),

  // Only the shared half — what each key does. Whether either layer is
  // active right now never leaves this browser; see local-shortcuts.ts.
  keymap: () => call<{ keymap: SharedKeymap }>('GET', '/api/keymap'),

  saveKeymap: (keymap: SharedKeymap) =>
    call<{ keymap: SharedKeymap }>('PUT', '/api/keymap', { keymap }),
};
