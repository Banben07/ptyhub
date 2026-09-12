/**
 * The REST surface. Thin by design: every session operation is forwarded to
 * ptyd, which is the only component that knows anything real about a session.
 */

import type { Config } from '../shared/config.ts';
import { paths, readJson, writeJson } from '../shared/config.ts';
import { defaultSharedKeymap, normalizeSharedKeymap } from '../shared/keymap.ts';
import { PtydError } from '../shared/ptyd-client.ts';
import { VERSION } from '../shared/version.ts';
import type { Ctx, Router } from './http-util.ts';
import { HttpError, readJsonBody, sendJson } from './http-util.ts';
import type { PtydControl } from './ptyd-control.ts';
import type { PrefsStore } from './prefs-store.ts';

export interface RestDeps {
  control: PtydControl;
  cfg: Config;
  prefs: PrefsStore;
}

interface CreateBody {
  name?: unknown;
  cwd?: unknown;
  argv?: unknown;
  cols?: unknown;
  rows?: unknown;
}

function str(value: unknown, field: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'bad_field', `${field} must be a string`);
  }
  return value.slice(0, max);
}

function num(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, 'bad_field', `${field} must be a number`);
  }
  return n;
}

function argvOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new HttpError(400, 'bad_field', 'argv must be an array of strings');
  }
  if (value.length === 0) return undefined;
  return value as string[];
}

/** Translate a ptyd-level failure into the right HTTP status. */
export function httpStatusForPtydError(err: PtydError): number {
  switch (err.code) {
    case 'no_such_session':
      return 404;
    case 'bad_name':
    case 'bad_op':
      return 400;
    case 'session_locked':
      return 409;
    case 'ptyd_unavailable':
    case 'closed':
      return 503;
    case 'timeout':
      return 504;
    default:
      return 500;
  }
}

export function registerRestRoutes(router: Router, deps: RestDeps): void {
  const { control, cfg, prefs } = deps;

  // Public, but only barely: an unauthenticated caller learns that ptyhub is
  // running and which version, which is what a liveness probe needs and nothing
  // more. Session and configuration detail requires credentials.
  router.get('/api/health', (ctx: Ctx) => {
    if (ctx.auth.user === null) {
      sendJson(ctx.res, 200, { ok: true, version: VERSION });
      return;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      version: VERSION,
      ptyd: control.currentStatus,
      autoCreateFirstSession: cfg.autoCreateFirstSession,
      resizePolicy: cfg.resizePolicy,
      user: ctx.auth.user,
    });
  });

  router.get('/api/sessions', async (ctx: Ctx) => {
    // Served from ptyd directly so the answer is never a stale mirror.
    const sessions = await control.require().list();
    sendJson(ctx.res, 200, { sessions });
  });

  router.post('/api/sessions', async (ctx: Ctx) => {
    const body = await readJsonBody<CreateBody>(ctx.req);
    const session = await control.require().create({
      name: str(body.name, 'name', 128),
      cwd: str(body.cwd, 'cwd'),
      argv: argvOf(body.argv),
      cols: num(body.cols, 'cols'),
      rows: num(body.rows, 'rows'),
    });
    sendJson(ctx.res, 201, { session });
  });

  /**
   * Used by the UI on load so it never lands on an empty screen. Serialized so
   * that opening three tabs at once cannot create three sessions.
   */
  let ensuring: Promise<{ session: unknown; created: boolean }> | null = null;
  router.post('/api/sessions/ensure', async (ctx: Ctx) => {
    const body = await readJsonBody<{ cols?: unknown; rows?: unknown }>(ctx.req);
    if (!ensuring) {
      ensuring = (async () => {
        const client = control.require();
        const sessions = await client.list();
        const live = sessions.filter((s) => s.alive);
        if (live.length > 0) return { session: live[0]!, created: false };
        if (!cfg.autoCreateFirstSession) return { session: null, created: false };
        const session = await client.create({
          cols: num(body.cols, 'cols'),
          rows: num(body.rows, 'rows'),
        });
        return { session, created: true };
      })().finally(() => {
        ensuring = null;
      });
    }
    sendJson(ctx.res, 200, await ensuring);
  });

  router.get('/api/sessions/:id', async (ctx: Ctx) => {
    const session = await control.require().get(ctx.params.id!);
    sendJson(ctx.res, 200, { session });
  });

  router.patch('/api/sessions/:id', async (ctx: Ctx) => {
    const body = await readJsonBody<{ name?: unknown; locked?: unknown }>(ctx.req);
    const name = str(body.name, 'name', 128);
    const locked = body.locked;
    if (name === undefined && typeof locked !== 'boolean') {
      throw new HttpError(400, 'bad_field', 'name or locked is required');
    }

    const client = control.require();
    let session = await client.get(ctx.params.id!);
    if (typeof locked === 'boolean') {
      session = await client.setLock(ctx.params.id!, locked);
    }
    if (name !== undefined) {
      session = await client.rename(ctx.params.id!, name);
    }
    sendJson(ctx.res, 200, { session });
  });

  router.delete('/api/sessions/:id', async (ctx: Ctx) => {
    const signal = ctx.url.searchParams.get('signal') ?? undefined;
    const force = ctx.url.searchParams.get('force') === '1';
    await control.require().kill(ctx.params.id!, signal, force);
    sendJson(ctx.res, 200, { id: ctx.params.id });
  });

  router.post('/api/sessions/:id/resize', async (ctx: Ctx) => {
    const body = await readJsonBody<{ cols?: unknown; rows?: unknown }>(ctx.req);
    const cols = num(body.cols, 'cols');
    const rows = num(body.rows, 'rows');
    if (cols === undefined || rows === undefined) {
      throw new HttpError(400, 'bad_field', 'cols and rows are required');
    }
    const size = await control.require().resize(ctx.params.id!, cols, rows);
    sendJson(ctx.res, 200, { id: ctx.params.id, ...size });
  });

  router.get('/api/prefs', (ctx: Ctx) => {
    sendJson(ctx.res, 200, { prefs: prefs.read() });
  });

  router.put('/api/prefs', async (ctx: Ctx) => {
    const body = await readJsonBody<{ prefs?: unknown }>(ctx.req);
    sendJson(ctx.res, 200, { prefs: prefs.update(body.prefs ?? body) });
  });

  // What each key does — synced across devices, the same way theme and font
  // are. Whether either layer is *active* right now is a per-device decision
  // the browser keeps to itself in localStorage; the server never sees it.
  router.get('/api/keymap', (ctx: Ctx) => {
    const stored = readJson<unknown>(paths.keymap, defaultSharedKeymap);
    const keymap = normalizeSharedKeymap(stored);
    // Persist migrations so the file on disk matches what the UI is using.
    if (JSON.stringify(stored) !== JSON.stringify(keymap)) {
      try {
        writeJson(paths.keymap, keymap, 0o644);
      } catch {
        // Serving the migrated keymap matters more than recording it.
      }
    }
    sendJson(ctx.res, 200, { keymap });
  });

  router.put('/api/keymap', async (ctx: Ctx) => {
    const body = await readJsonBody<{ keymap?: unknown }>(ctx.req);
    const keymap = normalizeSharedKeymap(body.keymap ?? body);
    writeJson(paths.keymap, keymap, 0o644);
    sendJson(ctx.res, 200, { keymap });
  });
}
