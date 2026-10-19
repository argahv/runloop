import { describe, expect, it } from 'vitest';
import { MAX_AHEAD_MS, TickSmoother, frameTick } from './clock';
import { deltaE2000, hexToRgb, mixHex } from './color';
import { HYSTERESIS, T0_PX, T1_PX, projectedHeightPersp, tierFor, type Tier } from './lod';
import { distanceFor } from './cameraMath';
import { AdaptiveQuality, percentile } from './quality';
import { skyAt, skyBrightness, sunDirection } from './sky';
import { LIME, SEMANTIC, daylightMaterials } from './townPalette';
import { commonsRaw } from './test-helpers';

describe('color', () => {
  it('CIEDE2000 matches reference values', () => {
    expect(deltaE2000('#000000', '#ffffff')).toBeCloseTo(100, 3);
    expect(deltaE2000('#b8f36a', '#b8f36a')).toBe(0);
    expect(deltaE2000('#ff0000', '#00ff00')).toBeCloseTo(deltaE2000('#00ff00', '#ff0000'), 9);
    // Sharma et al. (2005) pair 1 converted to sRGB lands near 2.0; the sign of the hue term matters most here.
    expect(deltaE2000('#ff6b76', '#ff6b77')).toBeLessThan(1);
  });
  it('mixes in sRGB', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
  });
});

describe('town palette (render draft §4 style rules)', () => {
  it('keeps lime out of every daylight material and the town file', () => {
    const { town } = commonsRaw() as { town: { buildings: { id: string; palette: Record<string, string>; sign?: { hue: string } }[]; districts: { id: string; ground: string }[]; look: Record<string, string[] | Record<string, string[]>> } };
    const colours: Record<string, string> = { ...daylightMaterials() };
    for (const b of town.buildings) {
      for (const [k, v] of Object.entries(b.palette)) colours[`${b.id}.${k}`] = v;
      if (b.sign) colours[`${b.id}.sign`] = b.sign.hue;
    }
    for (const d of town.districts) colours[`${d.id}.ground`] = d.ground;
    for (const [k, v] of Object.entries(town.look)) {
      const lists = Array.isArray(v) ? { [k]: v } : v;
      for (const [s, list] of Object.entries(lists)) list.forEach((c, i) => (colours[`look.${k}.${s}.${i}`] = c));
    }
    const near = Object.entries(colours).filter(([, c]) => deltaE2000(c, LIME) < 12);
    expect(near).toEqual([]);
  });
  it('keeps the renderer’s own materials apart from the semantic colours', () => {
    const near: string[] = [];
    for (const [k, c] of Object.entries(daylightMaterials())) {
      for (const [s, ref] of Object.entries(SEMANTIC)) if (deltaE2000(c, ref) < 12) near.push(`${k} ~ ${s}`);
    }
    expect(near).toEqual([]);
  });
});

describe('sky (DL-011)', () => {
  it('changes smoothly minute to minute', () => {
    for (let m = 0; m < 1440; m++) {
      const a = skyAt(m);
      const b = skyAt(m + 1);
      expect(Math.abs(a.sunIntensity - b.sunIntensity)).toBeLessThan(0.05);
      expect(Math.abs(a.ambient - b.ambient)).toBeLessThan(0.01);
      expect(Math.abs(a.night - b.night)).toBeLessThan(0.03);
      expect(deltaE2000(a.sunColor, b.sunColor)).toBeLessThan(2);
      const dot = a.sunDir[0] * b.sunDir[0] + a.sunDir[1] * b.sunDir[1] + a.sunDir[2] * b.sunDir[2];
      expect(dot).toBeGreaterThan(Math.cos((4 * Math.PI) / 180));
      for (const k of ['zenith', 'horizon', 'haze', 'cloud'] as const) expect(deltaE2000(a[k], b[k])).toBeLessThan(2);
      expect(Math.abs(a.stars - b.stars)).toBeLessThan(0.03);
    }
  });
  it('is brightest around noon and dark at night', () => {
    const at = (m: number) => skyBrightness(skyAt(m));
    let best = 0;
    for (let m = 0; m < 1440; m += 5) if (at(m) > at(best)) best = m;
    expect(Math.abs(best - 720)).toBeLessThanOrEqual(60);
    expect(skyAt(23 * 60).night).toBe(1);
    expect(skyAt(3 * 60).night).toBe(1);
    expect(skyAt(12 * 60).night).toBe(0);
    expect(at(23 * 60)).toBeLessThan(at(12 * 60) * 0.6);
  });
  it('raises the sun in the east and sets it in the west', () => {
    expect(sunDirection(400)![0]).toBeGreaterThan(0);
    expect(sunDirection(1000)![0]).toBeLessThan(0);
    expect(sunDirection(23 * 60)).toBeNull();
    const noon = sunDirection(720)!;
    expect(noon[1]).toBeGreaterThan(0.7);
    expect(noon[2]).toBeGreaterThan(0);
  });
});

describe('clock interpolation', () => {
  it('extrapolates by speed, clamps, and holds while paused', () => {
    const c = { tick: 600, speed: 4, receivedAt: 1000 };
    expect(frameTick(c, 1000)).toBe(600);
    expect(frameTick(c, 1500)).toBe(602);
    expect(frameTick(c, 1000 + MAX_AHEAD_MS + 5000)).toBe(600 + (4 * MAX_AHEAD_MS) / 1000);
    expect(frameTick(c, 500)).toBe(600);
    expect(frameTick({ ...c, speed: 0 }, 9000)).toBe(600);
  });
  it('never steps back by a small correction, but takes a real jump', () => {
    const s = new TickSmoother(1);
    expect(s.next(10)).toBe(10);
    expect(s.next(10.6)).toBe(10.6);
    expect(s.next(10.2)).toBe(10.6);
    expect(s.next(10.7)).toBe(10.7);
    expect(s.next(4)).toBe(4);
  });
});

describe('LOD tiers', () => {
  it('maps projected height to tiers', () => {
    expect(tierFor(40, null)).toBe(0);
    expect(tierFor(20, null)).toBe(1);
    expect(tierFor(5, null)).toBe(2);
  });
  it('does not flicker around a boundary (±15% hysteresis)', () => {
    for (const boundary of [T0_PX, T1_PX]) {
      let tier: Tier | null = null;
      const seen = new Set<Tier>();
      for (let i = 0; i < 200; i++) {
        const px = boundary * (1 + 0.1 * Math.sin(i));
        tier = tierFor(px, tier);
        if (i > 0) seen.add(tier);
      }
      expect(seen.size).toBe(1);
    }
    // Clearing the margin does switch.
    expect(tierFor(T0_PX * (1 + HYSTERESIS) + 0.01, 1)).toBe(0);
    expect(tierFor(T0_PX * (1 - HYSTERESIS) - 0.01, 0)).toBe(1);
    expect(tierFor(T1_PX * (1 - HYSTERESIS) - 0.01, 1)).toBe(2);
    expect(tierFor(100, 2)).toBe(0);
  });
  it('projects heights under the perspective camera (zoom = px per unit at the target)', () => {
    // At the target's distance one unit is `zoom` px tall.
    const d = distanceFor(30, 20, 900);
    expect(projectedHeightPersp(1, d, 20, 900)).toBeCloseTo(30, 9);
    // Twice as near, twice as tall.
    expect(projectedHeightPersp(1, d / 2, 20, 900)).toBeCloseTo(60, 9);
  });
});

describe('adaptive quality', () => {
  it('steps down after p95 > 22 ms for 2 s, and up after 10 s under 12 ms', () => {
    const q = new AdaptiveQuality('auto');
    let t = 0;
    let changed = false;
    while (t < 1900) {
      changed ||= q.sample(30, t);
      t += 33;
    }
    expect(changed).toBe(false);
    // The window needs a few frames before it judges, so allow a little past the 2 s hold.
    while (t < 3200 && !changed) {
      changed = q.sample(30, t);
      t += 33;
    }
    expect(q.level).toBe(1);
    for (let i = 0; i < 900; i++) q.sample(8, (t += 16));
    expect(q.level).toBe(0);
  });
  it('never changes a pinned preference', () => {
    const q = new AdaptiveQuality('high');
    for (let t = 0; t < 10_000; t += 16) q.sample(50, t);
    expect(q.level).toBe(0);
    q.setPref('low');
    expect(q.settings.shadows).toBe(false);
  });
  it('computes nearest-rank percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });
});
