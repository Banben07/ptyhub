/**
 * Minimal HTTP plumbing: a pattern router, JSON helpers, and the security
 * headers every response gets. No framework — the surface here is a dozen
 * routes and a WebSocket upgrade.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

export interface AuthContext {
  /** Resolved account name, or null when the request is unauthenticated. */
  user: string | null;
  /** Opaque id of the device credential used, if any. */
  deviceId: string | null;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  auth: AuthContext;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // A terminal must never be framable; that would be a one-click shell.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, 'body_too_large', 'request body too large');
    }
    chunks.push(buf);
  }
  if (total === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
  }
}

// ---------------------------------------------------------------------------

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  /** Returns the matched handler and path params, or null. */
  match(
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        } else if (seg !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  /** True when the path exists under a different method, for a 405. */
  pathExists(pathname: string): boolean {
    const parts = pathname.split('/').filter(Boolean);
    return this.routes.some(
      (route) =>
        route.segments.length === parts.length &&
        route.segments.every((seg, i) => seg.startsWith(':') || seg === parts[i]),
    );
  }
}

// ---------------------------------------------------------------------------

export function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Origin check for state-changing requests and WebSocket upgrades.
 *
 * SameSite cookies do not fully cover the WebSocket handshake, so without this
 * any website the user visits could open a socket to their terminal. Requests
 * with no Origin header at all are non-browser clients (curl, the CLI) and are
 * allowed; browsers always send one for these.
 */
export function originAllowed(
  req: IncomingMessage,
  extraAllowed: readonly string[],
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (extraAllowed.includes(origin)) return true;

  const host = req.headers.host;
  if (host && parsed.host === host) return true;

  // Vite's dev server runs on another port against the same gateway.
  if (
    process.env.NODE_ENV !== 'production' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }
  return false;
}
