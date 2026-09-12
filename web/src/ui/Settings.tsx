/**
 * Settings. Appearance changes apply live to every open terminal, and are
 * stored on the server so a new device inherits them instead of starting over.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  actions,
  chordFromEvent,
  defaultKeymap,
  formatChord,
  leaderConflict,
  normalizeKey,
  type ActionId,
  type Keymap,
} from '../../../src/shared/keymap.ts';
import {
  BUILTIN_FONT_STACKS,
  type ColorScheme,
  type CursorStyle,
  type MobileFitMode,
} from '../../../src/shared/prefs.ts';
import { themes } from '../../../src/shared/themes.ts';
import { api, type DeviceSummary } from '../api.ts';
import {
  authStatus,
  deviceClass,
  health,
  keymap,
  notify,
  prefs,
  setFontSize,
  settingsOpen,
  theme,
  updateFontPrefs,
  updatePrefs,
} from '../state.ts';
import { CloseIcon } from './icons.tsx';

type Tab = 'appearance' | 'font' | 'terminal' | 'keyboard' | 'devices' | 'about';

const TABS: { id: Tab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'font', label: 'Font' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'devices', label: 'Devices' },
  { id: 'about', label: 'About' },
];

export function Settings() {
  const [tab, setTab] = useState<Tab>('appearance');

  return (
    <div class="overlay" onPointerDown={() => (settingsOpen.value = false)}>
      <div
        class="settings"
        role="dialog"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <nav class="settings-nav">
          <div class="settings-title">Settings</div>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              class={`settings-tab${tab === entry.id ? ' active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div class="settings-body">
          <button
            class="icon-btn settings-close"
            aria-label="Close settings"
            onClick={() => (settingsOpen.value = false)}
          >
            <CloseIcon />
          </button>
          {tab === 'appearance' && <Appearance />}
          {tab === 'font' && <FontSettings />}
          {tab === 'terminal' && <TerminalSettings />}
          {tab === 'keyboard' && <KeyboardSettings />}
          {tab === 'devices' && <Devices />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="setting">
      <div class="setting-text">
        <span class="setting-label">{label}</span>
        {hint && <span class="setting-hint">{hint}</span>}
      </div>
      <div class="setting-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      class={`toggle${checked ? ' on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span class="toggle-knob" />
    </button>
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div class="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span class="slider-value">
        {value}
        {suffix}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Appearance() {
  const current = prefs.value;
  const dark = Object.values(themes).filter((t) => t.dark);
  const light = Object.values(themes).filter((t) => !t.dark);

  return (
    <section>
      <h2>Appearance</h2>

      <Field label="Colour scheme" hint="System follows your OS setting.">
        <div class="segmented">
          {(['system', 'dark', 'light'] as ColorScheme[]).map((mode) => (
            <button
              key={mode}
              class={current.colorScheme === mode ? 'active' : ''}
              onClick={() => updatePrefs({ colorScheme: mode })}
            >
              {mode}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Dark theme"
        hint={theme.value.dark ? 'In use right now.' : 'Used when the scheme resolves to dark.'}
      >
        <ThemeGrid
          list={dark}
          selected={current.darkTheme}
          onPick={(name) => updatePrefs({ darkTheme: name })}
        />
      </Field>

      <Field
        label="Light theme"
        hint={theme.value.dark ? 'Used when the scheme resolves to light.' : 'In use right now.'}
      >
        <ThemeGrid
          list={light}
          selected={current.lightTheme}
          onPick={(name) => updatePrefs({ lightTheme: name })}
        />
      </Field>

      <Field label="Compact layout" hint="Tighter rows and padding.">
        <Toggle
          checked={current.compact}
          onChange={(value) => updatePrefs({ compact: value })}
        />
      </Field>

      <Field
        label="Animate the tab icon"
        hint="Off by default. When on, the browser tab icon turns amber while reconnecting, red when ptyd is unreachable, and shows a dot for unseen output. The status pill reports the same thing either way."
      >
        <Toggle
          checked={current.dynamicFavicon}
          onChange={(value) => updatePrefs({ dynamicFavicon: value })}
        />
      </Field>
    </section>
  );
}

function ThemeGrid({
  list,
  selected,
  onPick,
}: {
  list: (typeof themes)[string][];
  selected: string;
  onPick: (name: string) => void;
}) {
  return (
    <div class="theme-grid">
      {list.map((theme) => (
        <button
          key={theme.name}
          class={`theme-swatch${selected === theme.name ? ' active' : ''}`}
          onClick={() => onPick(theme.name)}
          title={theme.label}
          style={{ background: theme.background, borderColor: theme.ui.border }}
        >
          <span class="swatch-row">
            {[theme.red, theme.green, theme.yellow, theme.blue, theme.magenta].map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </span>
          <span class="swatch-name" style={{ color: theme.foreground }}>
            {theme.label}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FontSettings() {
  const font = prefs.value.font;
  const device = deviceClass.value;

  return (
    <section>
      <h2>Font</h2>

      <Field label="Family" hint="Any monospace font installed on this device also works.">
        <select
          value={BUILTIN_FONT_STACKS.some((f) => f.value === font.family) ? font.family : '__custom'}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value !== '__custom') updateFontPrefs({ family: value });
          }}
        >
          {BUILTIN_FONT_STACKS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
          <option value="__custom">Custom…</option>
        </select>
      </Field>

      <Field label="Custom family">
        <input
          class="text-input"
          value={font.family}
          onChange={(event) => updateFontPrefs({ family: event.currentTarget.value })}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </Field>

      <Field
        label="Nerd Font glyphs"
        hint="Powerline and icon glyphs for prompts like starship. Run `ptyhub fetch-font nerd` on the server first."
      >
        <Toggle
          checked={font.nerdFont}
          onChange={(value) => updateFontPrefs({ nerdFont: value })}
        />
      </Field>

      <Field label={`Size on this ${device}`} hint="Each device class keeps its own size.">
        <Slider
          value={font.size[device]}
          min={8}
          max={32}
          suffix=" px"
          onChange={setFontSize}
        />
      </Field>

      <Field label="Line height">
        <Slider
          value={font.lineHeight}
          min={0.9}
          max={2}
          step={0.05}
          onChange={(value) => updateFontPrefs({ lineHeight: value })}
        />
      </Field>

      <Field label="Letter spacing">
        <Slider
          value={font.letterSpacing}
          min={-1}
          max={3}
          step={0.5}
          suffix=" px"
          onChange={(value) => updateFontPrefs({ letterSpacing: value })}
        />
      </Field>

      <Field label="Ligatures" hint="For fonts that have them, such as Fira Code.">
        <Toggle
          checked={font.ligatures}
          onChange={(value) => updateFontPrefs({ ligatures: value })}
        />
      </Field>
    </section>
  );
}

// ---------------------------------------------------------------------------

function TerminalSettings() {
  const current = prefs.value;

  return (
    <section>
      <h2>Terminal</h2>

      <Field label="Cursor">
        <div class="segmented">
          {(['block', 'bar', 'underline'] as CursorStyle[]).map((style) => (
            <button
              key={style}
              class={current.cursorStyle === style ? 'active' : ''}
              onClick={() => updatePrefs({ cursorStyle: style })}
            >
              {style}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Cursor blink">
        <Toggle
          checked={current.cursorBlink}
          onChange={(value) => updatePrefs({ cursorBlink: value })}
        />
      </Field>

      <Field label="Scrollback" hint="Lines kept in the browser. ptyd keeps its own history too.">
        <Slider
          value={current.scrollback}
          min={1000}
          max={100000}
          step={1000}
          onChange={(value) => updatePrefs({ scrollback: value })}
        />
      </Field>

      <Field label="Copy on select">
        <Toggle
          checked={current.copyOnSelect}
          onChange={(value) => updatePrefs({ copyOnSelect: value })}
        />
      </Field>

      <Field label="Right click pastes">
        <Toggle
          checked={current.rightClickPaste}
          onChange={(value) => updatePrefs({ rightClickPaste: value })}
        />
      </Field>

      <Field label="Clickable links">
        <Toggle
          checked={current.linkify}
          onChange={(value) => updatePrefs({ linkify: value })}
        />
      </Field>

      <Field
        label="On phones"
        hint="Fit gives the phone its own window size, so the text is readable; the session resizes back when you use the desktop again. Watch keeps the desktop's size and shrinks the picture instead — good for looking, hard to type in."
      >
        <div class="segmented">
          {(
            [
              { mode: 'reflow', label: 'Fit' },
              { mode: 'scale', label: 'Watch' },
            ] as { mode: MobileFitMode; label: string }[]
          ).map((entry) => (
            <button
              key={entry.mode}
              class={current.mobileFit === entry.mode ? 'active' : ''}
              onClick={() => updatePrefs({ mobileFit: entry.mode })}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </Field>
    </section>
  );
}

// ---------------------------------------------------------------------------

function KeyboardSettings() {
  const [recording, setRecording] = useState<'leader' | ActionId | null>(null);
  const current = keymap.value;

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const chord = chordFromEvent(event);
      if (['control', 'alt', 'shift', 'meta'].includes(chord.key)) return;

      if (chord.key === 'escape') {
        setRecording(null);
        return;
      }

      const next: Keymap =
        recording === 'leader'
          ? { ...current, leader: chord }
          : rebind(current, recording, normalizeKey(event.key));
      save(next);
      setRecording(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [recording, current]);

  const save = (next: Keymap) => {
    keymap.value = next;
    void api.saveKeymap(next).catch(() => notify('could not save the keymap', 'error'));
  };

  const byAction = new Map<ActionId, string>();
  for (const [key, action] of Object.entries(current.bindings)) {
    if (!byAction.has(action)) byAction.set(action, key);
  }

  const leaderWarning = leaderConflict(current.leader);

  return (
    <section>
      <h2>Keyboard</h2>
      <p class="settings-note">
        Every shortcut is a leader key followed by one more key, so nothing is taken
        away from the shell or the browser.
      </p>

      <Field label="Leader key" hint="Press the combination you want.">
        <button class="btn chord" onClick={() => setRecording('leader')}>
          {recording === 'leader' ? 'Press a key…' : formatChord(current.leader)}
        </button>
      </Field>

      {leaderWarning && (
        <div class="settings-warning">
          <strong>{formatChord(current.leader)}</strong> {leaderWarning}. Nothing bound to
          it will ever fire — pick a different leader.
        </div>
      )}

      <div class="binding-list">
        {actions.map((action) => (
          <div class="binding-row" key={action.id}>
            <span class="binding-label">{action.label}</span>
            <span class="binding-group">{action.group}</span>
            <button
              class="btn chord small"
              onClick={() => setRecording(action.id)}
            >
              {recording === action.id ? (
                'Press a key…'
              ) : (
                <>
                  <span class="dim">{formatChord(current.leader)}</span>{' '}
                  {(byAction.get(action.id) ?? '—').toUpperCase()}
                </>
              )}
            </button>
          </div>
        ))}
      </div>

      <button class="btn" onClick={() => save(structuredClone(defaultKeymap))}>
        Reset to defaults
      </button>
    </section>
  );
}

function rebind(current: Keymap, action: ActionId, key: string): Keymap {
  const bindings: Record<string, ActionId> = {};
  for (const [existing, id] of Object.entries(current.bindings)) {
    // Drop the old binding for this action and anything already on the new key.
    if (id === action || existing === key) continue;
    bindings[existing] = id;
  }
  bindings[key] = action;
  return { ...current, bindings };
}

// ---------------------------------------------------------------------------

function Devices() {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .devices()
      .then((res) => setDevices(res.devices))
      .catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  };

  useEffect(load, []);

  if (authStatus.value?.openAccess) {
    return (
      <section>
        <h2>Devices</h2>
        <p class="settings-note">
          <code>trustedNetwork</code> is turned on in the server configuration, so ptyhub
          is not checking credentials at all and there are no devices to list. Only do
          this when something else already authenticates the network, such as a
          WireGuard or Tailscale interface.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Devices</h2>
      <p class="settings-note">
        Each entry is a browser that can reach your terminals without signing in
        again. Revoking one takes effect on its next request.
      </p>
      {error && <div class="login-error">{error}</div>}
      <div class="device-list">
        {devices?.map((device) => (
          <div class="device-row" key={device.id}>
            <div>
              <div class="device-label">
                {device.label}
                {device.current && <span class="badge">this device</span>}
              </div>
              <div class="device-meta">
                {device.ip} · last used {new Date(device.lastUsedAt).toLocaleString()}
              </div>
            </div>
            <button
              class="btn danger small"
              onClick={() =>
                void api
                  .revokeDevice(device.id)
                  .then(() => (device.current ? location.reload() : load()))
              }
            >
              Revoke
            </button>
          </div>
        ))}
        {devices?.length === 0 && <p class="muted">No devices are authorised yet.</p>}
      </div>

      <div class="settings-actions">
        <button
          class="btn danger"
          onClick={() => void api.revokeDevice('all').then(() => location.reload())}
        >
          Revoke all and sign out
        </button>
        <button class="btn" onClick={() => void api.logout().then(() => location.reload())}>
          Sign out
        </button>
      </div>
    </section>
  );
}

function About() {
  const info = health.value;
  return (
    <section>
      <h2>About</h2>
      <p class="settings-note">
        ptyhub keeps your shells in a daemon called ptyd. Closing this page, losing the
        network or restarting the web gateway does not touch anything you have running.
      </p>
      <dl class="about-list">
        <dt>Version</dt>
        <dd>{info?.version ?? '—'}</dd>
        <dt>ptyd</dt>
        <dd>{info?.ptyd ?? '—'}</dd>
        <dt>Resize policy</dt>
        <dd>{info?.resizePolicy ?? '—'}</dd>
        <dt>Signed in as</dt>
        <dd>{info?.user ?? '—'}</dd>
      </dl>
    </section>
  );
}
