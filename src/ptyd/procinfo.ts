/**
 * Figuring out what is actually running in a session.
 *
 * The kernel already tracks this: field 8 of /proc/<pid>/stat is `tpgid`, the
 * process group currently in the foreground of that process's controlling
 * terminal. Since a process group's id equals its leader's pid, reading
 * /proc/<tpgid>/comm gives the name of whatever the user is looking at —
 * `htop`, `claude`, `vim` — rather than the shell that launched it.
 */

import fs from 'node:fs';

const supported = process.platform === 'linux';

function readStatFields(pid: number): string[] | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // Field 2 is the executable name in parentheses and may itself contain
  // spaces or parentheses, so everything is parsed relative to the last ')'.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  return stat.slice(close + 2).split(' ');
}

/** Name of the foreground process of the session's tty, or null. */
export function foregroundProcess(shellPid: number): string | null {
  if (!supported) return null;
  const fields = readStatFields(shellPid);
  if (!fields) return null;

  // fields: 0 state, 1 ppid, 2 pgrp, 3 session, 4 tty_nr, 5 tpgid
  const tpgid = Number(fields[5]);
  if (!Number.isInteger(tpgid) || tpgid <= 0) return null;

  try {
    return fs.readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** True while the process is still present in /proc. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
