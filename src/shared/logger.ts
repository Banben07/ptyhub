/**
 * Logging that does not depend on the journal.
 *
 * `systemctl --user` is available on plenty of machines where `journalctl` is
 * not readable by the user — shared cluster nodes in particular. Writing a file
 * alongside stderr means the startup banner, including the access URL, is
 * always recoverable.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type Logger = (msg: string) => void;

export function createLogger(prefix: string, file: string): Logger {
  let rotated = false;

  return (msg: string) => {
    const line = `[${prefix} ${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);

    try {
      // Check the size once per process, then only when it could have grown.
      if (!rotated) {
        rotated = true;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
          fs.renameSync(file, `${file}.1`);
        }
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // stderr already has it; never let logging break the daemon.
    }
  };
}
