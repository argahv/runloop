import { readFileSync } from 'node:fs';
import { loadWorld } from '@runloop-world/world-engine';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ISO_DIR, TOP_DIR, boardPoints, cubicBezier, easeOut, frameBoard, parseDurationMs, projectToScreen, type Insets } from './framing';

const world = loadWorld(JSON.parse(readFileSync(new URL('../../../../worlds/research-campus/world.json', import.meta.url), 'utf8')));
const INSETS: Insets = { top: 46, right: 58, bottom: 50, left: 24 };

/** Screen bounding box of the board for a framing. */
function screenBox(dir: Vector3, w: number, h: number) {
  const f = frameBoard(world, dir, w, h, INSETS);
  const pts = boardPoints(world).map((p) => projectToScreen(p, dir, f.target, f.zoom, w, h));
  return {
    f,
    l: Math.min(...pts.map((p) => p.x)),
    r: Math.max(...pts.map((p) => p.x)),
    t: Math.min(...pts.map((p) => p.y)),
    b: Math.max(...pts.map((p) => p.y)),
  };
}

describe('fit-to-viewport framing', () => {
  // Canvas sizes of the Live World stage between 1280 and 1920 px windows, plus tall and tiny panels.
  const sizes: [number, number][] = [
    [640, 330],
    [787, 410],
    [1267, 518],
    [1500, 700],
    [500, 700],
    [300, 200],
  ];

  for (const dir of [ISO_DIR, TOP_DIR]) {
    for (const [w, h] of sizes) {
      it(`keeps the whole board inside the free area (${dir === ISO_DIR ? 'iso' : 'top'}, ${w}×${h})`, () => {
        const { l, r, t, b } = screenBox(dir, w, h);
        const eps = 0.5;
        expect(l).toBeGreaterThanOrEqual(INSETS.left - eps);
        expect(r).toBeLessThanOrEqual(w - INSETS.right + eps);
        expect(t).toBeGreaterThanOrEqual(INSETS.top - eps);
        expect(b).toBeLessThanOrEqual(h - INSETS.bottom + eps);
        // ...and uses it: the binding axis touches both insets.
        const fillsW = Math.abs(l - INSETS.left) < 1 && Math.abs(r - (w - INSETS.right)) < 1;
        const fillsH = Math.abs(t - INSETS.top) < 1 && Math.abs(b - (h - INSETS.bottom)) < 1;
        expect(fillsW || fillsH).toBe(true);
      });
    }
  }

  it('zooms with the canvas (bigger stage, bigger board)', () => {
    expect(frameBoard(world, ISO_DIR, 1500, 700, INSETS).zoom).toBeGreaterThan(frameBoard(world, ISO_DIR, 787, 410, INSETS).zoom);
  });
});

describe('camera motion', () => {
  it('eases out like --rl-ease-out and stays within [0, 1]', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.8); // most of the move happens early
    let prev = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const v = easeOut(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 3); // linear
  });

  it('reads duration tokens, including the zeroed reduced-motion value', () => {
    expect(parseDurationMs('550ms', 1)).toBe(550);
    expect(parseDurationMs(' 0.4s ', 1)).toBe(400);
    expect(parseDurationMs('0ms', 550)).toBe(0);
    expect(parseDurationMs('', 550)).toBe(550);
    expect(parseDurationMs('fast', 550)).toBe(550);
  });
});
