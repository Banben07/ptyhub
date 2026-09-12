/**
 * The HTTP/WebSocket gateway.
 *
 * Stateless on purpose: it holds no PTYs and no session state of its own, so
 * restarting it is a non-event for anything running on the machine. Everything
 * real lives in ptyd on the other end of the unix socket.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  configDir,
  isLoopback,
  loadConfig,
  paths,
  socketPath,
  stateDir,
} from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { PtydError } from '../shared/ptyd-client.ts';
import { VERSION } from '../shared/version.ts';
import { Auth } from './auth.ts';
import { PUBLIC_PATHS, registerAuthRoutes } from './auth-routes.ts';
import type { AuthContext, Ctx } from './http-util.ts';
import {
  HttpError,
  Router,
  originAllowed,
  securityHeaders,
  sendError,
} from './http-util.ts';
import { PrefsStore } from './prefs-store.ts';
import { PtydControl } from './ptyd-control.ts';
import { httpStatusForPtydError, registerRestRoutes } from './rest.ts';
import { StaticServer, serveUserFont } from './static.ts';
import { attachWebSockets } from './ws.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const log = createLogger('web', paths.webLog);

const UNAUTHENTICATED: AuthContext = { user: null, deviceId: null };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDir(configDir);
  ensureDir(stateDir);

  const auth = new Auth(cfg, log);

  const control = new PtydControl(socketPath(cfg), log);
  control.start();

  const prefs = new PrefsStore();
  const router = new Router();
  registerAuthRoutes(router, auth);
  registerRestRoutes(router, { control, cfg, prefs });

  const statics = new StaticServer(path.join(root, 'public'));

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    securityHeaders(res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const authCtx = auth.authenticate(req) ?? UNAUTHENTICATED;

    if (url.pathname.startsWith('/fonts/')) {
      serveUserFont(res, paths.fonts, decodeURIComponent(url.pathname.slice('/fonts/'.length)));
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      statics.handle({ req, res, url, params: {}, auth: authCtx });
      return;
    }

    // Same reasoning as the WebSocket origin check: a cross-site form post
    // must not be able to spawn a shell.
    if (MUTATING.has(req.method ?? 'GET') && !originAllowed(req, cfg.allowedOrigins)) {
      sendError(res, 403, 'bad_origin', 'cross-origin request rejected');
      return;
    }

    if (authCtx.user === null && !PUBLIC_PATHS.has(url.pathname)) {
      sendError(res, 401, 'unauthenticated', 'login required');
      return;
    }

    const match = router.match(req.method ?? 'GET', url.pathname);
    if (!match) {
      const status = router.pathExists(url.pathname) ? 405 : 404;
      sendError(
        res,
        status,
        status === 405 ? 'method_not_allowed' : 'not_found',
        `${req.method} ${url.pathname}`,
      );
      return;
    }

    const ctx: Ctx = { req, res, url, params: match.params, auth: authCtx };
    try {
      await match.handler(ctx);
      auth.maybeRotate(req, res, authCtx);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
      } else if (err instanceof PtydError) {
        sendError(res, httpStatusForPtydError(err), err.code, err.message);
      } else {
        log(`unhandled error on ${req.method} ${url.pathname}: ${String(err)}`);
        sendError(res, 500, 'internal', 'internal error');
      }
    }
  }

  const closeWs = attachWebSockets(server, {
    control,
    cfg,
    socketFile: socketPath(cfg),
    log,
    authenticate: (req) => auth.authenticate(req),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.bind, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const host = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind;
  log(`v${VERSION} listening on http://${host}:${cfg.port}`);

  if (auth.openAccess) {
    log('trustedNetwork is on: the gateway is NOT checking credentials.');
  } else if (!auth.passwordConfigured) {
    // Loopback is not a security boundary on a machine with other accounts, so
    // there is always a credential. Print it where the operator will see it.
    log(`no password set; open this once to authorise this browser:\n\n    ${auth.accessUrl(host, cfg.port)}\n`);
    log('run `ptyhub link` to print it again, or `ptyhub passwd` to switch to a password.');
  }
  if (!isLoopback(cfg.bind)) {
    log(`listening beyond loopback on ${cfg.bind}; put TLS in front of it.`);
  }
  if (!statics.available) {
    log('UI bundle not found in public/ — run `npm run build`, or use `npm run dev`.');
  }

  const shutdown = (signal: string) => {
    log(`${signal} received; closing (sessions keep running in ptyd)`);
    closeWs();
    control.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${String(reason)}`);
  });
}

main().catch((err) => {
  log(`fatal: ${err?.message ?? String(err)}`);
  process.exit(1);
});
