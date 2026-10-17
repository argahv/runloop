import { describe, expect, it } from 'vitest';
import { shortcutFor } from './keyboard';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  defaultPrevented: false,
  ...mods,
});

describe('keyboard shortcuts', () => {
  it('maps Space, arrows, L, [ ], F', () => {
    expect(shortcutFor(key(' '), null)).toBe('togglePlay');
    expect(shortcutFor(key('ArrowLeft'), null)).toBe('stepPrev');
    expect(shortcutFor(key('ArrowRight'), null)).toBe('stepNext');
    expect(shortcutFor(key('l'), null)).toBe('goLive');
    expect(shortcutFor(key('L'), null)).toBe('goLive');
    expect(shortcutFor(key('['), null)).toBe('prevAgent');
    expect(shortcutFor(key(']'), null)).toBe('nextAgent');
    expect(shortcutFor(key('f'), null)).toBe('toggleFollow');
    expect(shortcutFor(key('x'), null)).toBeNull();
  });

  it('leaves modified keys to the browser', () => {
    expect(shortcutFor(key('l', { ctrlKey: true }), null)).toBeNull();
    expect(shortcutFor(key('f', { metaKey: true }), null)).toBeNull();
    expect(shortcutFor(key(' ', { defaultPrevented: true }), null)).toBeNull();
  });
});
