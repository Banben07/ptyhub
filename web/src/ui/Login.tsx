/**
 * The login screen.
 *
 * Ticking "remember this device" means you should never see this page again on
 * that device. On a phone the better path is `ptyhub link --qr` on the server
 * and a scan, so the copy points there rather than making you type a password
 * with your thumbs.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { authStatus, boot } from '../state.ts';
import { startEventStream } from '../events.ts';

export function Login() {
  const userRef = useRef<HTMLInputElement>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(user, password, remember);
      authStatus.value = {
        authenticated: true,
        user,
        openAccess: false,
        passwordConfigured: true,
      };
      await boot();
      startEventStream();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login-screen">
      <form class="login-card" onSubmit={submit}>
        <div class="login-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="48" height="48">
            <rect width="64" height="64" rx="16" fill="var(--surface-raised)" />
            <path
              d="M18 21 L29 32 L18 43"
              fill="none"
              stroke="var(--accent)"
              stroke-width="6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <rect x="33" y="38" width="16" height="6" rx="3" fill="var(--text)" />
          </svg>
        </div>
        <h1>ptyhub</h1>
        <p class="login-sub">Sign in to reach your terminals.</p>

        {authStatus.value?.passwordConfigured === false && (
          <div class="login-hint">
            No password is set on this server, so it uses an access link instead. Run{' '}
            <code>ptyhub link</code> there and open the URL it prints — or{' '}
            <code>ptyhub passwd</code> to set a password and use this form.
          </div>
        )}

        <label class="field">
          <span>User</span>
          <input
            ref={userRef}
            autocomplete="username"
            value={user}
            onInput={(event) => setUser(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </label>

        <label class="field">
          <span>Password</span>
          <input
            type="password"
            autocomplete="current-password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </label>

        <label class="check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.currentTarget.checked)}
          />
          <span>Remember this device for 90 days</span>
        </label>

        {error && <div class="login-error">{error}</div>}

        <button class="btn primary wide" type="submit" disabled={busy || !user || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p class="login-note">
          On a phone or tablet, run <code>ptyhub link --qr</code> on the server and scan
          the code. That pairs the device once and skips this page from then on.
        </p>
      </form>
    </div>
  );
}
