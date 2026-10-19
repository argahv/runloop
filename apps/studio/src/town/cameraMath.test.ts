import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEG,
  angleDelta,
  clipPlanes,
  distanceFor,
  fitPoints,
  footprint,
  fovYDeg,
  groundHit,
  groundHitClamped,
  project,
  quickDuration,
  rubberStep,
  springInto,
  viewOf,
  wheelZoomDelta,
  wrapAngle,
  zoomAt,
  type CamPose,
} from './cameraMath';

const VP = { width: 1440, height: 900 };
const pose = (o: Partial<CamPose> = {}): CamPose => ({ x: 3, z: -4, zoom: 20, az: 45 * DEG, tilt: 37 * DEG, ...o });

describe('camera maths (immersive contract §2)', () => {
  it('narrows the field of view to 20° from 30° up and widens it to 28° at 10°', () => {
    expect(fovYDeg(37)).toBe(20);
    expect(fovYDeg(30)).toBe(20);
    expect(fovYDeg(10)).toBe(28);
    expect(fovYDeg(20)).toBeCloseTo(24, 9);
  });

  it('keeps zoom = px per cell at the target, and the target at the principal point', () => {
    for (const p of [pose(), pose({ tilt: 10 * DEG, az: 200 * DEG, zoom: 55 }), pose({ tilt: 62 * DEG, zoom: 8 })]) {
      const v = viewOf(p, { ...VP, cx: 600, cy: 420 });
      const c = project(v, p.x, 0, p.z);
      expect(c.x).toBeCloseTo(600, 6);
      expect(c.y).toBeCloseTo(420, 6);
      expect(c.depth).toBeCloseTo(v.d, 6);
      // One unit along the screen's right axis at the target spans `zoom` px.
      const r = project(v, p.x + v.right[0], 0, p.z + v.right[2]);
      expect(r.x - c.x).toBeCloseTo(p.zoom, 6);
      expect(v.d).toBeCloseTo(distanceFor(p.zoom, fovYDeg(p.tilt / DEG), VP.height), 9);
    }
  });

  it('matches three’s PerspectiveCamera with a view offset', () => {
    const p = pose({ az: 130 * DEG, tilt: 22 * DEG, zoom: 31 });
    const vp = { ...VP, cx: 520, cy: 470 };
    const v = viewOf(p, vp);
    const cam = new PerspectiveCamera(v.fovY, VP.width / VP.height, 1, 2000);
    cam.position.set(...v.eye);
    cam.lookAt(p.x, 0, p.z);
    cam.setViewOffset(VP.width, VP.height, -(vp.cx - VP.width / 2), -(vp.cy - VP.height / 2), VP.width, VP.height);
    cam.updateMatrixWorld();
    for (const w of [new Vector3(0, 0, 0), new Vector3(10, 3, -7), new Vector3(-20, 0.5, 14)]) {
      const s = w.clone().project(cam);
      const mine = project(v, w.x, w.y, w.z);
      expect(mine.x).toBeCloseTo(((s.x + 1) / 2) * VP.width, 3);
      expect(mine.y).toBeCloseTo(((1 - s.y) / 2) * VP.height, 3);
    }
  });

  it('casts pixels onto the ground and back', () => {
    const v = viewOf(pose({ tilt: 25 * DEG }), VP);
    for (const [sx, sy] of [
      [100, 800],
      [720, 450],
      [1300, 300],
    ] as const) {
      const g = groundHit(v, sx, sy)!;
      const s = project(v, g.x, 0, g.z);
      expect(s.x).toBeCloseTo(sx, 4);
      expect(s.y).toBeCloseTo(sy, 4);
    }
  });

  it('sees sky above the horizon at a low tilt, and clamps drags there', () => {
    const v = viewOf(pose({ tilt: 10 * DEG, zoom: 20 }), VP);
    expect(groundHit(v, 720, 2)).toBeNull();
    const g = groundHitClamped(v, 720, 2);
    expect(Number.isFinite(g.x) && Number.isFinite(g.z)).toBe(true);
    // The horizon sits in the top 10–25% of the screen at 10° (contract A3).
    let horizon = 0;
    for (let y = 0; y < VP.height; y++) {
      if (groundHit(v, 720, y)) {
        horizon = y;
        break;
      }
    }
    expect(horizon / VP.height).toBeGreaterThan(0.08);
    expect(horizon / VP.height).toBeLessThan(0.25);
  });

  it('zooms towards the cursor: the ground under it stays put (C2)', () => {
    let p = pose({ tilt: 30 * DEG });
    const vp = { ...VP, cx: 700, cy: 430 };
    const [sx, sy] = [1000, 650];
    const g0 = groundHit(viewOf(p, vp), sx, sy)!;
    for (const z of [26, 33, 41, 52, 60]) {
      const t = zoomAt(p, vp, sx, sy, z);
      p = { ...p, ...t, zoom: z };
    }
    const s = project(viewOf(p, vp), g0.x, 0, g0.z);
    expect(Math.hypot(s.x - sx, s.y - sy)).toBeLessThan(0.01);
  });

  it('zooms at the centre when the cursor is over the sky', () => {
    const p = pose({ tilt: 10 * DEG });
    const t = zoomAt(p, VP, 720, 1, 40);
    expect(t).toEqual({ x: p.x, z: p.z });
  });

  it('reports a footprint whose corners are the screen corners on the ground', () => {
    const v = viewOf(pose(), VP);
    const fp = footprint(v, 1000);
    const corners = [
      [0, VP.height],
      [VP.width, VP.height],
      [VP.width, 0],
      [0, 0],
    ];
    fp.forEach(([x, z], i) => {
      const s = project(v, x, 0, z);
      expect(s.x).toBeCloseTo(corners[i]![0]!, 3);
      expect(s.y).toBeCloseTo(corners[i]![1]!, 3);
    });
    // At the horizon the far corners are clipped.
    const low = footprint(viewOf(pose({ tilt: 10 * DEG }), VP), 192);
    for (const [x, z] of low) expect(Math.hypot(x - 3, z + 4)).toBeLessThanOrEqual(192 + 1e-6);
  });

  it('fits points inside the free area under perspective', () => {
    const pts: [number, number, number][] = [];
    for (const x of [-48, 48]) for (const z of [-36, 36]) for (const y of [0, 3]) pts.push([x, y, z]);
    const insets = { top: 40, right: 420, bottom: 60, left: 30 };
    for (const tilt of [10, 37, 62]) {
      const f = fitPoints(pts, 45 * DEG, tilt * DEG, VP, insets);
      const v = viewOf({ ...f, az: 45 * DEG, tilt: tilt * DEG }, VP);
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        const s = project(v, ...p);
        x0 = Math.min(x0, s.x);
        x1 = Math.max(x1, s.x);
        y0 = Math.min(y0, s.y);
        y1 = Math.max(y1, s.y);
      }
      expect(x0).toBeGreaterThanOrEqual(insets.left - 2);
      expect(x1).toBeLessThanOrEqual(VP.width - insets.right + 2);
      expect(y0).toBeGreaterThanOrEqual(insets.top - 2);
      expect(y1).toBeLessThanOrEqual(VP.height - insets.bottom + 2);
      // Tight on at least one axis.
      const fill = Math.max((x1 - x0) / (VP.width - insets.left - insets.right), (y1 - y0) / (VP.height - insets.top - insets.bottom));
      expect(fill).toBeGreaterThan(0.95);
    }
  });

  it('springs, rubber-bands and wraps', () => {
    expect(rubberStep(0, 5, -10, 10)).toBe(5);
    expect(rubberStep(9, 3, -10, 10)).toBeCloseTo(10 + 2 * 0.35, 9);
    expect(rubberStep(12, 2, -10, 10)).toBeCloseTo(12.7, 9);
    expect(rubberStep(12, -2, -10, 10)).toBe(10);
    let v = 14;
    for (let i = 0; i < 120; i++) v = springInto(v, -10, 10, 0.2, 1 / 60);
    expect(v).toBeCloseTo(10, 3);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(angleDelta(170 * DEG, -170 * DEG)).toBeCloseTo(20 * DEG, 9);
  });

  it('sets quick move durations, wheel steps and clip planes per the contract', () => {
    expect(quickDuration(0)).toBe(400);
    expect(quickDuration(1000)).toBe(520);
    expect(quickDuration(9000)).toBe(700);
    expect(wheelZoomDelta(100, false)).toBeCloseTo(-0.16, 9);
    expect(wheelZoomDelta(-1000, false)).toBe(0.35);
    expect(wheelZoomDelta(10, true)).toBeCloseTo(-0.12, 9);
    expect(clipPlanes(100)).toEqual({ near: 5, far: 1000 });
    expect(clipPlanes(2).near).toBe(0.5);
  });
});
