import { BufferAttribute, BufferGeometry, CanvasTexture, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three';

/** Procedural textures and geometry (no external assets). Created lazily, shared, never disposed. */

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

let chevron: CanvasTexture | null = null;
/** Chevrons pointing along +u; scroll `offset.x` to make conveyor lines flow. */
export function chevronTexture(): CanvasTexture {
  if (chevron) return chevron;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 32);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(22, 6);
  g.lineTo(40, 16);
  g.lineTo(22, 26);
  g.stroke();
  chevron = new CanvasTexture(c);
  chevron.wrapS = RepeatWrapping;
  chevron.colorSpace = SRGBColorSpace;
  return chevron;
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

let glowTex: CanvasTexture | null = null;
/** White radial falloff; tint it with a material colour for soft light pools. */
export function glowTexture(): CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTex = new CanvasTexture(c);
  return glowTex;
}
