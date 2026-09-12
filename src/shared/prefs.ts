/**
 * Appearance preferences, shared by the browser and the gateway.
 *
 * Stored server-side so a new device inherits your look immediately, with the
 * size-sensitive values kept per device class: a font size that reads well on a
 * 27-inch monitor is unusable on a phone, and the reverse.
 *
 * Browser-safe: types and pure functions only.
 */

import type { TerminalTheme } from './themes.ts';
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, themes } from './themes.ts';

export type DeviceClass = 'desktop' | 'tablet' | 'mobile';
export type ColorScheme = 'system' | 'dark' | 'light';
export type CursorStyle = 'block' | 'bar' | 'underline';
/**
 * What a phone does when it shares a session with a bigger screen.
 *
 * `reflow` gives the phone its own window size, like any other client, so the
 * text is readable. `scale` keeps whatever size the other client set and shrinks
 * the picture to fit — useful for watching a desktop session without disturbing
 * it, unpleasant to actually work in.
 */
export type MobileFitMode = 'scale' | 'reflow';

export interface FontPrefs {
  /** CSS font-family stack head; the monospace fallback is always appended. */
  family: string;
  /** Per device class, in px. */
  size: Record<DeviceClass, number>;
  lineHeight: number;
  letterSpacing: number;
  ligatures: boolean;
  /** Use the locally fetched Nerd Font build for powerline glyphs. */
  nerdFont: boolean;
}

export interface Prefs {
  colorScheme: ColorScheme;
  /** Theme used when resolving to dark. */
  darkTheme: string;
  /** Theme used when resolving to light. */
  lightTheme: string;
  /** Optional user-authored palette, selected by name `custom`. */
  customTheme: TerminalTheme | null;
  font: FontPrefs;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  linkify: boolean;
  /** Shrink paddings and row heights for more terminal per screen. */
  compact: boolean;
  mobileFit: MobileFitMode;
  /**
   * Let the tab icon report connection health and unseen output. Off by
   * default: an icon that recolours itself is distracting in a row of pinned
   * tabs, and the status pill already says the same thing.
   */
  dynamicFavicon: boolean;
  /** Session ids kept at the front of the tab bar, in this order. */
  pinned: string[];
  /** Manual tab order for sessions the user has dragged, by id. */
  sessionOrder: string[];
  /** Serialized split-pane layout, opaque to the server. */
  layout: unknown;
}

export const BUILTIN_FONT_STACKS: { label: string; value: string }[] = [
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'System monospace', value: 'ui-monospace' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'Source Code Pro', value: 'Source Code Pro' },
  { label: 'Fira Code', value: 'Fira Code' },
  { label: 'Cascadia Code', value: 'Cascadia Code' },
];

export const FALLBACK_FONT_STACK =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const defaultPrefs: Prefs = {
  colorScheme: 'system',
  darkTheme: DEFAULT_DARK_THEME,
  lightTheme: DEFAULT_LIGHT_THEME,
  customTheme: null,
  font: {
    family: 'JetBrains Mono',
    size: { desktop: 14, tablet: 14, mobile: 12 },
    lineHeight: 1.25,
    letterSpacing: 0,
    ligatures: false,
    nerdFont: false,
  },
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  linkify: true,
  compact: false,
  mobileFit: 'reflow',
  dynamicFavicon: false,
  pinned: [],
  sessionOrder: [],
  layout: null,
};

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function themeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (value === 'custom' || value in themes) return value;
  return fallback;
}

/**
 * Validate and fill in anything the stored file is missing or got wrong.
 * Preferences come over the network, so nothing here trusts its input.
 */
export function normalizePrefs(input: unknown): Prefs {
  const raw = (input ?? {}) as Partial<Prefs>;
  const font = (raw.font ?? {}) as Partial<FontPrefs>;
  const size = (font.size ?? {}) as Partial<Record<DeviceClass, number>>;

  return {
    colorScheme: pickEnum(raw.colorScheme, ['system', 'dark', 'light'], 'system'),
    darkTheme: themeName(raw.darkTheme, defaultPrefs.darkTheme),
    lightTheme: themeName(raw.lightTheme, defaultPrefs.lightTheme),
    customTheme:
      raw.customTheme && typeof raw.customTheme === 'object'
        ? (raw.customTheme as TerminalTheme)
        : null,
    font: {
      family:
        typeof font.family === 'string' && font.family.trim()
          ? font.family.trim().slice(0, 120)
          : defaultPrefs.font.family,
      size: {
        desktop: clamp(size.desktop, 8, 40, defaultPrefs.font.size.desktop),
        tablet: clamp(size.tablet, 8, 40, defaultPrefs.font.size.tablet),
        mobile: clamp(size.mobile, 8, 40, defaultPrefs.font.size.mobile),
      },
      lineHeight: clamp(font.lineHeight, 0.9, 2.5, defaultPrefs.font.lineHeight),
      letterSpacing: clamp(font.letterSpacing, -2, 4, defaultPrefs.font.letterSpacing),
      ligatures: bool(font.ligatures, defaultPrefs.font.ligatures),
      nerdFont: bool(font.nerdFont, defaultPrefs.font.nerdFont),
    },
    cursorStyle: pickEnum(raw.cursorStyle, ['block', 'bar', 'underline'], 'block'),
    cursorBlink: bool(raw.cursorBlink, defaultPrefs.cursorBlink),
    scrollback: Math.round(clamp(raw.scrollback, 100, 200_000, defaultPrefs.scrollback)),
    copyOnSelect: bool(raw.copyOnSelect, defaultPrefs.copyOnSelect),
    rightClickPaste: bool(raw.rightClickPaste, defaultPrefs.rightClickPaste),
    linkify: bool(raw.linkify, defaultPrefs.linkify),
    compact: bool(raw.compact, defaultPrefs.compact),
    mobileFit: pickEnum(raw.mobileFit, ['scale', 'reflow'], defaultPrefs.mobileFit),
    dynamicFavicon: bool(raw.dynamicFavicon, defaultPrefs.dynamicFavicon),
    pinned: idList(raw.pinned),
    sessionOrder: idList(raw.sessionOrder),
    layout: raw.layout ?? null,
  };
}

/** Session id lists arrive over the network; keep only plausible entries. */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= 64) {
      seen.add(entry);
    }
  }
  return [...seen].slice(0, 500);
}

export function resolveFontFamily(prefs: Prefs): string {
  const family = prefs.font.nerdFont
    ? `'${prefs.font.family} Nerd Font', '${prefs.font.family}'`
    : `'${prefs.font.family}'`;
  return `${family}, ${FALLBACK_FONT_STACK}`;
}

export function deviceClassFor(width: number, coarsePointer: boolean): DeviceClass {
  if (width < 680) return 'mobile';
  if (width < 1080 && coarsePointer) return 'tablet';
  return 'desktop';
}
