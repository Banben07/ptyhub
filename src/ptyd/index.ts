/**
 * ptyd — the process that owns every PTY.
 *
 * It holds the master file descriptors and nothing else holds them, which is
 * the entire reason shells here survive browser reloads, gateway restarts and
 * dropped connections. Keep this process boring and long-lived.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  ensureDir,
  loadConfig,
  paths,
  runtimeDir,
  socketPath,
  stateDir,
} from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { VERSION } from '../shared/version.ts';
import { Registry } from './registry.ts';
import { startIpcServer } from './ipc-server.ts';

const log = createLogger('ptyd', paths.ptydLog);

/**
 * A socket file left behind by a crashed ptyd would block listen(). Probe it:
 * if something answers, another ptyd is live and we must not start; if the
 * connection is refused, the file is debris and can go.
 */
function clearStaleSocket(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) {
      resolve();
      return;
    }
    const probe = net.connect(file);
    const giveUp = setTimeout(() => {
      probe.destroy();
      reject(new Error(`socket ${file} did not answer or refuse; refusing to start`));
    }, 2000);

    probe.once('connect', () => {
      clearTimeout(giveUp);
      probe.destroy();
      reject(new Error(`ptyd is already running on ${file}`));
    });
    probe.once('error', (err) => {
      clearTimeout(giveUp);
      probe.destroy();
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        try {
          fs.unlinkSync(file);
        } catch {
          // Someone else cleaned it up first.
        }
        resolve();
      } else {
        reject(err);
      }
    });
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const socketFile = socketPath(cfg);

  ensureDir(stateDir);
  ensureDir(runtimeDir);
  ensureDir(path.dirname(socketFile));

  await clearStaleSocket(socketFile);

  const registry = new Registry(cfg);
  registry.start();

  const server = await startIpcServer(registry, socketFile, cfg, log);
  // Only this user may talk to ptyd; the socket is a direct line to a shell.
  fs.chmodSync(socketFile, 0o600);

  log(
    `v${VERSION} listening on ${socketFile} ` +
      `(reviveScreen=${cfg.reviveScreen}, resizePolicy=${cfg.resizePolicy})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down ${registry.size} session(s)`);
    await server.close();
    registry.stop();
    try {
      fs.unlinkSync(socketFile);
    } catch {
      // Already gone.
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => log('SIGHUP ignored; sessions keep running'));

  // Staying alive is this process's only job. A stray exception in one code
  // path must not take every shell on the machine down with it.
  process.on('uncaughtException', (err) => {
    log(`uncaught exception (continuing): ${err?.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection (continuing): ${String(reason)}`);
  });
}

main().catch((err) => {
  log(`fatal: ${err?.message ?? String(err)}`);
  process.exit(1);
});
