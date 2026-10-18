import { readFileSync } from 'node:fs';
import { loadWorld } from '@runloop-world/world-engine';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ISO_DIR,
  SLAB_INSETS,
  TOP_DIR,
  cubicBezier,
  easeOut,
  frameBoard,
  frameBounds,
  parseDurationMs,
  projectToScreen,
  roomInsets,
  roomPoints,
  slabPoints,
  type Insets,
} from './framing';
import { ROBOT_HEIGHT } from './layout';

const world = loadWorld(JSON.parse(readFileSync(new URL('../../../../worlds/research-campus/world.json', import.meta.url), 'utf8')));

/** Screen bounding box of a set of points for a framing. */
function box(points: Vector3[], dir: Vector3, f: { zoom: number; target: Vector3 }, w: number, h: number) {
  const pts = points.map((p) => projectToScreen(p, dir, f.target, f.zoom, w, h));
  return {
    l: Math.min(...pts.map((p) => p.x)),
    r: Math.max(...pts.map((p) => p.x)),
    t: Math.min(...pts.map((p) => p.y)),
    b: Math.max(...pts.map((p) => p.y)),
  };
}

function inside(b: ReturnType<typeof box>, w: number, h: number, i: Insets) {
  const eps = 0.5;
  expect(b.l).toBeGreaterThanOrEqual(i.left - eps);
  expect(b.r).toBeLessThanOrEqual(w - i.right + eps);
  expect(b.t).toBeGreaterThanOrEqual(i.top - eps);
  expect(b.b).toBeLessThanOrEqual(h - i.bottom + eps);
}

/**
 * Live World stage canvases measured at 1280×800, 1440×900, 1600×1000 and
 * 1920×1080 windows (inspector open; a traced run's header is one line
 * taller than an executed run's, so its stage is 10 px shorter).
 */
const STAGES: [number, number][] = [
  [627, 349],
  [627, 339],
  [787, 409],
  [787, 399],
  [947, 469],
  [947, 459],
  [1267, 517],
  [1267, 507],
];

describe('fit-to-viewport framing', () => {
  // The stage sizes, plus a stage with the timeline collapsed, a tall one and a tiny one.
  const sizes: [number, number][] = [...STAGES, [640, 330], [1500, 700], [1100, 760], [500, 700], [300, 200]];

  for (const dir of [ISO_DIR, TOP_DIR]) {
    for (const [w, h] of sizes) {
      it(`keeps the slab on the canvas and the rooms clear of the controls (${dir === ISO_DIR ? 'iso' : 'top'}, ${w}×${h})`, () => {
        const f = frameBoard(world, dir, w, h);
        inside(box(slabPoints(world), dir, f, w, h), w, h, SLAB_INSETS);
        inside(box(roomPoints(world), dir, f, w, h), w, h, roomInsets(dir));
      });
    }
  }

  for (const [w, h] of STAGES) {
    it(`fills the Live World stage at ${w}×${h}: the board spans ≥ 80% of its width`, () => {
      const f = frameBoard(world, ISO_DIR, w, h);
      const b = box(slabPoints(world), ISO_DIR, f, w, h);
      expect((b.r - b.l) / w).toBeGreaterThanOrEqual(0.8);
    });
  }

  it('makes a robot at least 28 px tall on the 1440×900 stage', () => {
    const [w, h] = STAGES[3]!;
    const f = frameBoard(world, ISO_DIR, w, h);
    const feet = projectToScreen(new Vector3(0, 0, 0), ISO_DIR, f.target, f.zoom, w, h);
    const head = projectToScreen(new Vector3(0, ROBOT_HEIGHT, 0), ISO_DIR, f.target, f.zoom, w, h);
    expect(feet.y - head.y).toBeGreaterThanOrEqual(28);
  });

  it('zooms with the canvas (bigger stage, bigger board)', () => {
    expect(frameBoard(world, ISO_DIR, 1500, 700).zoom).toBeGreaterThan(frameBoard(world, ISO_DIR, 787, 410).zoom);
  });

  it('fits a single group exactly on its binding axis', () => {
    const pts = [new Vector3(-1, 0, -1), new Vector3(1, 0, 1)];
    const insets = { top: 10, right: 10, bottom: 10, left: 10 };
    const f = frameBounds(pts, TOP_DIR, 200, 100, insets);
    const b = box(pts, TOP_DIR, f, 200, 100);
    expect(b.t).toBeCloseTo(10, 0);
    expect(b.b).toBeCloseTo(90, 0);
    expect((b.l + b.r) / 2).toBeCloseTo(100, 0);
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
