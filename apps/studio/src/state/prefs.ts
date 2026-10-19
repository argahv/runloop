import type { Quality } from '../scene/types';

export type ThemePref = 'system' | 'dark' | 'light';
export type MotionPref = 'system' | 'reduce' | 'full';

/** Viewer preferences, kept in this browser only (localStorage). */
export interface Prefs {
  theme: ThemePref;
  motion: MotionPref;
  quality: Quality;
  /** Runtime URL override; null = the build default. */
  apiBase: string | null;
}

export const DEFAULT_PREFS: Prefs = { theme: 'system', motion: 'system', quality: 'auto', apiBase: null };

export const PREFS_KEY = 'runloop.prefs.v1';

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** Tolerant parse: unknown or broken values fall back to the defaults. */
export function parsePrefs(raw: string | null): Prefs {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') v = parsed as Record<string, unknown>;
  } catch {
    // keep defaults
  }
  return {
    theme: pick(v.theme, ['system', 'dark', 'light'], DEFAULT_PREFS.theme),
    motion: pick(v.motion, ['system', 'reduce', 'full'], DEFAULT_PREFS.motion),
    quality: pick(v.quality, ['auto', 'high', 'low'], DEFAULT_PREFS.quality),
    apiBase: typeof v.apiBase === 'string' && v.apiBase ? v.apiBase : null,
  };
}

/** localStorage can throw (private windows, blocked storage); never let that break the page. */
export const safeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // not persisted; the page keeps working
    }
  },
};

export function loadPrefs(): Prefs {
  return parsePrefs(safeStorage.getItem(PREFS_KEY));
}

export function savePrefs(p: Prefs): void {
  safeStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

/**
 * Runs in <head> before first paint so the page never flashes the wrong
 * theme. Mirrors parsePrefs/applyTheme; keep the key in sync with PREFS_KEY.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement,p={};try{p=JSON.parse(localStorage.getItem(${JSON.stringify(
  PREFS_KEY,
)})||'{}')||{}}catch(e){}var t=p.theme;if(t!=='light'&&t!=='dark'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}d.setAttribute('data-theme',t);if(p.motion==='reduce'||p.motion==='full')d.setAttribute('data-motion',p.motion)})()`;

export function resolveTheme(pref: ThemePref, systemPrefersLight: boolean): 'dark' | 'light' {
  return pref === 'system' ? (systemPrefersLight ? 'light' : 'dark') : pref;
}

export function effectiveReducedMotion(pref: MotionPref, systemPrefersReduced: boolean): boolean {
  return pref === 'reduce' || (pref === 'system' && systemPrefersReduced);
}
