import type { CompiledWorld } from '@runloop-world/world-engine';
import { Vector3 } from 'three';

/**
 * Pure camera maths for the orthographic world camera: view directions,
 * fit-to-viewport framing with insets, and the motion-token easing.
 */

/** View directions (from target towards the camera). Iso looks from the south-east, so north/west walls are at the back. */
export const ISO_DIR = new Vector3(1, 1.2, 1).normalize();
export const TOP_DIR = new Vector3(0, 1, 0.002).normalize();
export const UP = new Vector3(0, 1, 0);

/** Pixels kept clear around the board: floating controls sit on top and bottom, labels rise above. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Room for the stage's glass controls (top), the roster (bottom) and the camera rail (right). */
export const DEFAULT_INSETS: Insets = { top: 46, right: 58, bottom: 50, left: 24 };

/** Camera basis for a view direction: screen right and screen up in world space. */
export function viewBasis(dir: Vector3): { right: Vector3; up: Vector3 } {
  const fwd = dir.clone().negate();
  const right = new Vector3().crossVectors(fwd, UP).normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();
  return { right, up };
}

/** The 3D points that must stay in view: the base slab corners, from under the slab to the top of walls and robots. */
export function boardPoints(world: CompiledWorld): Vector3[] {
  const hx = world.width / 2 + 0.8;
  const hz = world.height / 2 + 0.8;
  const pts: Vector3[] = [];
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [-0.7, 2.3]) pts.push(new Vector3(x, y, z));
  return pts;
}

export interface Framing {
  zoom: number;
  target: Vector3;
}

/**
 * Zoom and target that show every point inside the canvas minus `insets`,
 * centred in that free area, for an orthographic camera looking along -dir.
 * Works at any aspect ratio; the binding axis decides the zoom.
 */
export function frameBounds(points: readonly Vector3[], dir: Vector3, width: number, height: number, insets: Insets = DEFAULT_INSETS): Framing {
  const { right, up } = viewBasis(dir);
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const p of points) {
    const r = p.dot(right);
    const u = p.dot(up);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
  }
  // Never let insets eat the whole canvas (tiny panels still show something).
  const availW = Math.max(width * 0.4, width - insets.left - insets.right);
  const availH = Math.max(height * 0.4, height - insets.top - insets.bottom);
  const zoom = Math.max(1, Math.min(availW / Math.max(1e-6, r1 - r0), availH / Math.max(1e-6, u1 - u0)));
  // Shift so the bounds' centre lands in the middle of the free area (screen y points down).
  const offX = (insets.left - insets.right) / 2;
  const offY = (insets.top - insets.bottom) / 2;
  const tr = (r0 + r1) / 2 - offX / zoom;
  const tu = (u0 + u1) / 2 + offY / zoom;
  return { zoom, target: right.multiplyScalar(tr).add(up.multiplyScalar(tu)) };
}

/** Fit the whole board. */
export function frameBoard(world: CompiledWorld, dir: Vector3, width: number, height: number, insets: Insets = DEFAULT_INSETS): Framing {
  return frameBounds(boardPoints(world), dir, width, height, insets);
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
