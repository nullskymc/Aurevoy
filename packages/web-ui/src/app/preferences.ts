import type { Locale } from "../i18n";
import type { ThemeMode, WorkMode } from "./types";

export const MIN_SIDEBAR_WIDTH = 260;
export const MAX_SIDEBAR_WIDTH = 420;
/** Coding workbench (explorer + editor). Wide enough for tree + preview. */
export const MIN_WORKBENCH_WIDTH = 520;
export const MAX_WORKBENCH_WIDTH = 1100;
export const DEFAULT_WORKBENCH_WIDTH = 720;
export const DEFAULT_CHAT_FONT_SIZE = 14;
export const DEFAULT_UI_FONT_SIZE = 12.5;
export const DEFAULT_CODE_FONT_SIZE = 12;
export const CHAT_FONT_SIZE_KEY = "aurevoy.chatFontSizePx.v2";
export const UI_FONT_SIZE_KEY = "aurevoy.uiFontSizePx.v2";
export const CODE_FONT_SIZE_KEY = "aurevoy.codeFontSizePx.v2";
export const TOOL_DETAILS_OPEN_KEY = "aurevoy.defaultToolDetailsOpen";
export const THEME_MODE_KEY = "aurevoy.themeMode";
export const LOCALE_KEY = "aurevoy.locale";
export const WORK_MODE_KEY = "aurevoy.workMode";
export const WORKBENCH_WIDTH_KEY = "aurevoy.workbenchWidth";
export const WORKBENCH_OPEN_KEY = "aurevoy.workbenchOpen";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  const stored = window.localStorage.getItem(key);
  const parsed = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  const stored = window.localStorage.getItem(key);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return fallback;
}

export function readStoredOption<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const stored = window.localStorage.getItem(key);
  return stored && allowed.includes(stored as T) ? (stored as T) : fallback;
}

export function readStoredThemeMode(): ThemeMode {
  return readStoredOption(THEME_MODE_KEY, "system", ["system", "light", "dark"] as const);
}

export function readStoredLocale(): Locale {
  return readStoredOption(LOCALE_KEY, "en", ["zh", "en", "ko", "ja"] as const);
}

export function readStoredWorkMode(defaultToolDetailsOpen: boolean): WorkMode {
  return readStoredOption(WORK_MODE_KEY, defaultToolDetailsOpen ? "coding" : "daily", ["coding", "daily"] as const);
}
