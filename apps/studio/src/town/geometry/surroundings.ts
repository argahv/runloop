/**
 * The land beyond the town (immersive contract §3): outskirts, roads out,
 * farmsteads, patchwork fields and orchards, the Brook and a lake, a forest
 * belt on the northern hills, far mountains. Pure and deterministic: the
 * layout is a function of the town (and a seed), so it is unit-tested
 * (surroundings.test.ts) and built once.
 *
 * Everything here is decoration: never pickable, never in the directory, the
 * minimap, the log or ⌘K. Decorative ambient life (cars, birds) keeps at
 * least AMBIENT_CLEARANCE cells from every agent lot, and birds stay out of
 * the Agent District (plus 10 cells), so nothing near an agent's building ever
 * moves without a real event.
 *
 * Scene axes: +x east, +z south, one cell = one unit, the town centred on the origin.
 */
import type { CompiledTown } from '@runloop-world/town';
import { MARGIN } from '../coords';

/** Cells kept clear of decorative motion around every agent lot. */
export const AMBIENT_CLEARANCE = 12;
/** Radius of the land disc (scene units). */
export const LAND_RADIUS = 900;

export interface Pt {
  x: number;
  z: number;
}

export interface RoadOut {
  id: string;
  kind: 'road' | 'lane' | 'track';
  /** Centre line from the town (or a junction) outwards. */
  pts: Pt[];
  width: number;
  /** Street lamps along it (roads out only; nothing else outside the town lights up). */
  lampsTo: number;
}

export interface Farm {
  x: number;
  z: number;
  yaw: number;
  silo: boolean;
  windmill: boolean;
}

export interface Field {
  cx: number;
  cz: number;
  w: number;
  d: number;
  yaw: number;
  tone: number;
  orchard: boolean;
}

export interface Bush {
  x: number;
  z: number;
  s: number;
  tone: number;
}

export interface TreeInst {
  x: number;
  z: number;
  /** Crown width and height scale. */
  s: number;
  h: number;
  /** Index into TREE_TONES. */
  tone: number;
  /** 0–1: trees with a rank above the quality's share are not drawn. */
  rank: number;
}

export interface CarRoute {
  id: string;
  pts: Pt[];
  /** Cumulative length at each point. */
  len: number[];
  cars: number;
  /** Cars kept on lite quality (phones). */
  liteCars: number;
  speed: number;
}

export interface Flock {
  id: string;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  y: number;
  birds: number;
  /** Seconds per loop. */
  period: number;
}

export interface Bridge {
  x: number;
  z: number;
  /** The road runs along z (north–south) when true. */
  alongZ: boolean;
  length: number;
}

export interface SurroundLayout {
  /** Half extents of the town's ground (cells, incl. its grass margin). */
  hx: number;
  hz: number;
  roads: RoadOut[];
  /** Cells of the town's ground the roads out cross (town grid; ramp heights). */
  exits: Map<number, number>;
  river: { x0: number; x1: number; half: number };
  lake: { cx: number; cz: number; rx: number; rz: number };
  bridges: Bridge[];
  farms: Farm[];
  fields: Field[];
  bushes: Bush[];
  trees: TreeInst[];
  cars: CarRoute[];
  flocks: Flock[];
  /** Agent lots (scene rects) for clearance checks. */
  agentRects: { x0: number; z0: number; x1: number; z1: number }[];
  /** The Agent District's bounding box (scene), grown by 10 cells: birds never fly in it. */
  birdExclusion: { x0: number; z0: number; x1: number; z1: number };
}

// ── Noise and helpers ─────────────────────────────────────────────────────

export function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1). */
export function vnoise(x: number, y: number, salt = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, salt);
  const b = hash2(x0 + 1, y0, salt);
  const c = hash2(x0, y0 + 1, salt);
  const d = hash2(x0 + 1, y0 + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance from a point to an axis-aligned rectangle (0 inside). */
export function rectDist(x: number, z: number, r: { x0: number; z0: number; x1: number; z1: number }): number {
  return Math.hypot(Math.max(0, r.x0 - x, x - r.x1), Math.max(0, r.z0 - z, z - r.z1));
}

/** Distance from a point to a polyline. */
export function polyDist(x: number, z: number, pts: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2));
    best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t));
  }
  return best;
}

// ── The Brook and the lake ────────────────────────────────────────────────

/** The Brook's centre line: z at x (west → east, south of the town). */
export function riverZ(hz: number, x: number): number {
  return hz + 20 + 5 * Math.sin(x / 90 + 0.8) + 2.5 * Math.sin(x / 37 + 2.1);
}

// ── Terrain ───────────────────────────────────────────────────────────────

/** Height of the land the town's grass margin meets (just under the margin's 0.08). */
export const LAND_Y = 0.075;

/** The hills' sector: centred north-north-east of the town. */
const HILL_DIR = 35;

/** How much of the hill sector a direction is in (0 … 1). */
export function hillWeight(x: number, z: number): number {
  const phi = (Math.atan2(x, -z) * 180) / Math.PI;
  const d = Math.abs(((phi - HILL_DIR + 540) % 360) - 180);
  return 1 - smoothstep(40, 70, d);
}

/** Height of the land at (x, z): flat around the town, hills to the north, gentle rolls far out, flat by the water. */
export function terrainHeight(L: Pick<SurroundLayout, 'hx' | 'hz' | 'river' | 'lake'>, x: number, z: number): number {
  const r = Math.hypot(Math.max(0, Math.abs(x) - L.hx), Math.max(0, Math.abs(z) - L.hz));
  if (r < 30) return LAND_Y;
  const w = hillWeight(x, z);
  const hill = 25 * smoothstep(50, 400, r) * w * (0.7 + 0.6 * vnoise(x / 110, z / 110, 3));
  const roll = Math.max(0, 2.4 * smoothstep(100, 320, r) * (vnoise(x / 70 + 7, z / 70 + 3, 5) - 0.3));
  let k = 1;
  if (x > L.river.x0 - 30) k *= smoothstep(9, 30, Math.abs(z - riverZ(L.hz, x)));
  const e = Math.hypot((x - L.lake.cx) / L.lake.rx, (z - L.lake.cz) / L.lake.rz);
  k *= smoothstep(1.05, 1.7, e);
  return LAND_Y + (hill + roll) * k;
}

// ── Layout ────────────────────────────────────────────────────────────────

const sceneOf = (town: CompiledTown) => ({ x: (gx: number) => gx - (town.width - 1) / 2, z: (gy: number) => gy - (town.height - 1) / 2 });

/**
 * Where the roads leave the town: an avenue reaching the northern or southern
 * ring road, the streets reaching the western and eastern ones. The town
 * file has no roads out; these continue its own lines into the country.
 */
function exitLines(town: CompiledTown): { north: number | null; south: number | null; west: number | null; east: number | null; westway: number | null; brook: number | null } {
  const s = sceneOf(town);
  let north: number | null = null;
  let south: number | null = null;
  let west: number | null = null;
  let east: number | null = null;
  let westway: number | null = null;
  let brook: number | null = null;
  for (const r of town.def.roads) {
    const [x, y, w, h] = r.rect;
    const cx = s.x(x + (w - 1) / 2);
    const cz = s.z(y + (h - 1) / 2);
    if (r.kind === 'ring') {
      if (w === 2 && x <= 4) westway = cx;
      if (h === 2 && y + h >= town.height - 5) brook = cz;
      continue;
    }
    if (w === 2 && y <= 5) north = cx;
    if (w === 2 && y + h >= town.height - 5) south = cx;
    if (h === 2 && x <= 5) west = cz;
    if (h === 2 && x + w >= town.width - 5) east = cz;
  }
  return { north, south, west, east, westway, brook };
}

function lengths(pts: readonly Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z));
  return out;
}

export function surroundLayout(town: CompiledTown, seed = 1): SurroundLayout {
  const hx = town.width / 2 + MARGIN;
  const hz = town.height / 2 + MARGIN;
  const s = sceneOf(town);
  const ex = exitLines(town);
  const R = LAND_RADIUS;
  const lake = { cx: -hx - 130, cz: hz + 12, rx: 42, rz: 28 };
  const river = { x0: lake.cx + 30, x1: R, half: 5 };

  const agentRects = town.agentLots.map((l) => {
    const [x, y, w, h] = l.rect;
    return { x0: s.x(x) - 0.5, z0: s.z(y) - 0.5, x1: s.x(x + w - 1) + 0.5, z1: s.z(y + h - 1) + 0.5 };
  });
  const district = town.def.districts.find((d) => d.id === 'dst_agent_district') ?? null;
  let bx0 = Infinity;
  let bz0 = Infinity;
  let bx1 = -Infinity;
  let bz1 = -Infinity;
  for (const r of district?.rects ?? []) {
    bx0 = Math.min(bx0, s.x(r[0]) - 0.5);
    bz0 = Math.min(bz0, s.z(r[1]) - 0.5);
    bx1 = Math.max(bx1, s.x(r[0] + r[2] - 1) + 0.5);
    bz1 = Math.max(bz1, s.z(r[1] + r[3] - 1) + 0.5);
  }
  for (const a of agentRects) {
    bx0 = Math.min(bx0, a.x0);
    bz0 = Math.min(bz0, a.z0);
    bx1 = Math.max(bx1, a.x1);
    bz1 = Math.max(bz1, a.z1);
  }
  const birdExclusion = Number.isFinite(bx0) ? { x0: bx0 - 10, z0: bz0 - 10, x1: bx1 + 10, z1: bz1 + 10 } : { x0: 0, z0: 0, x1: 0, z1: 0 };

  // Roads out (and two country lanes), from the town's ground edge.
  const roads: RoadOut[] = [];
  const north = ex.north ?? 0;
  const south = ex.south ?? 0;
  const west = ex.west ?? 0;
  const east = ex.east ?? 0;
  const lineTo = (a: Pt, b: Pt, step: number): Pt[] => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }));
  };
  // Roads bend a little once they are clear of the outskirts, so they read as country roads.
  const wander = (pts: Pt[], axis: 'x' | 'z', amp: number, from: number) =>
    pts.map((p) => {
      const t = Math.max(0, Math.hypot(p.x, p.z) - from);
      const k = smoothstep(0, 80, t) * amp;
      return axis === 'x' ? { x: p.x + k * Math.sin(p.z / 95 + 1.3), z: p.z } : { x: p.x, z: p.z + k * Math.sin(p.x / 105 + 0.4) };
    });
  if (ex.north !== null) roads.push({ id: 'road_out_north', kind: 'road', pts: wander(lineTo({ x: north, z: -hz }, { x: north, z: -R }, 6), 'x', 9, hz + 60), width: 2, lampsTo: 130 });
  if (ex.south !== null) roads.push({ id: 'road_out_south', kind: 'road', pts: wander(lineTo({ x: south, z: hz }, { x: south, z: R }, 6), 'x', 9, hz + 70), width: 2, lampsTo: 130 });
  if (ex.west !== null) roads.push({ id: 'road_out_west', kind: 'road', pts: wander(lineTo({ x: -hx, z: west }, { x: -R, z: west }, 6), 'z', 10, hx + 70), width: 2, lampsTo: 130 });
  if (ex.east !== null) roads.push({ id: 'road_out_east', kind: 'road', pts: wander(lineTo({ x: hx, z: east }, { x: R, z: east }, 6), 'z', 10, hx + 70), width: 2, lampsTo: 130 });
  // Ridge Lane crosses the north road well clear of the Agent District; Orchard Lane runs south off the east road.
  const ridgeZ = -hz - 34;
  roads.push({ id: 'lane_ridge', kind: 'lane', pts: lineTo({ x: -R, z: ridgeZ }, { x: R, z: ridgeZ }, 8).map((p) => ({ x: p.x, z: p.z + 6 * Math.sin(p.x / 80) * smoothstep(20, 120, Math.abs(p.x)) })), width: 1.6, lampsTo: 0 });
  const orchardX = hx + 70;
  const eastRoad = roads.find((r) => r.id === 'road_out_east');
  const orchardStart = eastRoad ? { x: orchardX, z: zOnRoad(eastRoad.pts, orchardX) } : { x: orchardX, z: east };
  roads.push({ id: 'lane_orchard', kind: 'lane', pts: lineTo(orchardStart, { x: orchardX, z: R }, 8).map((p) => ({ x: p.x + 5 * Math.sin(p.z / 70) * smoothstep(0, 60, p.z - orchardStart.z), z: p.z })), width: 1.6, lampsTo: 0 });

  // Exit cells: the town ground the roads out cross, ramping from the road datum up to the land.
  const exits = new Map<number, number>();
  const W = town.width;
  const H = town.height;
  const key = (gx: number, gy: number) => (gy + MARGIN) * (W + 2 * MARGIN) + gx + MARGIN;
  const ramp = (step: number) => Math.min(LAND_Y + 0.01, 0.022 * (step + 1));
  const cellsOf = (centre: number, f: (c: number) => number) => [Math.round(f(centre) - 0.5), Math.round(f(centre) + 0.5)];
  if (ex.north !== null) {
    const cols = cellsOf(north, (c) => c + (W - 1) / 2);
    for (let gy = 1, i = 0; gy >= -MARGIN; gy--, i++) for (const gx of cols) if (!walkable(town, gx, gy)) exits.set(key(gx, gy), ramp(i));
  }
  if (ex.south !== null) {
    const cols = cellsOf(south, (c) => c + (W - 1) / 2);
    for (let gy = H - 2, i = 0; gy < H + MARGIN; gy++, i++) for (const gx of cols) if (!walkable(town, gx, gy)) exits.set(key(gx, gy), ramp(i));
  }
  if (ex.west !== null) {
    const rows = cellsOf(west, (c) => c + (H - 1) / 2);
    for (let gx = 1, i = 0; gx >= -MARGIN; gx--, i++) for (const gy of rows) if (!walkable(town, gx, gy)) exits.set(key(gx, gy), ramp(i));
  }
  if (ex.east !== null) {
    const rows = cellsOf(east, (c) => c + (H - 1) / 2);
    for (let gx = W - 2, i = 0; gx < W + MARGIN; gx++, i++) for (const gy of rows) if (!walkable(town, gx, gy)) exits.set(key(gx, gy), ramp(i));
  }

  // Bridges where roads and lanes cross the Brook.
  const bridges: Bridge[] = [];
  for (const r of roads) {
    if (r.kind === 'road' && (r.id === 'road_out_south')) {
      const z = riverZ(hz, south);
      bridges.push({ x: south, z, alongZ: true, length: 2 * river.half + 8 });
    }
    if (r.id === 'lane_orchard') {
      const z = riverZ(hz, orchardX);
      bridges.push({ x: xOnRoad(r.pts, z), z, alongZ: true, length: 2 * river.half + 8 });
    }
  }

  // Farmsteads in the fields ring (never in the hills, the water or on a road).
  const rand = rng(seed * 7919 + 17);
  const roadDist = (x: number, z: number) => Math.min(...roads.map((r) => polyDist(x, z, r.pts)));
  const waterDist = (x: number, z: number) => {
    const e = Math.hypot((x - lake.cx) / lake.rx, (z - lake.cz) / lake.rz);
    const lakeD = (e - 1) * Math.min(lake.rx, lake.rz);
    const riverD = x < river.x0 ? Infinity : Math.abs(z - riverZ(hz, x)) - river.half;
    return Math.min(lakeD, riverD);
  };
  const townDist = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x) - hx), Math.max(0, Math.abs(z) - hz));
  const farmSpots: [number, number][] = [
    [-hx - 46, -hz - 22],
    [-hx - 62, -5],
    [-hx - 30, hz + 58],
    [42, hz + 62],
    [hx + 62, hz + 48],
    [hx + 40, hz + 2],
    [-hx - 88, -hz - 8],
    [-34, hz + 76],
  ];
  const farms: Farm[] = [];
  farmSpots.forEach(([fx, fz], i) => {
    let x = fx;
    let z = fz;
    // Nudge off roads and water.
    for (let k = 0; k < 12 && (roadDist(x, z) < 12 || waterDist(x, z) < 12 || hillWeight(x, z) > 0.35); k++) {
      x += (rand() - 0.5) * 18;
      z += (rand() - 0.5) * 18;
    }
    if (roadDist(x, z) < 9 || waterDist(x, z) < 9) return;
    farms.push({ x, z, yaw: Math.round(rand() * 4) * (Math.PI / 2) + (rand() - 0.5) * 0.3, silo: i % 3 !== 1, windmill: i === 1 });
  });
  const farmDist = (x: number, z: number) => Math.min(Infinity, ...farms.map((f) => Math.hypot(x - f.x, z - f.z)));

  // Patchwork fields on a jittered grid from the outskirts out to ~95 cells, clear of hills, water, roads and farmyards.
  const fields: Field[] = [];
  const FW = 16;
  const FD = 12;
  for (let gz = -14; gz <= 14; gz++) {
    for (let gx = -16; gx <= 16; gx++) {
      const cx = gx * (FW + 1.8) + (hash2(gx, gz, 21) - 0.5) * 2.5;
      const cz = gz * (FD + 1.8) + (hash2(gx, gz, 22) - 0.5) * 2.5;
      const r = townDist(cx, cz);
      if (r < 14 + FW / 2 || r > 95) continue;
      if (terrainHeight({ hx, hz, river, lake }, cx, cz) > LAND_Y + 0.001) continue;
      if (hillWeight(cx, cz) > 0.3) continue;
      if (roadDist(cx, cz) < FW / 2 + 2 || waterDist(cx, cz) < FW / 2 + 2 || farmDist(cx, cz) < 15) continue;
      if (hash2(gx, gz, 23) < 0.1) continue;
      const orchard = hash2(gx, gz, 24) < 0.13;
      fields.push({ cx, cz, w: FW - (hash2(gx, gz, 25) < 0.3 ? 4 : 0), d: FD, yaw: (hash2(gx, gz, 26) - 0.5) * 0.06, tone: Math.floor(hash2(gx, gz, 27) * 6), orchard });
    }
  }

  // Bushes and hedgerow lines in the outskirts (low, round), broken where the roads leave.
  const bushes: Bush[] = [];
  for (let i = 0; i < 260; i++) {
    const side = i % 4;
    const t = rand() * 2 - 1;
    const off = 5 + rand() * 20;
    const x = side < 2 ? t * (hx + off) : side === 2 ? -hx - off : hx + off;
    const z = side === 0 ? -hz - off : side === 1 ? hz + off : t * (hz + off);
    if (roadDist(x, z) < 2.5 || waterDist(x, z) < 2 || farmDist(x, z) < 9) continue;
    if (fields.some((f) => Math.abs(x - f.cx) < f.w / 2 + 1 && Math.abs(z - f.cz) < f.d / 2 + 1)) continue;
    bushes.push({ x, z, s: 0.35 + rand() * 0.4, tone: Math.floor(rand() * 3) });
  }

  // Trees: the forest belt on the hills, groves, hedgerows between fields, orchards, a few in the outskirts.
  const trees: TreeInst[] = [];
  const addTree = (x: number, z: number, s: number, h: number, tone: number) => {
    if (townDist(x, z) < 6 || roadDist(x, z) < 3 || waterDist(x, z) < 3 || farmDist(x, z) < 10) return;
    trees.push({ x, z, s, h, tone, rank: hash2(Math.round(x * 3), Math.round(z * 3), 31) });
  };
  for (let i = 0; i < 720; i++) {
    // Belt: polar samples in the hill sector, denser near the town.
    const a = ((HILL_DIR + (rand() * 2 - 1) * 62) * Math.PI) / 180;
    const rr = 34 + Math.pow(rand(), 1.6) * 260;
    const x = Math.sin(a) * (rr + hx * 0.7);
    const z = -Math.cos(a) * (rr + hz * 0.7);
    if (hillWeight(x, z) < 0.25 + rand() * 0.3) continue;
    const big = 0.9 + rand() * 0.8;
    addTree(x, z, big, big * (1.2 + rand() * 0.7), rand() < 0.7 ? 0 : 1);
  }
  // Groves south of the Brook and west by the lake.
  for (const [gx, gz, n, rad] of [
    [70, hz + 90, 60, 28],
    [-hx - 60, hz + 70, 45, 22],
    [-hx - 150, -20, 70, 36],
    [hx + 120, hz + 120, 50, 30],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * rad;
      const big = 0.8 + rand() * 0.7;
      addTree(gx + Math.cos(a) * d, gz + Math.sin(a) * d, big, big * (1 + rand() * 0.6), rand() < 0.5 ? 2 : 0);
    }
  }
  // Hedgerow trees along field edges and orchard rows.
  for (const f of fields) {
    if (f.orchard) {
      for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) addTree(f.cx + i * 3.2, f.cz + j * 3.6, 0.75, 0.75, 3);
      continue;
    }
    const n = Math.floor(hash2(Math.round(f.cx), Math.round(f.cz), 41) * 3);
    for (let i = 0; i < n; i++) addTree(f.cx - f.w / 2 - 1.1 + (hash2(i, Math.round(f.cx), 42) - 0.5) * 1.5, f.cz + (hash2(i, Math.round(f.cz), 43) - 0.5) * f.d, 0.85, 1.1, 2);
  }
  // Small groves in the outskirts (3–7 trees each) and by the farms.
  for (let g = 0; g < 34; g++) {
    const side = g % 4;
    const t = rand() * 2 - 1;
    const off = 9 + rand() * 30;
    const gx = side < 2 ? t * (hx + 25) : side === 2 ? -hx - off : hx + off;
    const gz = side === 0 ? -hz - off : side === 1 ? hz + off : t * (hz + 25);
    const n = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * 5;
      const x = gx + Math.cos(a) * d;
      const z = gz + Math.sin(a) * d;
      if (fields.some((f) => Math.abs(x - f.cx) < f.w / 2 + 1 && Math.abs(z - f.cz) < f.d / 2 + 1)) continue;
      const big = 0.85 + rand() * 0.6;
      addTree(x, z, big, big * (1.05 + rand() * 0.6), rand() < 0.6 ? 2 : 0);
    }
  }
  for (const f of farms) for (let i = 0; i < 6; i++) {
    const a = f.yaw + (i / 6) * Math.PI * 2 + rand() * 0.4;
    const x = f.x + Math.cos(a) * 15;
    const z = f.z + Math.sin(a) * 15;
    if (roadDist(x, z) > 3 && waterDist(x, z) > 3) trees.push({ x, z, s: 1.1, h: 1.4, tone: 2, rank: rand() });
  }

  // Decorative cars: only on roads out, Westway and Brook Road, and never within AMBIENT_CLEARANCE of an agent lot.
  const cars: CarRoute[] = [];
  const clear = (pts: Pt[]) => pts.filter((p) => Math.min(...agentRects.map((a) => rectDist(p.x, p.z, a))) >= AMBIENT_CLEARANCE + 1);
  const route = (id: string, raw: Pt[], n: number, lite: number, speed: number) => {
    const pts = densify(raw, 4);
    const ok = clear(pts);
    if (ok.length !== pts.length || pts.length < 2) return;
    cars.push({ id, pts, len: lengths(pts), cars: n, liteCars: lite, speed });
  };
  const westRoad = roads.find((r) => r.id === 'road_out_west');
  const southRoad = roads.find((r) => r.id === 'road_out_south');
  const northRoad = roads.find((r) => r.id === 'road_out_north');
  const ridge = roads.find((r) => r.id === 'lane_ridge')!;
  const orchard = roads.find((r) => r.id === 'lane_orchard')!;
  if (westRoad && southRoad && ex.westway !== null && ex.brook !== null) {
    // In from the west, down Westway, along Brook Road, out over the bridge to the south (and back).
    const inWest = [...westRoad.pts].reverse();
    const through: Pt[] = [...inWest, { x: ex.westway, z: west }, { x: ex.westway, z: ex.brook }, { x: south, z: ex.brook }, ...southRoad.pts];
    route('car_west_south', through, 3, 2, 7);
    route('car_south_west', [...through].reverse(), 3, 2, 7);
  }
  if (northRoad) {
    // Down the north road to Ridge Lane, then east (well clear of the Agent District).
    const i = northRoad.pts.findIndex((p) => p.z <= ridgeZ);
    const northPart = [...northRoad.pts.slice(i)].reverse();
    const eastPart = ridge.pts.filter((p) => p.x >= north);
    route('car_north_ridge', [...northPart, ...eastPart], 2, 0, 6);
    route('car_ridge_west', [...ridge.pts].reverse(), 1, 0, 6);
  }
  if (eastRoad) {
    // In from the far east, then south down Orchard Lane.
    const eastPart = [...eastRoad.pts.filter((p) => p.x >= orchardX)].reverse();
    route('car_east_orchard', [...eastPart, ...orchard.pts], 1, 0, 6);
  }

  // Birds: over the western fields, the north-eastern forest and the park by the Brook (by day only).
  const flocks: Flock[] = [
    { id: 'flock_fields', cx: -hx - 50, cz: -8, rx: 34, rz: 24, y: 18, birds: 7, period: 46 },
    { id: 'flock_forest', cx: 90, cz: -hz - 120, rx: 40, rz: 30, y: 30, birds: 9, period: 58 },
    { id: 'flock_brook', cx: -30, cz: hz + 34, rx: 30, rz: 16, y: 16, birds: 5, period: 40 },
  ].filter((f) => rectDist(f.cx, f.cz, birdExclusion) > Math.max(f.rx, f.rz) + 8);

  return { hx, hz, roads, exits, river, lake, bridges, farms, fields, bushes, trees, cars, flocks, agentRects, birdExclusion };
}

/** Points every `step` units or closer along a polyline (duplicates dropped). */
export function densify(pts: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const b = pts[i]!;
    const a = out[out.length - 1];
    if (a) {
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 1e-6) continue;
      const n = Math.ceil(d / step);
      for (let k = 1; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    out.push(b);
  }
  return out;
}

function walkable(town: CompiledTown, gx: number, gy: number): boolean {
  if (gx < 0 || gy < 0 || gx >= town.width || gy >= town.height) return false;
  return town.walkable[gy * town.width + gx] === 1;
}

/** z of a mostly east–west polyline at x. */
function zOnRoad(pts: readonly Pt[], x: number): number {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) return a.z + ((b.z - a.z) * (x - a.x)) / (b.x - a.x);
  }
  return pts[0]?.z ?? 0;
}

/** x of a mostly north–south polyline at z. */
function xOnRoad(pts: readonly Pt[], z: number): number {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if ((a.z - z) * (b.z - z) <= 0 && a.z !== b.z) return a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z);
  }
  return pts[0]?.x ?? 0;
}

// ── Ambient life (closed form in time) ────────────────────────────────────

/** A car's place on its route at ambient time t (s): position, heading, and its lane (right-hand side). */
export function carPose(r: CarRoute, i: number, t: number, out: { x: number; z: number; yaw: number; y?: number }, ys?: readonly number[]): void {
  const total = r.len[r.len.length - 1]!;
  const phase = (i / Math.max(1, r.cars)) * total + hash2(i, r.id.length, 51) * 40;
  let d = (phase + t * r.speed * (0.85 + 0.3 * hash2(i, r.id.length, 52))) % total;
  if (d < 0) d += total;
  // The segment holding d (binary search over the cumulative lengths).
  let lo = 1;
  let hi = r.len.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.len[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  const k = lo;
  const a = r.pts[k - 1]!;
  const b = r.pts[k]!;
  const seg = r.len[k]! - r.len[k - 1]! || 1;
  const u = (d - r.len[k - 1]!) / seg;
  const dx = (b.x - a.x) / seg;
  const dz = (b.z - a.z) / seg;
  // Right-hand lane: half a cell to the right of the centre line.
  out.x = a.x + (b.x - a.x) * u - dz * 0.5;
  out.z = a.z + (b.z - a.z) * u + dx * 0.5;
  out.yaw = Math.atan2(dx, dz);
  if (ys) out.y = ys[k - 1]! + (ys[k]! - ys[k - 1]!) * u;
}

/** A bird's position at ambient time t (s). */
export function birdPose(f: Flock, i: number, t: number, out: { x: number; y: number; z: number; yaw: number; flap: number }): void {
  const w = (Math.PI * 2) / f.period;
  const a = t * w + hash2(i, f.id.length, 61) * 0.5;
  // The flock loops on an ellipse; each bird trails a little and wanders around the centre.
  const lag = i * 0.045;
  const cx = f.cx + Math.cos(a - lag) * f.rx;
  const cz = f.cz + Math.sin(a - lag) * f.rz;
  const jx = Math.sin(t * 0.9 + i * 1.7) * 2.2 + (hash2(i, 1, 62) - 0.5) * 5;
  const jz = Math.cos(t * 0.8 + i * 2.3) * 2.2 + (hash2(i, 2, 63) - 0.5) * 5;
  out.x = cx + jx;
  out.z = cz + jz;
  out.y = f.y + Math.sin(t * 0.7 + i) * 1.5 + hash2(i, 3, 64) * 3;
  const vx = -Math.sin(a - lag) * f.rx;
  const vz = Math.cos(a - lag) * f.rz;
  out.yaw = Math.atan2(vx, vz);
  out.flap = Math.sin(t * 9 + i * 1.3);
}
