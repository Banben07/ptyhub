import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';

/**
 * The UI is built out of `web/` into `public/`, which the gateway serves in
 * production. In development Vite serves it and proxies the API and WebSocket
 * traffic to the gateway, so there is only ever one gateway process to run.
 */
const GATEWAY = process.env.PTYHUB_GATEWAY ?? 'http://127.0.0.1:7420';

export default defineConfig({
  root: 'web',
  publicDir: 'static',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    // Never inline fonts. Vite would turn the small subsets into data: URLs,
    // which would force `font-src data:` into the Content Security Policy just
    // to load our own bundled font. Keeping them as files keeps the policy tight.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  server: {
    port: 7421,
    strictPort: true,
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: false },
      '/ws': { target: GATEWAY, ws: true, changeOrigin: false },
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  plugins: [preact()],
});
