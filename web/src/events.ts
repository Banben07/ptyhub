/**
 * The session-list channel.
 *
 * One WebSocket per tab, carrying everything the chrome needs: new sessions,
 * renames, exits, foreground process changes, and the health of the gateway's
 * own link to ptyd. Reconnects on its own and resyncs from scratch each time,
 * because a gateway that restarted may have a different view of the world.
 */

import type { EventsWsMessage, SessionMeta } from '../../src/shared/protocol.ts';
import {
  applySessionEvent,
  applySessionList,
  eventsConnected,
  ptydStatus,
  upsertSession,
} from './state.ts';

const RECONNECT_MIN_MS = 300;
const RECONNECT_MAX_MS = 10_000;

let ws: WebSocket | null = null;
let backoff = RECONNECT_MIN_MS;
let timer: number | null = null;
let stopped = false;

function patch(id: string, fields: Partial<SessionMeta>): void {
  applySessionEvent((list) =>
    list.map((s) => (s.id === id ? { ...s, ...fields } : s)),
  );
}

function handle(msg: EventsWsMessage): void {
  switch (msg.t) {
    case 'snapshot':
      ptydStatus.value = msg.status;
      applySessionList(msg.sessions);
      break;

    case 'status':
      ptydStatus.value = msg.status;
      break;

    case 'event': {
      const evt = msg.event;
      switch (evt.ev) {
        case 'created':
          upsertSession(evt.session);
          break;
        case 'removed':
          applySessionEvent((list) => list.filter((s) => s.id !== evt.id));
          break;
        case 'renamed':
          patch(evt.id, { name: evt.name });
          break;
        case 'proc':
          patch(evt.id, { fgProc: evt.fgProc });
          break;
        case 'title':
          patch(evt.id, { title: evt.title });
          break;
        case 'resized':
          patch(evt.id, { cols: evt.cols, rows: evt.rows });
          break;
        case 'viewers':
          patch(evt.id, { viewers: evt.viewers });
          break;
        case 'locked':
          patch(evt.id, { locked: evt.locked });
          break;
        case 'exited':
          patch(evt.id, {
            alive: false,
            exitCode: evt.exitCode,
            exitSignal: evt.exitSignal,
            exitedAt: Date.now(),
            fgProc: '',
          });
          break;
        case 'ready':
          break;
      }
      break;
    }

    case 'pong':
      break;
  }
}

function connect(): void {
  if (stopped) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/events`);

  ws.onopen = () => {
    backoff = RECONNECT_MIN_MS;
    eventsConnected.value = true;
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(String(ev.data)) as EventsWsMessage);
    } catch {
      // A malformed frame is not worth tearing the channel down for.
    }
  };
  ws.onclose = () => {
    ws = null;
    eventsConnected.value = false;
    if (stopped) return;
    // With the channel down we cannot know ptyd's health either.
    ptydStatus.value = 'connecting';
    schedule();
  };
  ws.onerror = () => {
    // `onclose` follows.
  };
}

function schedule(): void {
  if (timer !== null || stopped) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  timer = window.setTimeout(() => {
    timer = null;
    connect();
  }, delay);
}

export function startEventStream(): void {
  stopped = false;
  connect();
}

/** Reconnect immediately, e.g. when a sleeping phone wakes up. */
export function nudgeEventStream(): void {
  if (ws || stopped) return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  backoff = RECONNECT_MIN_MS;
  connect();
}

export function stopEventStream(): void {
  stopped = true;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  ws?.close();
  ws = null;
}
