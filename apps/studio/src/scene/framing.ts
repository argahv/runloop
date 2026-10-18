import type { CompiledWorld } from '@runloop-world/world-engine';
import { Vector3 } from 'three';
import { BACK_WALL_H, ROOM_Y, SLAB_DEPTH, SLAB_MARGIN, toScene } from './layout';

/**
 * Pure camera maths for the orthographic world camera: view directions,
 * fit-to-viewport framing, and the motion-token easing.
 */

/**
 * Iso view elevation: 30°, the 2:1 dimetric angle of isometric games. It is
 * flatter than a true isometric view (35°), so the board is wider than it is
 * tall and fills the Live World stage, which is about twice as wide as it is tall.
 */
export const ISO_ELEVATION = (28 * Math.PI) / 180;
/** View directions (from target towards the camera). Iso looks from the south-east, so north/west walls are at the back. */
export const ISO_DIR = new Vector3(1, Math.SQRT2 * Math.tan(ISO_ELEVATION), 1).normalize();
export const TOP_DIR = new Vector3(0, 1, 0.002).normalize();
export const UP = new Vector3(0, 1, 0);

/** Pixels kept clear around a set of points (from the canvas edges). Negative values let points run past an edge. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The slab may run under the stage's glass controls (they float over the
 * world by design) but never off the canvas.
 */
export const SLAB_INSETS: Insets = { top: 8, right: 12, bottom: 4, left: 12 };
/**
 * The rooms stay clear of the controls: the toolbars sit in the top corners
 * (outside the diamond), the camera rail on the right edge, the roster along
 * the bottom; the top keeps room for the northern environment's sign.
 */
export const ROOM_INSETS: Insets = { top: 8, right: 58, bottom: 46, left: 18 };
/** Seen from above the board is a rectangle whose top corners would sit under the toolbars: keep their band clear. */
export const TOP_ROOM_INSETS: Insets = { ...ROOM_INSETS, top: 46 };

/** Camera basis for a view direction: screen right and screen up in world space. */
export function viewBasis(dir: Vector3): { right: Vector3; up: Vector3 } {
  const fwd = dir.clone().negate();
  const right = new Vector3().crossVectors(fwd, UP).normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();
  return { right, up };
}

/** The base slab's corners, top and bottom. */
export function slabPoints(world: CompiledWorld): Vector3[] {
  const hx = world.width / 2 + SLAB_MARGIN;
  const hz = world.height / 2 + SLAB_MARGIN;
  const pts: Vector3[] = [];
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [-SLAB_DEPTH, 0.05]) pts.push(new Vector3(x, y, z));
  return pts;
}

/** Every room's outer corners, from its floor to the top of its back walls. */
export function roomPoints(world: CompiledWorld): Vector3[] {
  const pts: Vector3[] = [];
  for (const z of world.def.zones) {
    if (z.kind === 'hub') continue;
    const [rx, ry, rw, rh] = z.rect;
    for (const gx of [rx - 0.5, rx + rw - 0.5])
      for (const gy of [ry - 0.5, ry + rh - 0.5])
        for (const y of [ROOM_Y, ROOM_Y + BACK_WALL_H]) pts.push(new Vector3(...toScene(world, gx, gy, y)));
  }
  return pts;
}

/** Everything the overview must show: the slab and the rooms. */
export function boardPoints(world: CompiledWorld): Vector3[] {
  return [...slabPoints(world), ...roomPoints(world)];
}

export interface Framing {
  zoom: number;
  target: Vector3;
}

/** Points that must stay at least `insets` away from the canvas edges. */
export interface FrameGroup {
  points: readonly Vector3[];
  insets: Insets;
}

/**
 * One screen axis: the largest zoom at which every group fits its own
 * margins, and the camera offset (along the axis) that centres the groups in
 * what is left. Screen position = size/2 + (p - t) * zoom; `lo`/`hi` are the
 * margins at the low and high end of the axis.
 */
function fitAxis(groups: { min: number; max: number; lo: number; hi: number }[], size: number): { zoom: number; at: (zoom: number) => number } {
  let zoom = Infinity;
  for (const g of groups) {
    for (const h of groups) {
      const span = g.max - h.min;
      if (span <= 1e-6) continue;
      // Never let margins eat the whole canvas (tiny panels still show something).
      zoom = Math.min(zoom, Math.max(size * 0.4, size - g.hi - h.lo) / span);
    }
  }
  const at = (z: number) => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const g of groups) {
      lo = Math.max(lo, g.max - (size / 2 - g.hi) / z);
      hi = Math.min(hi, g.min + (size / 2 - g.lo) / z);
    }
    return (lo + hi) / 2;
  };
  return { zoom, at };
}

/**
 * Zoom and target that keep every group inside the canvas minus its own
 * insets, as large as possible, for an orthographic camera looking along
 * -dir. Works at any aspect ratio; the binding axis decides the zoom.
 */
export function frameGroups(groups: readonly FrameGroup[], dir: Vector3, width: number, height: number): Framing {
  const { right, up } = viewBasis(dir);
  const xs = [];
  const ys = [];
  for (const g of groups) {
    if (g.points.length === 0) continue;
    const r = g.points.map((p) => p.dot(right));
    const u = g.points.map((p) => p.dot(up));
    xs.push({ min: Math.min(...r), max: Math.max(...r), lo: g.insets.left, hi: g.insets.right });
    // Screen y points down: the top inset limits the highest point.
    ys.push({ min: Math.min(...u), max: Math.max(...u), lo: g.insets.bottom, hi: g.insets.top });
  }
  const fx = fitAxis(xs, width);
  const fy = fitAxis(ys, height);
  const zoom = Math.max(1, Math.min(fx.zoom, fy.zoom, 1e6));
  return { zoom, target: right.multiplyScalar(fx.at(zoom)).add(up.multiplyScalar(fy.at(zoom))) };
}

/** Fit a single set of points inside the canvas minus `insets`. */
export function frameBounds(points: readonly Vector3[], dir: Vector3, width: number, height: number, insets: Insets): Framing {
  return frameGroups([{ points, insets }], dir, width, height);
}

/** Room insets for a view direction (the top-down view needs the toolbar band). */
export function roomInsets(dir: Vector3): Insets {
  return dir.y > 0.95 ? TOP_ROOM_INSETS : ROOM_INSETS;
}

/** The overview: the whole slab on the canvas, the rooms clear of the floating controls. */
export function frameBoard(world: CompiledWorld, dir: Vector3, width: number, height: number): Framing {
  return frameGroups(
    [
      { points: slabPoints(world), insets: SLAB_INSETS },
      { points: roomPoints(world), insets: roomInsets(dir) },
    ],
    dir,
    width,
    height,
  );
}

/** Screen position (px from the canvas top-left) of a world point for a camera at `target`/`zoom`. */
export function projectToScreen(p: Vector3, dir: Vector3, target: Vector3, zoom: number, width: number, height: number): { x: number; y: number } {
  const { right, up } = viewBasis(dir);
  const d = p.clone().sub(target);
  return { x: width / 2 + d.dot(right) * zoom, y: height / 2 - d.dot(up) * zoom };
}

/**
 * CSS cubic-bezier(x1, y1, x2, y2) as a function of progress t ∈ [0, 1]
 * (the motion tokens' easing curves). Newton iterations with a bisection fallback.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sy = (s: number) => ((ay * s + by) * s + cy) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = sx(s) - t;
      if (Math.abs(err) < 1e-5) return sy(s);
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 30; i++) {
      const v = sx(s);
      if (Math.abs(v - t) < 1e-5) break;
      if (v < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return sy(s);
  };
}

/** --rl-ease-out (cubic-bezier(0.2, 0.8, 0.2, 1)). */
export const easeOut = cubicBezier(0.2, 0.8, 0.2, 1);

/** Parse a CSS duration token ("550ms", "0.4s", "0ms"); falls back when missing or invalid. */
export function parseDurationMs(value: string | null | undefined, fallback: number): number {
  const v = (value ?? '').trim();
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(v);
  if (!m) return fallback;
  const n = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
