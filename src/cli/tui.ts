/**
 * The terminal-side session picker.
 *
 * Drawn with plain escape sequences rather than a TUI framework: this is one
 * list, and pulling in a rendering stack for it would cost more than it saves.
 */

import { StringDecoder } from 'node:string_decoder';
import type { SessionMeta } from '../shared/protocol.ts';
import { PtydClient } from '../shared/ptyd-client.ts';
import { attachSession } from './attach.ts';

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const ACCENT = '\x1b[38;5;111m';
const MUTED = '\x1b[38;5;244m';
const DANGER = '\x1b[38;5;203m';
const INVERT = '\x1b[7m';

const BORING = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', '']);

function age(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? `${value.slice(0, Math.max(0, width - 1))}…`
    : value + ' '.repeat(width - value.length);
}

type Mode = { kind: 'list' } | { kind: 'prompt'; label: string; buffer: string; onSubmit: (value: string) => void };

export async function runTui(client: PtydClient, homeDir: string): Promise<void> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    throw new Error('ptyhub with no arguments needs a terminal; try `ptyhub ls`');
  }

  let sessions: SessionMeta[] = await client.list();
  let cursor = 0;
  let filter = '';
  let mode: Mode = { kind: 'list' };
  let status = '';
  let running = true;

  client.handlers.onEvent = () => {
    // Any change at all: just re-read the list. It is tiny and always correct.
    void client
      .list()
      .then((list) => {
        sessions = list;
        draw();
      })
      .catch(() => {});
  };

  const visible = () =>
    filter
      ? sessions.filter((s) =>
          `${s.name} ${s.fgProc} ${s.cwd}`.toLowerCase().includes(filter.toLowerCase()),
        )
      : sessions;

  const enter = () => {
    stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);
    stdin.setRawMode(true);
    stdin.resume();
  };

  const leave = () => {
    stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
    stdin.setRawMode(false);
    stdin.pause();
  };

  function draw(): void {
    const rows = stdout.rows ?? 24;
    const cols = stdout.columns ?? 80;
    const list = visible();
    cursor = Math.min(Math.max(0, cursor), Math.max(0, list.length - 1));

    const lines: string[] = [];
    lines.push(`${BOLD}${ACCENT} ptyhub${RESET}${DIM} — ${sessions.length} session${sessions.length === 1 ? '' : 's'}${RESET}`);
    lines.push('');

    if (list.length === 0) {
      lines.push(`${MUTED}  no sessions${filter ? ' match that filter' : ' yet'}.${RESET}`);
      lines.push(`${MUTED}  press n to create one.${RESET}`);
    }

    const nameWidth = Math.min(24, Math.max(10, cols - 54));
    for (const [index, session] of list.entries()) {
      const selected = index === cursor;
      const proc = BORING.has(session.fgProc) ? 'shell' : session.fgProc;
      const cwd = session.cwd.startsWith(homeDir)
        ? `~${session.cwd.slice(homeDir.length)}`
        : session.cwd;

      const state = session.alive
        ? `${ACCENT}${pad(proc, 12)}${RESET}`
        : `${DANGER}${pad(`exited ${session.exitCode ?? ''}`.trim(), 12)}${RESET}`;

      const row =
        ` ${pad(session.name, nameWidth)} ${state} ` +
        `${MUTED}${pad(cwd, Math.max(10, cols - nameWidth - 34))}${RESET}` +
        `${DIM}${pad(`${session.cols}×${session.rows}`, 9)}${age(session.createdAt).padStart(4)}${RESET}`;

      lines.push(selected ? `${INVERT}${row}${RESET}` : row);
    }

    // Pin the help and status to the bottom of the screen.
    while (lines.length < rows - 2) lines.push('');

    if (mode.kind === 'prompt') {
      lines.push(`${ACCENT}${mode.label}${RESET} ${mode.buffer}${INVERT} ${RESET}`);
    } else if (filter) {
      lines.push(`${ACCENT}filter:${RESET} ${filter}${DIM}  (esc clears)${RESET}`);
    } else {
      lines.push(
        `${DIM} ↑↓ move · enter attach · n new · x close · r rename · / filter · q quit${RESET}`,
      );
    }
    lines.push(status ? `${MUTED} ${status}${RESET}` : '');

    stdout.write(`\x1b[H\x1b[2J${lines.slice(0, rows).join('\r\n')}`);
  }

  const refresh = async () => {
    sessions = await client.list();
    draw();
  };

  /**
   * Split a read into individual keys.
   *
   * A terminal delivers whatever arrived since the last read, so a paste — or
   * simply typing quickly — shows up as one chunk holding many keystrokes.
   * Treating the chunk as a single key silently swallows the Enter at its end.
   * Escape sequences stay grouped so arrow keys survive.
   */
  const splitKeys = (input: string): string[] => {
    const keys: string[] = [];
    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === '\x1b' && (input[i + 1] === '[' || input[i + 1] === 'O')) {
        let end = i + 2;
        while (end < input.length && !/[@-~]/.test(input[end]!)) end++;
        keys.push(input.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      keys.push(ch);
      i += 1;
    }
    return keys;
  };

  const decoder = new StringDecoder('utf8');
  const onKey = (chunk: Buffer) => {
    // Decode across chunk boundaries so a multi-byte character split by the
    // read does not turn into two replacement characters.
    for (const key of splitKeys(decoder.write(chunk))) handleKey(key);
  };

  const handleKey = (key: string) => {
    if (mode.kind === 'prompt') {
      if (key === '\r' || key === '\n') {
        const value = mode.buffer;
        const submit = mode.onSubmit;
        mode = { kind: 'list' };
        submit(value);
        return;
      }
      if (key === '\x1b') {
        mode = { kind: 'list' };
        draw();
        return;
      }
      if (key === '\x7f' || key === '\b') {
        mode = { ...mode, buffer: mode.buffer.slice(0, -1) };
        draw();
        return;
      }
      // Printable single characters only; control keys and escape sequences
      // must not end up as literal text in the field.
      if (key.length === 1 && key >= ' ' && key !== '\x7f') {
        mode = { ...mode, buffer: mode.buffer + key };
        draw();
      }
      return;
    }

    const list = visible();
    const current = list[cursor];

    switch (key) {
      case '\x1b[A':
      case 'k':
        cursor = Math.max(0, cursor - 1);
        draw();
        return;
      case '\x1b[B':
      case 'j':
        cursor = Math.min(list.length - 1, cursor + 1);
        draw();
        return;
      case '\x1b':
        if (filter) {
          filter = '';
          draw();
        }
        return;
      case 'q':
      case '\x03':
        running = false;
        return;
      case '/':
        mode = {
          kind: 'prompt',
          label: 'filter:',
          buffer: filter,
          onSubmit: (value) => {
            filter = value;
            cursor = 0;
            draw();
          },
        };
        draw();
        return;
      case 'n':
        mode = {
          kind: 'prompt',
          label: 'name for the new terminal:',
          buffer: '',
          onSubmit: (value) => {
            void client
              .create({ name: value || undefined })
              .then(() => refresh())
              .catch((err) => {
                status = String(err);
                draw();
              });
          },
        };
        draw();
        return;
      case 'r':
        if (!current) return;
        mode = {
          kind: 'prompt',
          label: `rename ${current.name} to:`,
          buffer: current.name,
          onSubmit: (value) => {
            if (!value) return;
            void client
              .rename(current.id, value)
              .then(() => refresh())
              .catch((err) => {
                status = String(err);
                draw();
              });
          },
        };
        draw();
        return;
      case 'x':
        if (!current) return;
        void client
          .kill(current.id)
          .then(() => refresh())
          .catch((err) => {
            status = String(err);
            draw();
          });
        return;
      case '\r':
      case '\n':
        if (current) attachRequest = current.id;
        return;
      default:
        return;
    }
  };

  let attachRequest: string | null = null;

  enter();
  draw();
  stdin.on('data', onKey);

  try {
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 40));

      if (attachRequest) {
        const id = attachRequest;
        attachRequest = null;
        stdin.off('data', onKey);
        leave();

        const result = await attachSession(client, id);
        if (result.reason === 'lost') {
          process.stderr.write('lost connection to ptyd\n');
          return;
        }

        // Restore the picker's own handlers after attach took them over.
        client.handlers.onOutput = undefined;
        client.handlers.onClose = undefined;
        client.handlers.onEvent = () => {
          void client
            .list()
            .then((l) => {
              sessions = l;
              draw();
            })
            .catch(() => {});
        };
        status =
          result.reason === 'exited'
            ? 'that session exited'
            : 'detached; it is still running';
        await refresh();
        enter();
        stdin.on('data', onKey);
        draw();
      }
    }
  } finally {
    stdin.off('data', onKey);
    leave();
  }
}
