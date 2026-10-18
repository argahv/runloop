import { readFileSync } from 'node:fs';
import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture } from '@runloop-world/testkit';
import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { DARK_TOKENS, buildPalette, identityHex, readTokens, zoneFloor } from './palette';

/** Pull `--name: value;` declarations out of one block of tokens.css. */
function tokensOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--rl-[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const css = readFileSync(new URL('../app/tokens.css', import.meta.url), 'utf8');
const dark = tokensOf(css, ':root {');
const light = tokensOf(css, ":root[data-theme='light']");
const sat = (c: string) => {
  const hsl = { h: 0, s: 0, l: 0 };
  new Color(c).getHSL(hsl);
  return hsl.s;
};

describe('scene palette from the design tokens', () => {
  it('matches tokens.css (the scene defaults are the dark tokens)', () => {
    const t = readTokens((n) => dark[n] ?? '');
    expect(t).toEqual(DARK_TOKENS);
  });

  it('follows the theme: light tokens give a light world, with lime still reserved for active execution', () => {
    const p = buildPalette(readTokens((n) => light[n] ?? dark[n] ?? ''));
    expect(p.theme).toBe('light');
    expect(p.active).toBe(light['--rl-lime']);
    expect(p.glow).toBe(false);
    const d = buildPalette(DARK_TOKENS);
    expect(d.theme).toBe('dark');
    expect(d.active).toBe('#b8f36a');
    expect(d.glow).toBe(true);
  });

  it('never uses lime for architecture, outcomes or identity', () => {
    const p = buildPalette(DARK_TOKENS);
    const lime = p.active.toLowerCase();
    const others = [p.slabTop, p.slabSide, p.corridor, p.room, p.wall, p.wallCap, p.curb, p.path, p.metal, p.visor, p.success, p.warning, p.failure, ...p.identity];
    expect(others.map((c) => c.toLowerCase())).not.toContain(lime);
  });

  it('keeps zone floors desaturated (quiet tints of graphite)', () => {
    const p = buildPalette(DARK_TOKENS);
    for (const zone of ['#38bdf8', '#818cf8', '#34d399', '#c084fc', '#f59e0b']) {
      expect(sat(zoneFloor(p, zone))).toBeLessThan(sat(zone) * 0.5);
    }
  });

  it('keeps a visible but desaturated environment tint on light floors too', () => {
    const p = buildPalette(readTokens((n) => light[n] ?? dark[n] ?? ''));
    for (const zone of ['#38bdf8', '#818cf8', '#34d399', '#c084fc']) {
      const s = sat(zoneFloor(p, zone));
      expect(s).toBeGreaterThan(0.05);
      expect(s).toBeLessThan(sat(zone) * 0.5);
    }
  });

  it('gives robots a dark visor in both themes, with eyes in the dark-theme state colours so they always read', () => {
    for (const p of [buildPalette(DARK_TOKENS), buildPalette(readTokens((n) => light[n] ?? dark[n] ?? ''))]) {
      expect(new Color(p.visor).getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(0.1);
      expect(p.eyes.active).toBe(DARK_TOKENS.lime);
      expect(p.eyes.failure).toBe(DARK_TOKENS.failure);
      expect(p.eyes.success).toBe(DARK_TOKENS.success);
      expect(p.eyes.warning).toBe(DARK_TOKENS.warning);
    }
  });

  it('lights the world with a warm key and a cool rim in both themes', () => {
    for (const p of [buildPalette(DARK_TOKENS), buildPalette(readTokens((n) => light[n] ?? dark[n] ?? ''))]) {
      const key = new Color(p.lights.keyColor);
      const rim = new Color(p.lights.rimColor);
      expect(key.r).toBeGreaterThan(key.b);
      expect(rim.b).toBeGreaterThan(rim.r);
      expect(p.lights.key).toBeGreaterThan(p.lights.rim);
    }
  });

  it('gives each embodied agent the same identity hue as the timeline (state/identity.ts)', () => {
    const p = buildPalette(DARK_TOKENS);
    const exec = foldExecution(codingMissionFixture());
    expect(identityHex(p, exec, 'researcher')).toBe(DARK_TOKENS.identity[0]);
    expect(identityHex(p, exec, 'builder')).toBe(DARK_TOKENS.identity[1]);
    expect(identityHex(p, exec, 'tester')).toBe(DARK_TOKENS.identity[2]);
    expect(identityHex(p, exec, 'coordinator')).toBe(DARK_TOKENS.identityNeutral);
  });
});
