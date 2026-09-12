/**
 * Theme resolution and CSS variable application.
 *
 * The interface chrome and the terminal palette come from the same object, so
 * changing theme repaints both together and they can never drift apart.
 */

import type { Prefs } from '../../src/shared/prefs.ts';
import type { TerminalTheme } from '../../src/shared/themes.ts';
import { getTheme } from '../../src/shared/themes.ts';

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(prefs: Prefs): TerminalTheme {
  const dark = prefs.colorScheme === 'system' ? prefersDark() : prefs.colorScheme === 'dark';
  const name = dark ? prefs.darkTheme : prefs.lightTheme;
  if (name === 'custom' && prefs.customTheme) return prefs.customTheme;
  return getTheme(name, dark ? 'ptyhub-dark' : 'ptyhub-light');
}

/** The subset xterm.js understands. */
export function xtermTheme(theme: TerminalTheme): Record<string, string> {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  };
}

export function applyThemeToDocument(theme: TerminalTheme, compact: boolean): void {
  const root = document.documentElement;
  const set = (name: string, value: string) => root.style.setProperty(name, value);

  set('--base', theme.ui.base);
  set('--surface', theme.ui.surface);
  set('--surface-raised', theme.ui.surfaceRaised);
  set('--border', theme.ui.border);
  set('--accent', theme.ui.accent);
  set('--accent-contrast', theme.ui.accentContrast);
  set('--text', theme.ui.text);
  set('--text-muted', theme.ui.textMuted);
  set('--danger', theme.ui.danger);
  set('--warning', theme.ui.warning);
  set('--success', theme.ui.success);
  set('--term-bg', theme.background);
  set('--term-fg', theme.foreground);

  set('--row-h', compact ? '28px' : '34px');
  set('--gap', compact ? '6px' : '10px');

  root.dataset.scheme = theme.dark ? 'dark' : 'light';
  // Native form controls and scrollbars follow this.
  root.style.colorScheme = theme.dark ? 'dark' : 'light';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.ui.base);
}

const NERD_FACES = [
  { weight: '400', file: 'JetBrainsMonoNerdFont-Regular.ttf' },
  { weight: '700', file: 'JetBrainsMonoNerdFont-Bold.ttf' },
];

let nerdFontLoad: Promise<boolean> | null = null;

/**
 * Load the Nerd Font the user fetched with `ptyhub fetch-font nerd`.
 *
 * This has to go through the FontFace API rather than a plain `@font-face`
 * rule. The terminal draws to a canvas, and canvas text does not trigger the
 * lazy download a CSS rule relies on — the browser would simply never fetch the
 * file and every glyph would silently fall back to a box.
 *
 * Resolves to true once the glyphs are genuinely available to draw with.
 */
export function applyNerdFont(enabled: boolean): Promise<boolean> {
  if (!enabled) return Promise.resolve(false);
  if (nerdFontLoad) return nerdFontLoad;

  nerdFontLoad = Promise.all(
    NERD_FACES.map(async (face) => {
      const font = new FontFace(
        'JetBrains Mono Nerd Font',
        `url(/fonts/${face.file}) format('truetype')`,
        { weight: face.weight, display: 'block' },
      );
      await font.load();
      document.fonts.add(font);
    }),
  )
    .then(() => true)
    .catch(() => {
      // Most likely not downloaded yet; the settings copy points at the command.
      nerdFontLoad = null;
      return false;
    });

  return nerdFontLoad;
}
