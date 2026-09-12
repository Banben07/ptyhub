/**
 * Authentication endpoints. Kept apart from the session API because these are
 * the only routes reachable before a request is authenticated.
 */

import type { Auth } from './auth.ts';
import type { Ctx, Router } from './http-util.ts';
import { HttpError, readJsonBody, sendJson } from './http-util.ts';

/** Routes that must work without credentials. */
export const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/pair',
  '/api/auth/status',
  '/api/health',
]);

export function registerAuthRoutes(router: Router, auth: Auth): void {
  router.get('/api/auth/status', (ctx: Ctx) => {
    // Deliberately minimal: enough for the UI to decide whether to show the
    // login form, and nothing that helps someone who is not logged in.
    sendJson(ctx.res, 200, {
      authenticated: ctx.auth.user !== null,
      user: ctx.auth.user,
      openAccess: auth.openAccess,
      passwordConfigured: auth.passwordConfigured,
    });
  });

  router.post('/api/auth/login', async (ctx: Ctx) => {
    const body = await readJsonBody<{
      user?: unknown;
      password?: unknown;
      remember?: unknown;
    }>(ctx.req);

    const user = typeof body.user === 'string' ? body.user : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!user || !password) {
      throw new HttpError(400, 'bad_field', 'user and password are required');
    }

    const result = auth.login(ctx.req, ctx.res, user, password, body.remember === true);
    if (result.ok) {
      sendJson(ctx.res, 200, { user: result.user });
      return;
    }
    if (result.reason === 'locked') {
      ctx.res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
      throw new HttpError(
        429,
        'locked_out',
        'too many failed attempts; try again later',
      );
    }
    throw new HttpError(401, 'bad_credentials', 'incorrect user or password');
  });

  router.post('/api/auth/pair', async (ctx: Ctx) => {
    const body = await readJsonBody<{ k?: unknown }>(ctx.req);
    const key = typeof body.k === 'string' ? body.k : '';
    if (!key) throw new HttpError(400, 'bad_field', 'k is required');

    const user = auth.pair(ctx.req, ctx.res, key);
    if (!user) {
      throw new HttpError(401, 'bad_pairing', 'pairing link is invalid or used up');
    }
    sendJson(ctx.res, 200, { user });
  });

  router.post('/api/auth/logout', (ctx: Ctx) => {
    auth.logout(ctx.req, ctx.res, ctx.auth);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/auth/devices', (ctx: Ctx) => {
    sendJson(ctx.res, 200, { devices: auth.listDevices(ctx.auth.deviceId) });
  });

  router.delete('/api/auth/devices/:id', (ctx: Ctx) => {
    const removed =
      ctx.params.id === 'all'
        ? (auth.revokeAll(), true)
        : auth.removeDevice(ctx.params.id!);
    if (!removed) throw new HttpError(404, 'no_such_device', 'unknown device');
    // Revoking the device you are using logs you out immediately.
    if (ctx.params.id === 'all' || ctx.params.id === ctx.auth.deviceId) {
      auth.logout(ctx.req, ctx.res, ctx.auth);
    }
    sendJson(ctx.res, 200, { ok: true });
  });
}
