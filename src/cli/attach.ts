/**
 * `ptyhub attach` — take over a session from a local terminal.
 *
 * This is the same subscription the browser uses, so the two are genuinely the
 * same session: type here and it appears in the web UI, and detaching leaves
 * everything running exactly as closing a browser tab does.
 */

import type { SessionMeta } from '../shared/protocol.ts';
import { PtydClient } from '../shared/ptyd-client.ts';

/** Ctrl+\ — rare enough in normal use to serve as the detach prefix. */
const DEFAULT_PREFIX = 0x1c;
const DETACH_KEY = 'd'.charCodeAt(0);

export interface AttachResult {
  reason: 'detached' | 'exited' | 'lost';
  exitCode?: number | null;
}

export async function attachSession(
  client: PtydClient,
  sessionId: string,
  opts: { prefix?: number; banner?: boolean } = {},
): Promise<AttachResult> {
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    throw new Error('attach needs a terminal on stdin');
  }

  let finish: (result: AttachResult) => void;
  const done = new Promise<AttachResult>((resolve) => {
    finish = resolve;
  });

  let armed = false;
  let meta: SessionMeta | null = null;

  const onOutput = (_id: string, data: Buffer) => {
    stdout.write(data);
  };

  const onData = (chunk: Buffer) => {
    // Scan for the detach sequence without disturbing anything else.
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      if (armed) {
        armed = false;
        if (byte === DETACH_KEY) {
          finish({ reason: 'detached' });
          return;
        }
        // Prefix pressed twice sends one literal prefix byte through.
        client.sendInput(sessionId, Buffer.from([prefix]));
        if (byte === prefix) {
          armed = true;
          continue;
        }
        client.sendInput(sessionId, Buffer.from([byte]));
        continue;
      }
      if (byte === prefix) {
        armed = true;
        continue;
      }
      // Fast path: forward the rest of the chunk in one write.
      const rest = chunk.subarray(i);
      const nextPrefix = rest.indexOf(prefix);
      if (nextPrefix < 0) {
        client.sendInput(sessionId, rest);
        return;
      }
      client.sendInput(sessionId, rest.subarray(0, nextPrefix));
      i += nextPrefix;
      armed = true;
    }
  };

  const onResize = () => {
    void client
      .resize(sessionId, stdout.columns ?? 80, stdout.rows ?? 24)
      .catch(() => {});
  };

  const restore = () => {
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  client.handlers.onOutput = onOutput;
  client.handlers.onEvent = (evt) => {
    if (!('id' in evt) || evt.id !== sessionId) return;
    if (evt.ev === 'exited') {
      finish({ reason: 'exited', exitCode: evt.exitCode });
    }
  };
  client.handlers.onClose = () => finish({ reason: 'lost' });

  // Clear before subscribing: the snapshot that follows rebuilds the screen,
  // and it must not land on top of whatever was here.
  stdout.write('\x1b[2J\x1b[3J\x1b[H');

  meta = await client.subscribe(sessionId, {
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  stdout.on('resize', onResize);

  if (opts.banner !== false) {
    process.stderr.write(
      `\x1b[2m-- attached to ${meta.name} (${meta.id}); Ctrl+\\ then d to detach --\x1b[0m\r\n`,
    );
  }

  const result = await done;
  restore();
  try {
    await client.unsubscribe(sessionId);
  } catch {
    // The connection may already be gone; nothing to clean up.
  }
  return result;
}
