/**
 * Colour themes.
 *
 * Each theme carries both the terminal palette and the handful of interface
 * tokens the surrounding chrome is built from, so the terminal never looks like
 * a black rectangle pasted onto an unrelated page. Browser-safe: no imports.
 */

export interface UiTokens {
  /** Page background behind everything. */
  base: string;
  /** Panels, sidebar, tab bar. */
  surface: string;
  /** Hovered rows, popovers, inputs. */
  surfaceRaised: string;
  border: string;
  accent: string;
  accentContrast: string;
  text: string;
  textMuted: string;
  danger: string;
  warning: string;
  success: string;
}

export interface TerminalTheme {
  name: string;
  label: string;
  dark: boolean;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  ui: UiTokens;
}

export const themes: Record<string, TerminalTheme> = {
  'ptyhub-dark': {
    name: 'ptyhub-dark',
    label: 'ptyhub Dark',
    dark: true,
    background: '#0f1117',
    foreground: '#d7dce5',
    cursor: '#7aa2ff',
    cursorAccent: '#0f1117',
    selectionBackground: '#27304a',
    black: '#1b1f2a',
    red: '#ff6b81',
    green: '#64d19a',
    yellow: '#f0c274',
    blue: '#7aa2ff',
    magenta: '#c08cff',
    cyan: '#5fd5e0',
    white: '#c6ccd8',
    brightBlack: '#4a5268',
    brightRed: '#ff8a9b',
    brightGreen: '#83e3b4',
    brightYellow: '#ffd899',
    brightBlue: '#9dbaff',
    brightMagenta: '#d3aaff',
    brightCyan: '#87e6ef',
    brightWhite: '#f2f5fa',
    ui: {
      base: '#0b0d12',
      surface: '#12151d',
      surfaceRaised: '#1b1f2a',
      border: '#242a38',
      accent: '#7aa2ff',
      accentContrast: '#0b0d12',
      text: '#d7dce5',
      textMuted: '#8b93a7',
      danger: '#ff6b81',
      warning: '#f0c274',
      success: '#64d19a',
    },
  },

  'ptyhub-light': {
    name: 'ptyhub-light',
    label: 'ptyhub Light',
    dark: false,
    background: '#fbfcfe',
    foreground: '#2b303b',
    cursor: '#2f6fed',
    cursorAccent: '#fbfcfe',
    selectionBackground: '#d5e3ff',
    black: '#2b303b',
    red: '#c53049',
    green: '#1d7f56',
    yellow: '#8a6100',
    blue: '#2f6fed',
    magenta: '#7b46c9',
    cyan: '#0f7a86',
    white: '#6b7280',
    brightBlack: '#4b5262',
    brightRed: '#d94a60',
    brightGreen: '#27976a',
    brightYellow: '#a67600',
    brightBlue: '#4f88f5',
    brightMagenta: '#9166dd',
    brightCyan: '#1795a3',
    brightWhite: '#111827',
    ui: {
      base: '#f3f5f9',
      surface: '#ffffff',
      surfaceRaised: '#eef1f6',
      border: '#dde2ea',
      accent: '#2f6fed',
      accentContrast: '#ffffff',
      text: '#2b303b',
      textMuted: '#6b7280',
      danger: '#c53049',
      warning: '#8a6100',
      success: '#1d7f56',
    },
  },

  'one-dark': {
    name: 'one-dark',
    label: 'One Dark',
    dark: true,
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
    ui: {
      base: '#21252b',
      surface: '#282c34',
      surfaceRaised: '#323842',
      border: '#3e4451',
      accent: '#61afef',
      accentContrast: '#21252b',
      text: '#abb2bf',
      textMuted: '#7f848e',
      danger: '#e06c75',
      warning: '#e5c07b',
      success: '#98c379',
    },
  },

  'tokyo-night': {
    name: 'tokyo-night',
    label: 'Tokyo Night',
    dark: true,
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#33467c',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
    ui: {
      base: '#16161e',
      surface: '#1a1b26',
      surfaceRaised: '#242536',
      border: '#2f334d',
      accent: '#7aa2f7',
      accentContrast: '#16161e',
      text: '#c0caf5',
      textMuted: '#787c99',
      danger: '#f7768e',
      warning: '#e0af68',
      success: '#9ece6a',
    },
  },

  dracula: {
    name: 'dracula',
    label: 'Dracula',
    dark: true,
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
    ui: {
      base: '#21222c',
      surface: '#282a36',
      surfaceRaised: '#343746',
      border: '#44475a',
      accent: '#bd93f9',
      accentContrast: '#21222c',
      text: '#f8f8f2',
      textMuted: '#8f93a5',
      danger: '#ff5555',
      warning: '#f1fa8c',
      success: '#50fa7b',
    },
  },

  'solarized-dark': {
    name: 'solarized-dark',
    label: 'Solarized Dark',
    dark: true,
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#657b83',
    brightYellow: '#839496',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
    ui: {
      base: '#00212b',
      surface: '#002b36',
      surfaceRaised: '#073642',
      border: '#0d4a5a',
      accent: '#268bd2',
      accentContrast: '#00212b',
      text: '#93a1a1',
      textMuted: '#586e75',
      danger: '#dc322f',
      warning: '#b58900',
      success: '#859900',
    },
  },

  'github-light': {
    name: 'github-light',
    label: 'GitHub Light',
    dark: false,
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#24292f',
    cursorAccent: '#ffffff',
    selectionBackground: '#b6dcff',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
    ui: {
      base: '#f6f8fa',
      surface: '#ffffff',
      surfaceRaised: '#eef1f4',
      border: '#d0d7de',
      accent: '#0969da',
      accentContrast: '#ffffff',
      text: '#24292f',
      textMuted: '#57606a',
      danger: '#cf222e',
      warning: '#9a6700',
      success: '#1a7f37',
    },
  },
};

export const themeNames = Object.keys(themes);

export const DEFAULT_DARK_THEME = 'ptyhub-dark';
export const DEFAULT_LIGHT_THEME = 'ptyhub-light';

export function getTheme(name: string, fallback = DEFAULT_DARK_THEME): TerminalTheme {
  return themes[name] ?? themes[fallback]!;
}
