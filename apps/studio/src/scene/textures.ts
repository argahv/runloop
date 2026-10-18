import { BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Float32BufferAttribute, Vector3 } from 'three';

/** Procedural textures and geometry (no external assets). Created lazily, shared, never disposed. */

/**
 * A unit box (centred, 1 × 1 × 1) whose vertex colour fades from `foot` at
 * the bottom to 1 at the top: cheap contact shading where walls and the slab
 * meet the floor (use with `vertexColors`; instance colours multiply it).
 */
export function footShadedBox(foot: number): BufferGeometry {
  const g = new BoxGeometry(1, 1, 1);
  const pos = g.getAttribute('position');
  const col: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = pos.getY(i) < 0 ? foot : 1;
    col.push(k, k, k);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

let boardShadow: CanvasTexture | null = null;
/** A soft rounded-square shadow the board casts on the stage below it. */
export function boardShadowTexture(): CanvasTexture {
  if (boardShadow) return boardShadow;
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Distance outside an inner square, normalised: 0 inside, 1 at the edge of the texture.
      const dx = Math.max(0, Math.abs((x + 0.5) / n - 0.5) * 2 - 0.62) / 0.38;
      const dy = Math.max(0, Math.abs((y + 0.5) / n - 0.5) * 2 - 0.62) / 0.38;
      const d = Math.min(1, Math.hypot(dx, dy));
      img.data[(y * n + x) * 4 + 3] = Math.round(Math.pow(1 - d, 2.2) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  boardShadow = new CanvasTexture(c);
  return boardShadow;
}

let blob: CanvasTexture | null = null;
/** Soft radial shadow used under characters and machines instead of shadow maps. */
export function blobShadowTexture(): CanvasTexture {
  if (blob) return blob;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blob = new CanvasTexture(c);
  return blob;
}

/**
 * A flat ribbon along a polyline (axis-aligned segments plus vertical risers),
 * with u = distance along the line × uPerUnit. `extend` overlaps horizontal
 * segments by half the width so opaque ribbons have filled corners.
 */
export function ribbonGeometry(
  points: readonly (readonly [number, number, number])[],
  width: number,
  opts: { uPerUnit?: number; extend?: boolean } = {},
): BufferGeometry {
  const uPerUnit = opts.uPerUnit ?? 1;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const half = width / 2;
  let perp = new Vector3(1, 0, 0);
  let cum = 0;
  // Initial perpendicular from the first horizontal segment.
  for (let i = 0; i + 1 < points.length; i++) {
    const d = new Vector3(points[i + 1]![0] - points[i]![0], 0, points[i + 1]![2] - points[i]![2]);
    if (d.lengthSq() > 1e-9) {
      d.normalize();
      perp = new Vector3(-d.z, 0, d.x);
      break;
    }
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const a = new Vector3(...points[i]!);
    const b = new Vector3(...points[i + 1]!);
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-9) continue;
    const horizontal = Math.abs(d.y) < 1e-9;
    const dir = d.clone().divideScalar(len);
    if (horizontal) perp = new Vector3(-dir.z, 0, dir.x);
    const ext = opts.extend && horizontal ? half : 0;
    const a2 = a.clone().addScaledVector(dir, -ext);
    const b2 = b.clone().addScaledVector(dir, ext);
    const base = pos.length / 3;
    for (const p of [a2.clone().addScaledVector(perp, half), a2.clone().addScaledVector(perp, -half), b2.clone().addScaledVector(perp, half), b2.clone().addScaledVector(perp, -half)]) {
      pos.push(p.x, p.y, p.z);
    }
    const u0 = cum * uPerUnit;
    const u1 = (cum + len) * uPerUnit;
    uv.push(u0, 1, u0, 0, u1, 1, u1, 0);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    cum += len;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Total length of a polyline. */
export function polylineLength(points: readonly (readonly [number, number, number])[]): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

/** Point at distance `s` along a polyline (clamped), written into `out`. */
export function pointAlong(points: readonly (readonly [number, number, number])[], s: number, out: Vector3): Vector3 {
  if (points.length === 0) return out.set(0, 0, 0);
  let left = Math.max(0, s);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (left <= len && len > 0) {
      const t = left / len;
      return out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    }
    left -= len;
  }
  const last = points[points.length - 1]!;
  return out.set(last[0], last[1], last[2]);
}
