/**
 * Static file serving for the built UI.
 *
 * In development the frontend is served by Vite on its own port and proxied to
 * this gateway, so this path only matters in production — but it is also what
 * responds when someone opens the port before running a build, and saying so
 * clearly beats a bare 404.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Ctx } from './http-util.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // xterm.js sets inline styles on its rendering layers.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const FONT_MIME: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve fonts the user fetched with `ptyhub fetch-font`, which land in the
 * state directory rather than the bundle. Only plain filenames are accepted, so
 * this cannot be walked out of.
 */
export function serveUserFont(res: ServerResponse, fontsDir: string, name: string): void {
  const ext = path.extname(name).toLowerCase();
  if (name !== path.basename(name) || !(ext in FONT_MIME)) {
    res.writeHead(404).end();
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(path.join(fontsDir, name));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('font not installed; run `ptyhub fetch-font nerd`\n');
    return;
  }
  res.writeHead(200, {
    'Content-Type': FONT_MIME[ext]!,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=604800',
  });
  res.end(body);
}

export class StaticServer {
  constructor(private readonly root: string) {}

  get available(): boolean {
    return fs.existsSync(path.join(this.root, 'index.html'));
  }

  handle(ctx: Ctx): void {
    const { res } = ctx;
    if (!this.available) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'ptyhub UI has not been built yet.\n\n' +
          '  npm run build     build the UI into public/\n' +
          '  npm run dev       or run the Vite dev server instead\n',
      );
      return;
    }

    const requested = decodeURIComponent(ctx.url.pathname);
    const resolved = this.resolve(requested);

    if (!resolved) {
      // Unknown paths fall through to the app shell so client-side routes work.
      this.sendFile(res, path.join(this.root, 'index.html'), false);
      return;
    }
    // Hashed asset filenames are safe to cache forever; the shell is not.
    const immutable = resolved.startsWith(path.join(this.root, 'assets') + path.sep);
    this.sendFile(res, resolved, immutable);
  }

  /** Resolve inside the root only; anything escaping it is rejected. */
  private resolve(requested: string): string | null {
    const candidate = path.resolve(this.root, `.${path.posix.normalize(requested)}`);
    if (candidate !== this.root && !candidate.startsWith(this.root + path.sep)) {
      return null;
    }
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const index = path.join(candidate, 'index.html');
        return fs.existsSync(index) ? index : null;
      }
      return candidate;
    } catch {
      return null;
    }
  }

  private sendFile(res: ServerResponse, file: string, immutable: boolean): void {
    let body: Buffer;
    try {
      body = fs.readFileSync(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, must-revalidate',
      'Content-Security-Policy': CSP,
    });
    res.end(body);
  }
}
