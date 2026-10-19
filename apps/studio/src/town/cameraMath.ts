/**
 * Pure maths of the town's game camera (immersive contract §2): a perspective
 * camera with a narrow field of view orbiting a target on the ground.
 *
 * State: target (x, z) on y = 0 in scene units (one cell = one unit), `zoom` =
 * screen px per unit at the target (the canonical scale: `cam=` links and the
 * levels keep their meaning from the orthographic days), azimuth and tilt
 * (elevation) in radians. The principal point (cx, cy) is the centre of the
 * area the HUD leaves free (setViewOffset), so the target sits in the middle
 * of what the viewer can see.
 *
 * Everything here is plain numbers (no three objects), unit-tested in
 * cameraMath.test.ts; TownCamera applies the same view to a PerspectiveCamera.
 */

export const DEG = Math.PI / 180;
export const DEFAULT_AZ_DEG = 45;
export const DEFAULT_TILT_DEG = 37;
/** Hard tilt range (degrees). At 10° the horizon sits about 15% below the top edge. */
export const TILT_MIN_DEG = 10;
export const TILT_MAX_DEG = 62;
/** An open interior keeps the view at least this steep. */
export const TILT_INTERIOR_DEG = 42;
/** Flying into a building tilts to at least this. */
export const TILT_FLY_IN_DEG = 48;

/** Vertical field of view for a tilt: 20° from 30° up, widening linearly to 28° at 10° (the horizon reads wider). */
export function fovYDeg(tiltDeg: number): number {
  if (tiltDeg >= 30) return 20;
  const t = Math.min(1, Math.max(0, (30 - tiltDeg) / 20));
  return 20 + 8 * t;
}

/** Camera distance that shows `zoom` px per unit at the target on a canvas `canvasH` px tall. */
export function distanceFor(zoom: number, fovDeg: number, canvasH: number): number {
  return canvasH / (2 * zoom * Math.tan((fovDeg * DEG) / 2));
}

/** Near and far planes for a camera distance. */
export function clipPlanes(d: number): { near: number; far: number } {
  return { near: Math.min(20, Math.max(0.5, 0.05 * d)), far: d + 900 };
}

export interface CamPose {
  /** Target on the ground (scene units). */
  x: number;
  z: number;
  /** px per unit at the target. */
  zoom: number;
  /** Radians: the camera looks from (sin az, cos az) on the ground plane; π/4 = from the south-east. */
  az: number;
  /** Radians above the ground. */
  tilt: number;
}

export interface Viewport {
  width: number;
  height: number;
  /** Principal point (px): where the target appears. Defaults to the canvas centre. */
  cx?: number;
  cy?: number;
}

/** A camera basis for one frame. */
export interface View {
  pose: CamPose;
  width: number;
  height: number;
  cx: number;
  cy: number;
  fovY: number;
  /** Distance from the eye to the target. */
  d: number;
  /** px per unit of lateral offset at depth 1. */
  focal: number;
  eye: [number, number, number];
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

export function viewOf(pose: CamPose, vp: Viewport): View {
  const fovY = fovYDeg(pose.tilt / DEG);
  const d = distanceFor(pose.zoom, fovY, vp.height);
  const sa = Math.sin(pose.az);
  const ca = Math.cos(pose.az);
  const st = Math.sin(pose.tilt);
  const ct = Math.cos(pose.tilt);
  return {
    pose,
    width: vp.width,
    height: vp.height,
    cx: vp.cx ?? vp.width / 2,
    cy: vp.cy ?? vp.height / 2,
    fovY,
    d,
    focal: vp.height / 2 / Math.tan((fovY * DEG) / 2),
    eye: [pose.x + sa * ct * d, st * d, pose.z + ca * ct * d],
    fwd: [-sa * ct, -st, -ca * ct],
    right: [ca, 0, -sa],
    up: [-sa * st, ct, -ca * st],
  };
}

const dot3 = (a: readonly number[], x: number, y: number, z: number) => a[0]! * x + a[1]! * y + a[2]! * z;

/** Screen position of a world point and its depth along the view (≤ 0 = behind the camera). */
export function project(v: View, x: number, y: number, z: number): { x: number; y: number; depth: number } {
  const rx = x - v.eye[0];
  const ry = y - v.eye[1];
  const rz = z - v.eye[2];
  const depth = dot3(v.fwd, rx, ry, rz);
  const k = v.focal / Math.max(1e-6, Math.abs(depth));
  return { x: v.cx + dot3(v.right, rx, ry, rz) * k, y: v.cy - dot3(v.up, rx, ry, rz) * k, depth };
}

/** Unit ray direction through a pixel. */
export function rayDir(v: View, sx: number, sy: number): [number, number, number] {
  const a = (sx - v.cx) / v.focal;
  const b = (v.cy - sy) / v.focal;
  const x = v.fwd[0] + v.right[0] * a + v.up[0] * b;
  const y = v.fwd[1] + v.right[1] * a + v.up[1] * b;
  const z = v.fwd[2] + v.right[2] * a + v.up[2] * b;
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

/** The ground point (y = 0) under a pixel, or null when the ray misses it (sky) or lands beyond `maxDist` from the eye. */
export function groundHit(v: View, sx: number, sy: number, maxDist = Infinity): { x: number; z: number } | null {
  const r = rayDir(v, sx, sy);
  if (r[1] >= -1e-6) return null;
  const t = -v.eye[1] / r[1];
  if (t > maxDist) return null;
  return { x: v.eye[0] + r[0] * t, z: v.eye[2] + r[2] * t };
}

/**
 * The ground point under a pixel for dragging: a ray above (or nearly along)
 * the horizon is bent down to `minDown` (sin of the angle below horizontal), so
 * a drag that starts in the sky still moves the land, never by an unbounded amount.
 */
export function groundHitClamped(v: View, sx: number, sy: number, minDown = 0.06): { x: number; z: number } {
  const r = rayDir(v, sx, sy);
  let [rx, ry, rz] = r;
  if (ry > -minDown) {
    const h = Math.hypot(rx, rz) || 1;
    const c = Math.sqrt(1 - minDown * minDown);
    rx = (rx / h) * c;
    rz = (rz / h) * c;
    ry = -minDown;
  }
  const t = -v.eye[1] / ry;
  return { x: v.eye[0] + rx * t, z: v.eye[2] + rz * t };
}

/**
 * Zoom towards a pixel: the new target that keeps the ground point under
 * (sx, sy) fixed while the zoom changes to `zoom`. Orientation (and so the
 * field of view) is unchanged, so the ground point under a pixel is
 * target + d · k with k fixed: target' = target + (d − d') · k. A pixel over
 * the sky, or over ground so far away that zooming at it would fling the
 * view, zooms at the view centre instead.
 */
export function zoomAt(pose: CamPose, vp: Viewport, sx: number, sy: number, zoom: number): { x: number; z: number } {
  const v = viewOf(pose, vp);
  const g = groundHit(v, sx, sy, v.d * 4);
  if (!g) return { x: pose.x, z: pose.z };
  const kx = (g.x - pose.x) / v.d;
  const kz = (g.z - pose.z) / v.d;
  const d2 = distanceFor(zoom, v.fovY, vp.height);
  return { x: pose.x + (v.d - d2) * kx, z: pose.z + (v.d - d2) * kz };
}

/**
 * The view's footprint on the ground: the four screen corners (bottom-left,
 * bottom-right, top-right, top-left) cast onto y = 0, each clipped to
 * `clip` units from the target (a corner above the horizon lands at the clip).
 */
export function footprint(v: View, clip: number): [number, number][] {
  const corners: [number, number][] = [
    [0, v.height],
    [v.width, v.height],
    [v.width, 0],
    [0, 0],
  ];
  return corners.map(([sx, sy]) => {
    const r = rayDir(v, sx, sy);
    let x: number;
    let z: number;
    if (r[1] < -1e-6) {
      const t = -v.eye[1] / r[1];
      x = v.eye[0] + r[0] * t;
      z = v.eye[2] + r[2] * t;
    } else {
      const h = Math.hypot(r[0], r[2]) || 1;
      x = v.eye[0] + (r[0] / h) * clip * 4;
      z = v.eye[2] + (r[2] / h) * clip * 4;
    }
    const dx = x - v.pose.x;
    const dz = z - v.pose.z;
    const n = Math.hypot(dx, dz);
    if (n > clip) {
      x = v.pose.x + (dx / n) * clip;
      z = v.pose.z + (dz / n) * clip;
    }
    return [x, z];
  });
}

/** Projected height (px) of something `h` units tall at `depth` units from the eye. */
export function pxPerUnitAt(v: View, depth: number): number {
  return v.focal / Math.max(1e-6, depth);
}

export interface FitInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The target and zoom that fit a set of world points inside the canvas minus
 * `insets` for a given azimuth and tilt. Perspective makes near things larger,
 * so it iterates: project, scale the zoom by how much the points' box over- or
 * under-fills the free area, and slide the target so the box centres in it.
 */
export function fitPoints(
  points: readonly (readonly [number, number, number])[],
  az: number,
  tilt: number,
  vp: Viewport,
  insets: FitInsets,
  maxZoom = Infinity,
): { x: number; z: number; zoom: number } {
  if (points.length === 0) return { x: 0, z: 0, zoom: 10 };
  const L = insets.left;
  const R = Math.max(L + vp.width * 0.25, vp.width - insets.right);
  const T = insets.top;
  const B = Math.max(T + vp.height * 0.25, vp.height - insets.bottom);
  let x = 0;
  let z = 0;
  let span = 1;
  for (const p of points) {
    x += p[0];
    z += p[2];
  }
  x /= points.length;
  z /= points.length;
  for (const p of points) span = Math.max(span, Math.abs(p[0] - x), Math.abs(p[2] - z), p[1]);
  let zoom = Math.min(maxZoom, Math.min(R - L, B - T) / (span * 2.2));
  for (let it = 0; it < 8; it++) {
    const v = viewOf({ x, z, zoom, az, tilt }, vp);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (const p of points) {
      const s = project(v, p[0], p[1], p[2]);
      if (s.depth <= v.d * 0.05) {
        behind = true;
        break;
      }
      x0 = Math.min(x0, s.x);
      x1 = Math.max(x1, s.x);
      y0 = Math.min(y0, s.y);
      y1 = Math.max(y1, s.y);
    }
    if (behind) {
      zoom *= 0.5;
      continue;
    }
    const scale = Math.min((R - L) / Math.max(1, x1 - x0), (B - T) / Math.max(1, y1 - y0));
    // Slide the target so the box centre moves to the free area's centre (ground-anchored).
    const from = groundHitClamped(v, (x0 + x1) / 2, (y0 + y1) / 2);
    const to = groundHitClamped(v, (L + R) / 2, (T + B) / 2);
    x += from.x - to.x;
    z += from.z - to.z;
    const next = Math.min(maxZoom, zoom * Math.pow(scale, 0.9));
    const settled = Math.abs(next / zoom - 1) < 0.004 && Math.hypot(from.x - to.x, from.z - to.z) < 0.02;
    zoom = next;
    if (settled) break;
  }
  return { x, z, zoom };
}

/** Exponential approach: `current` moves towards `goal` with rate k (1/s) over dt seconds. */
export function approach(current: number, goal: number, k: number, dt: number): number {
  return current + (goal - current) * (1 - Math.exp(-k * dt));
}

/** Spring a value back into [min, max] with time constant tau (s). */
export function springInto(value: number, min: number, max: number, tau: number, dt: number): number {
  const goal = Math.min(max, Math.max(min, value));
  if (goal === value) return value;
  const next = value + (goal - value) * (1 - Math.exp(-dt / tau));
  return Math.abs(next - goal) < 1e-4 ? goal : next;
}

/**
 * A delta applied to a value with soft bounds: inside [min, max] it applies in
 * full; pushing further beyond a bound it applies at `resistance` (rubber band).
 */
export function rubberStep(value: number, delta: number, min: number, max: number, resistance = 0.35): number {
  if ((value >= max && delta > 0) || (value <= min && delta < 0)) return value + delta * resistance;
  const next = value + delta;
  if (next > max) return max + (next - max) * resistance;
  if (next < min) return min + (next - min) * resistance;
  return next;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const t = Math.atan2(Math.sin(a), Math.cos(a));
  return t === -Math.PI ? Math.PI : t;
}

/** The shortest signed turn from a to b. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Quick move duration (contract §2.3): 400 ms + 0.12 ms per px of travel, at most 700 ms. */
export function quickDuration(distancePx: number): number {
  return Math.min(700, Math.max(400, 400 + 0.12 * distancePx));
}

/** Wheel delta in px (lines ×18, pages × the canvas height). */
export function wheelPixels(deltaY: number, deltaMode: number, pageH: number): number {
  return deltaMode === 1 ? deltaY * 18 : deltaMode === 2 ? deltaY * pageH : deltaY;
}

/** Change of log(zoom) for a wheel event: plain wheel 0.0016 per px, pinch (ctrl) 0.012 per px, at most ±0.35. */
export function wheelZoomDelta(px: number, pinch: boolean): number {
  const d = -px * (pinch ? 0.012 : 0.0016);
  return Math.max(-0.35, Math.min(0.35, d));
}
