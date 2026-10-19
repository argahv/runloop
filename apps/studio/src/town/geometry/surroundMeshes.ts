/**
 * Meshes for the land beyond the town (layout in surroundings.ts): the terrain
 * disc, roads out with lamps and bridges, fields, farmsteads and the windmill,
 * the Brook and the lake, far mountains, and the instanced pieces (trees,
 * cars, birds, clouds). Built once per town; static apart from uniforms and
 * the few instanced matrices AmbientLife moves.
 */
import { BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { mixHex, scaleHex } from '../color';
import { DECO_COLORS as D, GROUND_COLORS as G } from '../townPalette';
import { GLOW_KIND, GeoBuilder } from './builder';
import {
  LAND_RADIUS,
  LAND_Y,
  hash2,
  hillWeight,
  riverZ,
  smoothstep,
  terrainHeight,
  vnoise,
  type Pt,
  type SurroundLayout,
} from './surroundings';

/** Countryside colours (kept apart from the Signature lime; palette test). */
export const LAND_COLORS = {
  meadowA: '#a0bd83',
  meadowB: '#93b478',
  outskirts: '#a7c08b',
  forestFloor: '#7f9b67',
  hillTop: '#a9b885',
  bank: '#bdb48f',
  lane: '#b8a37f',
  track: '#c2ae8a',
  bridgeStone: '#c9bea7',
  bridgeRail: '#8f8676',
  farmWall: '#efe2c8',
  farmRoof: '#b5654a',
  barnWall: '#a4553f',
  barnRoof: '#7d7f86',
  barnDoor: '#6e3b2c',
  farmWindow: '#4a5563',
  silo: '#d8d4cc',
  siloCap: '#8d949c',
  hay: '#d3c9a4',
  millTower: '#efe6d8',
  millCap: '#7a5a42',
  millSail: '#f4eee2',
  mountainLow: '#6c7b8e',
  mountainHigh: '#9aa8b8',
  snow: '#e8edf2',
  cloud: '#ffffff',
  bird: '#2c3038',
} as const;

/** Field tones: stubble, young green, deep green, ploughed, wheat, meadow hay. */
export const FIELD_TONES = ['#cdbb8c', '#b0c789', '#8fae6e', '#a88a66', '#d9c88c', '#a9b77a'] as const;
/** Tree crowns: forest pine, dark pine, broadleaf, orchard. */
export const TREE_TONES = ['#5e8f5c', '#4d7d54', '#6f9e5a', '#7aa862'] as const;
/** Cars: muted paints (never lime, never a semantic colour). */
export const CAR_COLORS = ['#e8e4dc', '#5d6b7d', '#9a4b45', '#3f5f7a', '#b7ad98', '#7c8a6e', '#d9d4ca', '#4b4f58'] as const;

const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

// ── Terrain ───────────────────────────────────────────────────────────────

/** The land disc: rings from just under the town's grass margin out to LAND_RADIUS, denser near the town. */
export function buildTerrain(L: SurroundLayout, lite: boolean): BufferGeometry {
  const segs = lite ? 88 : 112;
  const rings = lite ? 40 : 52;
  const ix = L.hx - 1;
  const iz = L.hz - 1;
  // Angles: uniform, plus the inner rectangle's corners exactly.
  const angles: number[] = [];
  for (let i = 0; i < segs; i++) angles.push((i / segs) * Math.PI * 2 - Math.PI);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) angles.push(Math.atan2(sz * iz, sx * ix));
  angles.sort((a, b) => a - b);
  const n = angles.length;
  const pos = new Float32Array(n * (rings + 1) * 3);
  const col = new Float32Array(n * (rings + 1) * 3);
  const c = new Color();
  let k = 0;
  for (let r = 0; r <= rings; r++) {
    for (const a of angles) {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const t0 = Math.min(ix / Math.max(1e-6, Math.abs(ca)), iz / Math.max(1e-6, Math.abs(sa)));
      const off = (LAND_RADIUS - t0) * Math.pow(r / rings, 1.8);
      const x = ca * (t0 + off);
      const z = sa * (t0 + off);
      const y = r === 0 ? LAND_Y - 0.006 : terrainHeight(L, x, z);
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      c.set(landColor(L, x, z, y));
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
      k++;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      const d = (r + 1) * n + i;
      const e = (r + 1) * n + ((i + 1) % n);
      // Counter-clockwise seen from above (the land faces up).
      index.push(a, b, d, b, e, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** The land's colour at a point: mown outskirts, meadows, forest floor on the hills, sandy banks by the water, far patchwork. */
export function landColor(L: SurroundLayout, x: number, z: number, y: number): string {
  const r = Math.hypot(Math.max(0, Math.abs(x) - L.hx), Math.max(0, Math.abs(z) - L.hz));
  const n = vnoise(x / 38, z / 38, 9);
  let c = mixHex(LAND_COLORS.meadowA, LAND_COLORS.meadowB, n);
  c = mixHex(LAND_COLORS.outskirts, c, smoothstep(8, 30, r));
  // Far farmland: a coarse patchwork past the drawn fields.
  if (r > 90) {
    const fx = Math.floor((x + 1000) / 26);
    const fz = Math.floor((z + 1000) / 19);
    const tone = FIELD_TONES[Math.floor(hash2(fx, fz, 71) * FIELD_TONES.length)]!;
    c = mixHex(c, tone, 0.45 * smoothstep(90, 140, r) * (1 - hillWeight(x, z)));
  }
  const w = hillWeight(x, z) * smoothstep(25, 70, r);
  c = mixHex(c, LAND_COLORS.forestFloor, 0.75 * w);
  c = mixHex(c, LAND_COLORS.hillTop, Math.min(0.5, Math.max(0, (y - 8) / 30)));
  // Sandy banks along the Brook and around the lake.
  if (x > L.river.x0 - 4) c = mixHex(c, LAND_COLORS.bank, 1 - smoothstep(L.river.half + 0.5, L.river.half + 3.5, Math.abs(z - riverZ(L.hz, x))));
  const e = Math.hypot((x - L.lake.cx) / L.lake.rx, (z - L.lake.cz) / L.lake.rz);
  c = mixHex(c, LAND_COLORS.bank, 1 - smoothstep(1.0, 1.14, e));
  return scaleHex(c, 0.97 + 0.06 * vnoise(x / 9, z / 9, 13));
}

// ── Roads, lamps, bridges, tracks ─────────────────────────────────────────

/** Height of a road's surface at a point (just above the land; arched over a bridge). */
export function roadY(L: SurroundLayout, x: number, z: number): number {
  let y = terrainHeight(L, x, z) + 0.012 + 0.00015 * Math.hypot(x, z);
  for (const b of L.bridges) {
    const along = b.alongZ ? z - b.z : x - b.x;
    const across = b.alongZ ? x - b.x : z - b.z;
    if (Math.abs(across) < 3 && Math.abs(along) < b.length / 2 + 4) y = Math.max(y, LAND_Y + 0.012 + 0.75 * Math.pow(Math.cos((Math.PI * Math.min(1, Math.abs(along) / (b.length / 2 + 4))) / 2), 2));
  }
  return y;
}

/** A ribbon along a polyline, `width` wide, `lift` above the road surface. */
function ribbon(gb: GeoBuilder, L: SurroundLayout, pts: readonly Pt[], width: number, color: string, lift = 0): void {
  const h = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    const ya = roadY(L, a.x, a.z) + lift;
    const yb = roadY(L, b.x, b.z) + lift;
    gb.quad(v3(a.x + nx * h, ya, a.z + nz * h), v3(b.x + nx * h, yb, b.z + nz * h), v3(b.x - nx * h, yb, b.z - nz * h), v3(a.x - nx * h, ya, a.z - nz * h), color);
  }
}

/** Fine points along a polyline every `step` units. */
function along(pts: readonly Pt[], step: number): { p: Pt; dx: number; dz: number; d: number }[] {
  const out: { p: Pt; dx: number; dz: number; d: number }[] = [];
  let acc = 0;
  let next = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    while (next <= acc + len) {
      const t = (next - acc) / len;
      out.push({ p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len, d: next });
      next += step;
    }
    acc += len;
  }
  return out;
}

export function buildRoadsOut(L: SurroundLayout): GeoBuilder {
  const gb = new GeoBuilder();
  for (const r of L.roads) {
    const near = r.pts.filter((p) => Math.hypot(p.x, p.z) < LAND_RADIUS - 40);
    if (r.kind === 'road') {
      ribbon(gb, L, near, r.width + 0.5, scaleHex(G.curb, 0.92), -0.004);
      ribbon(gb, L, near, r.width, G.asphalt);
      // Dashed centre line near the town (it fades into the haze further out anyway).
      for (const s of along(near, 3)) {
        if (s.d > 260) break;
        const y = roadY(L, s.p.x, s.p.z) + 0.004;
        const hx = s.dx * 0.6;
        const hz = s.dz * 0.6;
        const wx = -s.dz * 0.035;
        const wz = s.dx * 0.035;
        gb.quad(v3(s.p.x - hx + wx, y, s.p.z - hz + wz), v3(s.p.x + hx + wx, y, s.p.z + hz + wz), v3(s.p.x + hx - wx, y, s.p.z + hz - wz), v3(s.p.x - hx - wx, y, s.p.z - hz - wz), G.laneMark);
      }
      // Street lamps, alternating sides (lit at night by the town's clock, like the town's own).
      let side = 1;
      for (const s of along(near, 14)) {
        if (s.d < 6) continue;
        if (s.d > r.lampsTo) break;
        const x = s.p.x - s.dz * 1.7 * side;
        const z = s.p.z + s.dx * 1.7 * side;
        const y = terrainHeight(L, x, z);
        gb.cylinder(x, y, z, 0.05, 1.7, D.lampPost, 5);
        gb.box(x, y + 1.62, z, 0.2, 0.16, 0.2, D.lampHead, { glow: GLOW_KIND.lamp });
        side = -side;
      }
    } else ribbon(gb, L, near, r.width, LAND_COLORS.lane);
  }
  // Farm tracks to the nearest road.
  for (const f of L.farms) {
    let best: Pt | null = null;
    let bd = Infinity;
    for (const r of L.roads) for (const p of r.pts) {
      const d = Math.hypot(p.x - f.x, p.z - f.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best && bd < 80) ribbon(gb, L, densify2({ x: f.x, z: f.z }, best, 4), 1.2, LAND_COLORS.track, -0.002);
  }
  // Bridges: railings along the arched deck and stone piers in the water.
  for (const b of L.bridges) {
    const n = 12;
    for (const s of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const t0 = -b.length / 2 - 3 + ((b.length + 6) * i) / n;
        const t1 = t0 + (b.length + 6) / n;
        const pa = b.alongZ ? { x: b.x + s * 1.35, z: b.z + t0 } : { x: b.x + t0, z: b.z + s * 1.35 };
        const pb = b.alongZ ? { x: b.x + s * 1.35, z: b.z + t1 } : { x: b.x + t1, z: b.z + s * 1.35 };
        const ya = roadY(L, b.alongZ ? b.x : pa.x, b.alongZ ? pa.z : b.z);
        const yb = roadY(L, b.alongZ ? b.x : pb.x, b.alongZ ? pb.z : b.z);
        const mx = (pa.x + pb.x) / 2;
        const mz = (pa.z + pb.z) / 2;
        const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        gb.box(mx, (ya + yb) / 2 + 0.28, mz, b.alongZ ? 0.12 : len, 0.1, b.alongZ ? len : 0.12, LAND_COLORS.bridgeRail);
        gb.box(pa.x, ya, pa.z, 0.12, 0.34, 0.12, LAND_COLORS.bridgeRail);
      }
      // The deck's sides (stone).
      ribbonEdge(gb, L, b, s);
    }
    for (const t of [-b.length / 4, b.length / 4]) {
      const x = b.alongZ ? b.x : b.x + t;
      const z = b.alongZ ? b.z + t : b.z;
      gb.box(x, LAND_Y - 0.2, z, b.alongZ ? 2.4 : 0.9, roadY(L, x, z) - LAND_Y + 0.15, b.alongZ ? 0.9 : 2.4, LAND_COLORS.bridgeStone);
    }
  }
  return gb;
}

function ribbonEdge(gb: GeoBuilder, L: SurroundLayout, b: SurroundLayout['bridges'][number], s: number): void {
  const n = 16;
  for (let i = 0; i < n; i++) {
    const t0 = -b.length / 2 - 4 + ((b.length + 8) * i) / n;
    const t1 = t0 + (b.length + 8) / n;
    const at = (t: number) => (b.alongZ ? { x: b.x + s * 1.3, z: b.z + t } : { x: b.x + t, z: b.z + s * 1.3 });
    const a = at(t0);
    const c = at(t1);
    const ya = roadY(L, b.alongZ ? b.x : a.x, b.alongZ ? a.z : b.z);
    const yc = roadY(L, b.alongZ ? b.x : c.x, b.alongZ ? c.z : b.z);
    gb.quad(v3(a.x, LAND_Y - 0.05, a.z), v3(c.x, LAND_Y - 0.05, c.z), v3(c.x, yc, c.z), v3(a.x, ya, a.z), LAND_COLORS.bridgeStone);
    gb.quad(v3(c.x, LAND_Y - 0.05, c.z), v3(a.x, LAND_Y - 0.05, a.z), v3(a.x, ya, a.z), v3(c.x, yc, c.z), LAND_COLORS.bridgeStone);
  }
}

function densify2(a: Pt, b: Pt, step: number): Pt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }));
}

// ── Fields ────────────────────────────────────────────────────────────────

export function buildFields(L: SurroundLayout): GeoBuilder {
  const gb = new GeoBuilder();
  const y = LAND_Y + 0.02;
  const bushTones = [D.bush, D.bushDark, scaleHex(D.leafC, 0.95)];
  for (const b of L.bushes) gb.cylinder(b.x, LAND_Y, b.z, b.s * 1.05, b.s * 0.85, bushTones[b.tone % 3]!, 5, 0.45, {}, b.s * 9);
  for (const f of L.fields) {
    const cs = Math.cos(f.yaw);
    const sn = Math.sin(f.yaw);
    const at = (u: number, w: number, yy = y) => v3(f.cx + u * cs - w * sn, yy, f.cz + u * sn + w * cs);
    const tone = f.orchard ? mixHex(LAND_COLORS.meadowA, '#b9c48f', 0.5) : FIELD_TONES[f.tone]!;
    const rows = f.orchard ? 1 : Math.max(4, Math.round(f.d / 1.3));
    for (let i = 0; i < rows; i++) {
      const w0 = -f.d / 2 + (f.d * i) / rows;
      const w1 = w0 + f.d / rows;
      const c = i % 2 ? scaleHex(tone, 0.93) : tone;
      gb.quad(at(-f.w / 2, w1), at(f.w / 2, w1), at(f.w / 2, w0), at(-f.w / 2, w0), c);
    }
    // A low hedge on two sides.
    const hedge = scaleHex(D.bush, 0.95);
    const hh = 0.42;
    for (const [u0, w0, u1, w1] of [
      [-f.w / 2 - 0.5, -f.d / 2 - 0.5, f.w / 2 + 0.5, -f.d / 2 - 0.5],
      [-f.w / 2 - 0.5, -f.d / 2 - 0.5, -f.w / 2 - 0.5, f.d / 2 + 0.5],
    ] as const) {
      const a = at(u0, w0);
      const b = at(u1, w1);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      gb.box(mx, LAND_Y, mz, len, hh, 0.5, hedge, {}, Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2);
    }
  }
  return gb;
}

// ── Farmsteads and the windmill ───────────────────────────────────────────

export interface MillHub {
  x: number;
  y: number;
  z: number;
  /** Direction the sails face (yaw). */
  yaw: number;
}

export function buildFarms(L: SurroundLayout): { gb: GeoBuilder; mill: MillHub | null } {
  const gb = new GeoBuilder();
  let mill: MillHub | null = null;
  const dark = { glow: GLOW_KIND.none };
  for (const f of L.farms) {
    const cs = Math.cos(f.yaw);
    const sn = Math.sin(f.yaw);
    const P = (u: number, w: number) => ({ x: f.x + u * cs - w * sn, z: f.z + u * sn + w * cs });
    const y = terrainHeight(L, f.x, f.z);
    // Farmhouse: cream walls, terracotta gable, dark windows (never lit: nobody is simulated out here).
    const h = P(-4, 0);
    gb.box(h.x, y, h.z, 5, 2.6, 4, LAND_COLORS.farmWall, dark, -f.yaw);
    gb.gable(h.x, y + 2.6, h.z, 5.6, 4.6, 1.7, LAND_COLORS.farmRoof, LAND_COLORS.farmWall, Math.abs(cs) > Math.abs(sn), dark);
    for (const k of [-1.4, 1.4]) {
      const wp = P(-4 + k, 2.03);
      gb.box(wp.x, y + 1.2, wp.z, 0.7, 0.75, 0.06, LAND_COLORS.farmWindow, dark, -f.yaw);
    }
    const door = P(-4, 2.03);
    gb.box(door.x, y, door.z, 0.7, 1.4, 0.06, LAND_COLORS.barnDoor, dark, -f.yaw);
    const chim = P(-5.6, -0.8);
    gb.box(chim.x, y + 3, chim.z, 0.5, 1.6, 0.5, D.flowerRed, dark, -f.yaw);
    // Barn.
    const b = P(4.5, -1);
    gb.box(b.x, y, b.z, 6, 3.4, 8, LAND_COLORS.barnWall, dark, -f.yaw);
    gb.gable(b.x, y + 3.4, b.z, 6.6, 8.6, 2.2, LAND_COLORS.barnRoof, LAND_COLORS.barnWall, Math.abs(sn) > Math.abs(cs), dark);
    const bd = P(4.5, 3.03);
    gb.box(bd.x, y, bd.z, 2.6, 2.6, 0.06, LAND_COLORS.barnDoor, dark, -f.yaw);
    if (f.silo) {
      const s = P(9, -3.5);
      gb.cylinder(s.x, y, s.z, 1.15, 6.5, LAND_COLORS.silo, 10);
      gb.cylinder(s.x, y + 6.5, s.z, 1.25, 1.1, LAND_COLORS.siloCap, 10, 0);
    }
    // Hay bales and a yard fence.
    for (let i = 0; i < 3; i++) {
      const p = P(1 + i * 1.3, 5);
      gb.cylinder(p.x, y, p.z, 0.5, 0.8, LAND_COLORS.hay, 8);
    }
    for (let i = 0; i <= 8; i++) {
      const p = P(-8 + i * 2.2, 7.5);
      gb.box(p.x, y, p.z, 0.1, 0.7, 0.1, D.fence);
    }
    const r0 = P(-8, 7.5);
    const r1 = P(9.6, 7.5);
    gb.box((r0.x + r1.x) / 2, y + 0.45, (r0.z + r1.z) / 2, Math.hypot(r1.x - r0.x, r1.z - r0.z), 0.08, 0.06, D.fence, {}, -f.yaw);
    if (f.windmill) {
      const m = P(-2, -12);
      const my = terrainHeight(L, m.x, m.z);
      gb.cylinder(m.x, my, m.z, 2.1, 8.5, LAND_COLORS.millTower, 8, 0.6);
      gb.cylinder(m.x, my + 8.5, m.z, 1.5, 1.6, LAND_COLORS.millCap, 8, 0.35);
      gb.box(m.x, my, m.z + 1.95, 0.8, 1.6, 0.3, LAND_COLORS.barnDoor);
      mill = { x: m.x, y: my + 8.2, z: m.z, yaw: Math.PI / 4 };
    }
  }
  return { gb, mill };
}

/** The windmill's four sails around the hub (local space: the hub at the origin, sails in the xy plane). */
export function buildMillSails(): GeoBuilder {
  const gb = new GeoBuilder();
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), a);
    const c = new Vector3(0, 3.1, 0).applyQuaternion(q);
    gb.boxRot(c.x, c.y, 0.9, 0.18, 6, 0.12, q, LAND_COLORS.millCap);
    const s = new Vector3(0.65, 3.4, 0).applyQuaternion(q);
    gb.boxRot(s.x, s.y, 0.95, 1.1, 4.8, 0.05, q, LAND_COLORS.millSail);
  }
  gb.cylinder(0, -0.3, 0.6, 0.35, 0.6, LAND_COLORS.millCap, 8);
  return gb;
}

// ── Water ─────────────────────────────────────────────────────────────────

export function buildCountryWater(L: SurroundLayout): GeoBuilder {
  const gb = new GeoBuilder();
  const y = LAND_Y + 0.03;
  const deep = G.waterDeep;
  const edge = mixHex(G.water, '#ffffff', 0.1);
  // The Brook: a ribbon west → east, finer near the town.
  let x = L.river.x0;
  while (x < L.river.x1) {
    const step = Math.abs(x) < 260 ? 3 : 14;
    const x1 = Math.min(L.river.x1, x + step);
    const z0 = riverZ(L.hz, x);
    const z1 = riverZ(L.hz, x1);
    const h = L.river.half;
    // Three strips: shallows, the channel, shallows.
    const bands: [number, number, string][] = [
      [-h, -h * 0.55, edge],
      [-h * 0.55, h * 0.55, deep],
      [h * 0.55, h, edge],
    ];
    for (const [a, b, c] of bands) gb.quad(v3(x, y, z0 + b), v3(x1, y, z1 + b), v3(x1, y, z1 + a), v3(x, y, z0 + a), c);
    x = x1;
  }
  // The lake: a wobbly ellipse, deeper in the middle.
  const n = 56;
  const rim = (i: number, k: number) => {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + 0.08 * Math.sin(3 * a + 1) + 0.05 * Math.sin(5 * a + 2);
    return v3(L.lake.cx + Math.cos(a) * L.lake.rx * w * k, y, L.lake.cz + Math.sin(a) * L.lake.rz * w * k);
  };
  const centre = v3(L.lake.cx, y, L.lake.cz);
  for (let i = 0; i < n; i++) {
    gb.tri(centre, rim(i + 1, 0.7), rim(i, 0.7), deep);
    gb.quad(rim(i, 0.7), rim(i + 1, 0.7), rim(i + 1, 1), rim(i, 1), G.water);
  }
  return gb;
}

// ── Mountains ─────────────────────────────────────────────────────────────

/** Far ranges (φ from north, clockwise, degrees): faceted silhouettes the material mixes into the haze by height. */
export function buildMountains(): BufferGeometry {
  const ranges = [
    { from: -55, to: 25, r: 610, h: 110, salt: 1, tone: 0.95 },
    { from: 20, to: 120, r: 650, h: 125, salt: 2, tone: 1 },
    { from: -150, to: -70, r: 620, h: 85, salt: 3, tone: 0.97 },
    { from: 140, to: 220, r: 690, h: 60, salt: 4, tone: 1.02 },
    { from: -35, to: 85, r: 740, h: 165, salt: 5, tone: 1.06 },
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const c = new Color();
  // Light from the south-west and above: sunward facets lighter, the others in shade.
  const light = new Vector3(-0.45, 0.55, 0.7).normalize();
  const tri = (a: Vector3, b: Vector3, d: Vector3, base: string, top: string, peakY: number) => {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(d, a)).normalize();
    const shade = 0.82 + 0.3 * Math.max(0, n.dot(light));
    for (const p of [a, b, d]) {
      pos.push(p.x, p.y, p.z);
      const snow = p.y > peakY * 0.82 && peakY > 100;
      c.set(snow ? LAND_COLORS.snow : mixHex(base, top, Math.min(1, Math.max(0, p.y / peakY)))).multiplyScalar(shade);
      col.push(c.r, c.g, c.b);
    }
  };
  for (const R of ranges) {
    const step = 1.6;
    const ridge: Vector3[] = [];
    const foot: Vector3[] = [];
    for (let a = R.from; a <= R.to + 1e-6; a += step) {
      const t = (a - R.from) / (R.to - R.from);
      const env = Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, t))), 0.7);
      const peak = Math.abs(Math.sin(a * 0.23 + R.salt) * 0.55 + Math.sin(a * 0.61 + R.salt * 2) * 0.3 + Math.sin(a * 1.7 + R.salt) * 0.15);
      const y = R.h * env * (0.3 + 0.7 * peak) + 3;
      const rr = R.r + (hash2(Math.round(a * 10), R.salt, 81) - 0.5) * 40;
      const ang = (a * Math.PI) / 180;
      ridge.push(new Vector3(Math.sin(ang) * rr, y, -Math.cos(ang) * rr));
      foot.push(new Vector3(Math.sin(ang) * (rr - 60), -25, -Math.cos(ang) * (rr - 60)));
    }
    const base = mixHex(LAND_COLORS.mountainLow, '#7d8a78', 0.25);
    const top = scaleHex(LAND_COLORS.mountainHigh, R.tone);
    for (let i = 0; i + 1 < ridge.length; i++) {
      // A mid row (the shoulder) breaks each slope into two facets.
      const m0 = new Vector3().lerpVectors(foot[i]!, ridge[i]!, 0.55).add(new Vector3(0, (hash2(i, R.salt, 82) - 0.5) * 10, 0));
      const m1 = new Vector3().lerpVectors(foot[i + 1]!, ridge[i + 1]!, 0.55).add(new Vector3(0, (hash2(i + 1, R.salt, 82) - 0.5) * 10, 0));
      tri(foot[i]!, foot[i + 1]!, m1, base, top, R.h);
      tri(foot[i]!, m1, m0, base, top, R.h);
      tri(m0, m1, ridge[i + 1]!, base, top, R.h);
      tri(m0, ridge[i + 1]!, ridge[i]!, base, top, R.h);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.computeBoundingSphere();
  return g;
}

// ── Instanced pieces ──────────────────────────────────────────────────────

function flatNormals(g: BufferGeometry): BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  return ng;
}

/** One tree: a trunk and two stacked cones (18 triangles); per-instance scale and colour. */
export function treeGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.08, 0.11, 0.6, 4, 1, true).translate(0, 0.3, 0);
  const low = new ConeGeometry(0.62, 1.15, 6, 1, true).translate(0, 1.0, 0);
  const high = new ConeGeometry(0.45, 0.95, 5, 1, true).translate(0, 1.55, 0);
  parts.push(trunk, low, high);
  const colors = [new Color(D.trunk), new Color('#ffffff'), new Color('#f0f4ee')];
  return mergeColored(parts.map(flatNormals), colors);
}

/** A small car: body and cabin (instanced, coloured per instance through instanceColor). */
export function carGeometry(): BufferGeometry {
  const gb = new GeoBuilder();
  gb.box(0, 0.12, 0, 0.62, 0.32, 1.25, '#ffffff', {}, 0, true);
  gb.box(0, 0.44, -0.05, 0.54, 0.26, 0.7, '#dfe6ee', {}, 0, true);
  for (const sx of [-0.31, 0.31]) for (const sz of [-0.38, 0.38]) gb.box(sx, 0.02, sz, 0.08, 0.2, 0.22, '#2b2e33', {}, 0, true);
  return gb.build()!;
}

/** Headlights (front, warm) and tail lights (back, red) of a car, shown at night. */
export function carLightsGeometry(): BufferGeometry {
  const gb = new GeoBuilder();
  for (const sx of [-0.2, 0.2]) {
    gb.box(sx, 0.2, 0.63, 0.12, 0.08, 0.03, '#fff1cc');
    gb.box(sx, 0.2, -0.63, 0.12, 0.07, 0.03, '#ff5a4a');
  }
  return gb.build()!;
}

/** A bird: two thin wing triangles hinged at the body (flapping scales them). */
export function birdGeometry(): BufferGeometry {
  const pos = new Float32Array([0, 0, 0.14, -0.45, 0.12, -0.05, 0, 0, -0.12, 0, 0, 0.14, 0, 0, -0.12, 0.45, 0.12, -0.05]);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Clouds: low-poly puffs at 60–90 units, each vertex knowing its cloud's centre (`aCenter`) for drift and fading. */
export function buildClouds(count: number, seed: number): { geometry: BufferGeometry; clouds: { x: number; y: number; z: number; r: number }[] } {
  const clouds: { x: number; y: number; z: number; r: number }[] = [];
  const pos: number[] = [];
  const nor: number[] = [];
  const cen: number[] = [];
  const ico = new IcosahedronGeometry(1, 0);
  ico.computeVertexNormals();
  const p = ico.getAttribute('position');
  const nn = ico.getAttribute('normal');
  const m = new Matrix4();
  const v = new Vector3();
  const nv = new Vector3();
  for (let i = 0; i < count; i++) {
    const a = hash2(i, seed, 91) * Math.PI * 2;
    const d = 40 + Math.sqrt(hash2(i, seed, 92)) * 540;
    const cx = Math.cos(a) * d;
    const cz = Math.sin(a) * d;
    const cy = 60 + hash2(i, seed, 93) * 30;
    const size = 9 + hash2(i, seed, 94) * 9;
    clouds.push({ x: cx, y: cy, z: cz, r: size * 2.1 });
    const puffs = 4 + Math.floor(hash2(i, seed, 95) * 3);
    for (let k = 0; k < puffs; k++) {
      const ox = (k - (puffs - 1) / 2) * size * 0.75 + (hash2(i, k, 96) - 0.5) * size * 0.4;
      const oz = (hash2(i, k, 97) - 0.5) * size * 0.9;
      const s = size * (0.75 + 0.5 * hash2(i, k, 98)) * (1 - Math.abs(k - (puffs - 1) / 2) / puffs);
      m.compose(new Vector3(cx + ox, cy + s * 0.15, cz + oz), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), hash2(i, k, 99) * 6), new Vector3(s, s * 0.55, s * 0.8));
      const nm = new Matrix4().extractRotation(m);
      for (let j = 0; j < p.count; j++) {
        v.fromBufferAttribute(p, j).applyMatrix4(m);
        nv.fromBufferAttribute(nn, j).applyMatrix4(nm).normalize();
        pos.push(v.x, v.y, v.z);
        nor.push(nv.x, nv.y, nv.z);
        cen.push(cx, cy, cz);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('aCenter', new BufferAttribute(new Float32Array(cen), 3));
  g.computeBoundingSphere();
  return { geometry: g, clouds };
}

/** Merge non-indexed geometries, giving each a vertex colour. */
function mergeColored(parts: BufferGeometry[], colors: Color[]): BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  parts.forEach((p, i) => {
    const pa = p.getAttribute('position');
    const na = p.getAttribute('normal');
    const c = colors[i]!;
    for (let k = 0; k < pa.count; k++, o++) {
      pos.set([pa.getX(k), pa.getY(k), pa.getZ(k)], o * 3);
      nor.set([na.getX(k), na.getY(k), na.getZ(k)], o * 3);
      col.set([c.r, c.g, c.b], o * 3);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
