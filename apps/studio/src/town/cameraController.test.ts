import { describe, expect, it } from 'vitest';
import { CameraController } from './cameraController';
import { DEG, groundHit, project, viewOf } from './cameraMath';

function make(reduced = false) {
  const events: string[] = [];
  const c = new CameraController({
    onUserInput: () => events.push('input'),
    onInteraction: (a) => events.push(a ? 'start' : 'end'),
    onFly: () => events.push('fly'),
  });
  c.width = 1440;
  c.height = 900;
  c.zoomMin = 6;
  c.zoomMax = 120;
  c.reducedMotion = reduced;
  c.cut({ x: 0, z: 0, zoom: 20, az: 45 * DEG, tilt: 37 * DEG });
  return { c, events };
}

/** Run the controller for `ms` at 60 fps from `t0`; returns the end time. */
function run(c: CameraController, t0: number, ms: number, follow: { x: number; z: number } | null = null): number {
  let t = t0;
  for (; t < t0 + ms; t += 16) c.update(0.016, t, follow);
  return t;
}

/** A drag from (x0, y0) by (dx, dy) over `ms`, released at the end (left button = pan, right = rotate). */
function drag(c: CameraController, t0: number, x0: number, y0: number, dx: number, dy: number, ms: number, button = 0): number {
  c.pointerDown(1, x0, y0, button, false, t0);
  const steps = Math.max(2, Math.round(ms / 16));
  let t = t0;
  for (let i = 1; i <= steps; i++) {
    t = t0 + i * 16;
    c.pointerMove(1, x0 + (dx * i) / steps, y0 + (dy * i) / steps, t);
    c.update(0.016, t, null);
  }
  c.pointerUp(1, t + 1);
  return t + 1;
}

describe('the game camera controller (immersive contract §2.2)', () => {
  it('pans ground-anchored: the grabbed ground point stays under the pointer', () => {
    const { c, events } = make();
    const g0 = groundHit(c.view, 500, 600)!;
    c.pointerDown(1, 500, 600, 0, false, 0);
    c.pointerMove(1, 540, 610, 16);
    c.pointerMove(1, 700, 500, 32);
    const s = project(c.view, g0.x, 0, g0.z);
    expect(Math.hypot(s.x - 700, s.y - 500)).toBeLessThan(0.5);
    expect(events).toContain('start');
    expect(c.consumed).toBe(true);
  });

  it('keeps moving after a flick and stops within a second (C3)', () => {
    const { c } = make();
    const t = drag(c, 0, 400, 450, 300, 0, 80);
    const at = { x: c.pose.x, z: c.pose.z };
    const t2 = run(c, t, 150);
    expect(Math.hypot(c.pose.x - at.x, c.pose.z - at.z)).toBeGreaterThan(0.5);
    run(c, t2, 1000);
    const still = { x: c.pose.x, z: c.pose.z };
    run(c, t2 + 1000, 200);
    expect(Math.hypot(c.pose.x - still.x, c.pose.z - still.z)).toBeLessThan(1e-6);
  });

  it('has no momentum under reduced motion', () => {
    const { c } = make(true);
    const t = drag(c, 0, 400, 450, 300, 0, 80);
    const at = { x: c.pose.x, z: c.pose.z };
    run(c, t, 200);
    expect(Math.hypot(c.pose.x - at.x, c.pose.z - at.z)).toBeLessThan(1e-6);
  });

  it('turns 45° on Q and E, and tilts within [10°, 62°] on Z and X (C4)', () => {
    const { c } = make();
    c.keyDown('KeyE', false, false, 0);
    c.keyUp('KeyE', false);
    run(c, 0, 400);
    expect(c.pose.az / DEG).toBeCloseTo(90, 3);
    c.keyDown('KeyQ', false, false, 500);
    c.keyUp('KeyQ', false);
    run(c, 500, 400);
    expect(c.pose.az / DEG).toBeCloseTo(45, 3);
    c.keyDown('KeyZ', false, false, 1000);
    run(c, 1000, 3000);
    expect(c.pose.tilt / DEG).toBeCloseTo(10, 6);
    c.keyUp('KeyZ', false);
    c.keyDown('KeyX', false, false, 5000);
    run(c, 5000, 4000);
    expect(c.pose.tilt / DEG).toBeCloseTo(62, 6);
  });

  it('rotates freely with a right drag', () => {
    const { c } = make();
    drag(c, 0, 700, 450, -100, 0, 160, 2);
    expect(c.pose.az / DEG).toBeCloseTo(45 + 30, 1);
  });

  it('springs back inside the soft bounds after a drag past them', () => {
    const { c } = make();
    c.cut({ x: 60, z: 0 });
    // Drag the view east, well past the bound (68 cells).
    const t = drag(c, 0, 1200, 450, -1100, 0, 400);
    expect(c.pose.x).toBeGreaterThan(c.boundX);
    run(c, t, 2500);
    expect(c.pose.x).toBeLessThanOrEqual(c.boundX + 1e-3);
  });

  it('zooms at the cursor with the wheel, easing, and springs back inside the zoom range', () => {
    const { c } = make();
    const [sx, sy] = [1000, 650];
    const g0 = groundHit(c.view, sx, sy)!;
    let t = 0;
    for (let i = 0; i < 5; i++) {
      c.wheelInput(-120, sx, sy, { ctrl: false, shift: false }, t);
      t = run(c, t, 80);
    }
    t = run(c, t, 600);
    const s = project(c.view, g0.x, 0, g0.z);
    expect(Math.hypot(s.x - sx, s.y - sy)).toBeLessThan(3);
    expect(c.pose.zoom).toBeGreaterThan(20);
    for (let i = 0; i < 30; i++) c.wheelInput(-400, sx, sy, { ctrl: false, shift: false }, t);
    t = run(c, t, 2000);
    expect(c.pose.zoom).toBeLessThanOrEqual(c.zoomMax * 1.0001);
  });

  it('moves quickly or cuts, and any input interrupts a move', () => {
    const { c, events } = make();
    c.moveTo({ x: 30, z: 10 }, 'quick', 0);
    expect(events).toContain('fly');
    run(c, 0, 200);
    expect(c.tweening).toBe(true);
    c.wheelInput(-50, 700, 450, { ctrl: false, shift: false }, 210);
    expect(c.tweening).toBe(false);
    const { c: r } = make(true);
    r.moveTo({ x: 30, z: 10 }, 'quick', 0);
    expect(r.pose.x).toBe(30);
  });

  it('follows a point and reports viewer input (which breaks a follow)', () => {
    const { c, events } = make();
    run(c, 0, 1500, { x: 10, z: -5 });
    expect(Math.hypot(c.pose.x - 10, c.pose.z + 5)).toBeLessThan(0.05);
    c.keyDown('KeyW', false, false, 2000);
    expect(events).toContain('input');
  });

  it('pans with the keys relative to the screen', () => {
    const { c } = make();
    const v0 = viewOf(c.pose, { width: 1440, height: 900 });
    c.keyDown('KeyD', false, false, 0);
    run(c, 0, 1000);
    c.keyUp('KeyD', false);
    // Screen right is (cos az, −sin az) on the ground.
    const dx = c.pose.x;
    const dz = c.pose.z;
    expect(dx * v0.right[0] + dz * v0.right[2]).toBeGreaterThan(20);
  });
});
