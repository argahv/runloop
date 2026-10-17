import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, effectiveReducedMotion, parsePrefs, PREFS_KEY, resolveTheme, THEME_INIT_SCRIPT } from './prefs';

describe('viewer preferences', () => {
  it('parses stored prefs and falls back on anything broken', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"theme":"light","motion":"reduce","quality":"low","apiBase":"http://127.0.0.1:4392"}')).toEqual({
      theme: 'light',
      motion: 'reduce',
      quality: 'low',
      apiBase: 'http://127.0.0.1:4392',
    });
    expect(parsePrefs('{"theme":"neon","quality":3}')).toEqual(DEFAULT_PREFS);
  });

  it('resolves the theme and reduced motion against the system', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(effectiveReducedMotion('system', true)).toBe(true);
    expect(effectiveReducedMotion('full', true)).toBe(false);
    expect(effectiveReducedMotion('reduce', false)).toBe(true);
  });

  it('sets data-theme and data-motion before paint from storage', () => {
    const run = (stored: string | null, prefersLight: boolean) => {
      const attrs: Record<string, string> = {};
      const env = {
        document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } },
        localStorage: { getItem: (k: string) => (k === PREFS_KEY ? stored : null) },
        window: { matchMedia: () => ({ matches: prefersLight }) },
        matchMedia: () => ({ matches: prefersLight }),
      };
      new Function('document', 'localStorage', 'window', 'matchMedia', THEME_INIT_SCRIPT)(env.document, env.localStorage, env.window, env.matchMedia);
      return attrs;
    };
    expect(run(null, false)).toEqual({ 'data-theme': 'dark' });
    expect(run(null, true)).toEqual({ 'data-theme': 'light' });
    expect(run('{"theme":"dark","motion":"reduce"}', true)).toEqual({ 'data-theme': 'dark', 'data-motion': 'reduce' });
    expect(run('{oops', true)).toEqual({ 'data-theme': 'light' });
  });
});
