import { render } from 'preact';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api } from './api.ts';
import { App } from './app.tsx';

/**
 * A pairing link arrives as `#k=<key>`. The fragment never reaches the server,
 * so it stays out of access logs and Referer headers; we redeem it for a device
 * cookie and scrub it from the address bar before anything else runs.
 */
async function redeemPairingLink(): Promise<void> {
  const match = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  if (!match) return;

  const key = decodeURIComponent(match[1]!);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await api.pair(key);
  } catch {
    // An expired or already-used link just means the login page appears.
  }
}

async function start(): Promise<void> {
  await redeemPairingLink();
  const root = document.getElementById('app');
  if (root) render(<App />, root);
}

// Note: no service worker on purpose. A cached terminal showing stale output
// would be worse than one that plainly says it is offline, and the web app
// manifest alone is enough for the standalone window on phones and tablets.
void start();
