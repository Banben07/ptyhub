import { useEffect } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { startEventStream, nudgeEventStream } from './events.ts';
import { installKeyHandler } from './keys.ts';
import {
  activeSession,
  authStatus,
  bootError,
  boot,
  eventsConnected,
  flushPrefs,
  isMobile,
  leaderArmed,
  paletteOpen,
  prefs,
  ptydStatus,
  searchOpen,
  sessions,
  settingsOpen,
  sidebarOpen,
  terminalOptions,
  theme,
  trackDeviceClass,
} from './state.ts';
import { applyNerdFont, applyThemeToDocument } from './theme.ts';
import {
  nudgeAll,
  peekTerminal,
  refreshGlyphsInAll,
  setTerminalOptionsProvider,
} from './terminal/registry.ts';
import { updateFavicon, type FaviconState } from './ui/favicon.ts';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { DragGhost } from './ui/DragGhost.tsx';
import { Login } from './ui/Login.tsx';
import { MobileKeys } from './ui/MobileKeys.tsx';
import { PaneTree } from './ui/PaneView.tsx';
import { SearchBar } from './ui/SearchBar.tsx';
import { Settings } from './ui/Settings.tsx';
import { Sidebar } from './ui/Sidebar.tsx';
import { StatusPill } from './ui/StatusPill.tsx';
import { TabBar } from './ui/TabBar.tsx';
import { Toast } from './ui/Toast.tsx';

setTerminalOptionsProvider(terminalOptions);

export function App() {
  useEffect(() => {
    const stopDevice = trackDeviceClass();
    const stopKeys = installKeyHandler();
    void boot().then(() => {
      if (authStatus.value?.authenticated) startEventStream();
    });

    // Phones freeze background tabs, so a woken device must be told to retry
    // rather than waiting out an exponential backoff that never ticked.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      nudgeEventStream();
      nudgeAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    // Reloading or closing right after a change must not lose it.
    const onLeaving = () => flushPrefs();
    window.addEventListener('pagehide', onLeaving);
    window.addEventListener('beforeunload', onLeaving);

    return () => {
      stopDevice();
      stopKeys();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('pagehide', onLeaving);
      window.removeEventListener('beforeunload', onLeaving);
    };
  }, []);

  // Theme drives the interface and the terminal from one object.
  useSignalEffect(() => {
    applyThemeToDocument(theme.value, prefs.value.compact);
    void applyNerdFont(prefs.value.font.nerdFont).then((loaded) => {
      // Only worth a redraw once the glyphs are actually there.
      if (loaded) refreshGlyphsInAll();
    });
  });

  // Tab title and icon report what is running and whether we are connected.
  useSignalEffect(() => {
    const session = activeSession.value;
    const label = session
      ? `${session.name}${session.fgProc && session.fgProc !== 'bash' && session.fgProc !== 'sh' ? ` · ${session.fgProc}` : ''}`
      : null;
    document.title = label ? `${label} — ptyhub` : 'ptyhub';

    const animate = prefs.value.dynamicFavicon;
    const state: FaviconState =
      ptydStatus.value === 'down' ? 'down'
      : ptydStatus.value === 'connecting' || !eventsConnected.value ? 'warn'
      : 'ok';
    const unread =
      animate &&
      sessions.value.some(
        (s) => s.id !== session?.id && peekTerminal(s.id)?.unread.value === true,
      );
    updateFavicon(state, unread, animate);
  });

  const auth = authStatus.value;

  if (bootError.value) {
    return (
      <div class="boot-error">
        <h1>ptyhub</h1>
        <p>{bootError.value}</p>
        <button class="btn primary" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  if (auth && !auth.authenticated) return <Login />;
  if (!auth) return <div class="boot-splash" aria-label="Loading" />;

  return (
    <div class={`shell${isMobile.value ? ' mobile' : ''}${sidebarOpen.value ? '' : ' no-sidebar'}`}>
      <header class="topbar">
        <TabBar />
        <StatusPill />
      </header>

      {!isMobile.value && sidebarOpen.value && <Sidebar />}

      <main class="workspace">
        <PaneTree />
      </main>

      {isMobile.value && <MobileKeys />}

      <DragGhost />
      {searchOpen.value && <SearchBar />}
      {paletteOpen.value && <CommandPalette />}
      {settingsOpen.value && <Settings />}
      <Toast />

      {leaderArmed.value && (
        <div class="leader-hint" role="status">
          waiting for a shortcut key…
        </div>
      )}
    </div>
  );
}
