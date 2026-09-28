/**
 * The session-list channel.
 *
 * One WebSocket per tab, carrying everything the chrome needs: new sessions,
 * renames, exits, foreground process changes, and the health of the gateway's
 * own link to ptyd. Reconnects on its own and resyncs from scratch each time,
 * because a gateway that restarted may have a different view of the world.
 */

import { ReconnectingSocket } from './reconnecting-socket.ts';
import type { EventsWsMessage, SessionMeta } from '../../src/shared/protocol.ts';
import {
  applySessionEvent,
  applySessionList,
  eventsConnected,
  ptydStatus,
  upsertSession,
} from './state.ts';

const connection = new ReconnectingSocket({
  url: () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/events`;
  },
  state: (state) => {
    eventsConnected.value = state === 'open';
    if (state !== 'open') ptydStatus.value = 'connecting';
  },
  message: (data, ready) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as EventsWsMessage;
    handle(msg);
    if (msg.t === 'snapshot') ready();
  },
});

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

export function startEventStream(): void {
  connection.start();
}

/** Probe even a socket that still appears open after sleep or a route change. */
export function nudgeEventStream(): void {
  connection.nudge();
}

export function stopEventStream(): void {
  connection.stop();
}
