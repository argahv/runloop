/**
 * The ground: one merged mesh per chunk with vertex colours (grass by
 * district, mown park stripes, garden rows, asphalt with lane marks,
 * sidewalks with curbs, zebra crossings, paved plazas, gravel paths, a pond
 * with a stone bank). The town no longer stands on a slab: its grass margin
 * meets the land beyond (geometry/surroundings.ts), and the roads out cross
 * the margin on `exits` cells that ramp up from the road datum. Static: built once.
 */
import { GROUND, type CompiledTown } from '@runloop-world/town';
import { Color, Vector3 } from 'three';
import { mixHex, scaleHex } from '../color';
import { MARGIN, SURFACE_Y, cellY, sceneX, sceneZ } from '../coords';
import { GROUND_COLORS as G, AGENT_HQ_COLORS } from '../townPalette';
import { GeoBuilder } from './builder';

export const CHUNK = 32;

/** Cheap deterministic per-cell noise in [0, 1). */
export function noise2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface CellLook {
  top: string;
  side: string;
}

function lookOf(town: CompiledTown, x: number, y: number, agentLot: Uint8Array): CellLook {
  const code = town.raster.ground[y * town.width + x]!;
  const di = town.districtAt[y * town.width + x]!;
  const district = di >= 0 ? town.def.districts[di]!.ground : G.grass;
  const n = noise2(x, y);
  const vary = (c: string, k = 0.05) => scaleHex(c, 1 - k + 2 * k * n);
  switch (code) {
    case GROUND.road:
    case GROUND.crosswalk:
      return { top: vary(G.asphalt, 0.025), side: G.asphaltDark };
    case GROUND.sidewalk:
      return { top: (x + y) % 2 ? G.sidewalk : mixHex(G.sidewalk, G.sidewalkJoint, 0.45), side: G.curb };
    case GROUND.plaza: {
      // Paving: quiet per-cell variation, with a slightly darker course every sixth row and column.
      const course = x % 6 === 0 || y % 6 === 0;
      return { top: course ? mixHex(G.plazaA, G.plazaB, 0.75) : mixHex(G.plazaA, G.plazaB, 0.3 * n), side: G.curb };
    }
    case GROUND.path:
      return { top: vary(G.path, 0.04), side: scaleHex(G.path, 0.85) };
    case GROUND.park:
      return { top: vary(y % 2 ? mixHex(G.park, district, 0.35) : mixHex(G.parkDark, district, 0.3), 0.025), side: G.soil };
    case GROUND.garden:
      return { top: x % 2 ? G.gardenRow : G.gardenSoil, side: G.soil };
    case GROUND.water:
      return { top: vary(G.water, 0.03), side: G.waterEdge };
    case GROUND.lot:
      if (agentLot[y * town.width + x]) return { top: vary(mixHex(AGENT_HQ_COLORS.forecourt, district, 0.25), 0.02), side: G.curb };
      return { top: vary(mixHex(district, '#ffffff', 0.08), 0.04), side: G.soil };
    case GROUND.footprint:
    case GROUND.door:
      return { top: G.footprint, side: G.curb };
    case GROUND.landmark:
      return { top: G.landmarkBase, side: G.curb };
    default:
      return { top: vary(district, 0.045), side: G.soil };
  }
}

/** How enclosed a ground cell is by footprints and landmarks (0 = open … 0.12 = boxed in). */
function contactShade(town: CompiledTown, x: number, y: number): number {
  const g = town.raster.ground;
  const here = g[y * town.width + x]!;
  if (here === GROUND.footprint || here === GROUND.door || here === GROUND.landmark || here === GROUND.water) return 0;
  let k = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= town.width || ny >= town.height) continue;
      const c = g[ny * town.width + nx];
      if (c === GROUND.footprint || c === GROUND.landmark) k += dx && dy ? 0.45 : 1;
    }
  }
  return Math.min(0.12, k * 0.035);
}

/** Key of a town cell (margin included) in an `exits` map. */
export const exitKey = (town: { width: number }, gx: number, gy: number) => (gy + MARGIN) * (town.width + 2 * MARGIN) + gx + MARGIN;

/**
 * Ground geometry, one builder per CHUNK × CHUNK cells (the margin in the edge chunks).
 * `exits`: cells the roads out cross (exitKey → surface height), drawn as asphalt.
 */
export function buildGround(town: CompiledTown, exits: ReadonlyMap<number, number> = new Map()): GeoBuilder[] {
  const { width, height } = town;
  const groundH = (x: number, y: number) => exits.get(exitKey(town, x, y)) ?? cellY(town, x, y);
  const agentLot = new Uint8Array(width * height);
  for (const l of town.agentLots) {
    const [lx, ly, lw, lh] = l.rect;
    for (let y = ly; y < ly + lh; y++) for (let x = lx; x < lx + lw; x++) agentLot[y * width + x] = 1;
  }
  const cols = Math.ceil(width / CHUNK);
  const rows = Math.ceil(height / CHUNK);
  const chunks: GeoBuilder[] = [];
  for (let i = 0; i < cols * rows; i++) chunks.push(new GeoBuilder());
  const chunkAt = (x: number, y: number) => chunks[Math.min(rows - 1, Math.max(0, Math.floor(y / CHUNK))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(x / CHUNK)))]!;
  const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const f = { width, height };

  for (let y = -MARGIN; y < height + MARGIN; y++) {
    for (let x = -MARGIN; x < width + MARGIN; x++) {
      const inside = x >= 0 && y >= 0 && x < width && y < height;
      const exit = exits.has(exitKey(town, x, y));
      const look = exit
        ? { top: scaleHex(G.asphalt, 0.99 + 0.02 * noise2(x, y)), side: G.asphaltDark }
        : inside
          ? lookOf(town, x, y, agentLot)
          : { top: scaleHex(G.grass, 0.97 + 0.06 * noise2(x, y)), side: G.soil };
      // Baked contact shade: ground beside a building or landmark is a little darker (cheap ambient occlusion).
      if (inside && !exit) {
        const ao = contactShade(town, x, y);
        if (ao > 0) look.top = scaleHex(look.top, 1 - ao);
      }
      const h = groundH(x, y);
      const gb = chunkAt(x, y);
      const x0 = sceneX(f, x) - 0.5;
      const x1 = x0 + 1;
      const z0 = sceneZ(f, y) - 0.5;
      const z1 = z0 + 1;
      gb.quad(v(x0, h, z1), v(x1, h, z1), v(x1, h, z0), v(x0, h, z0), look.top);
      // Side faces down to each lower neighbour (curbs, lawn edges, the pond bank).
      const sides: [number, number, Vector3, Vector3][] = [
        [x, y + 1, v(x0, 0, z1), v(x1, 0, z1)],
        [x + 1, y, v(x1, 0, z1), v(x1, 0, z0)],
        [x, y - 1, v(x1, 0, z0), v(x0, 0, z0)],
        [x - 1, y, v(x0, 0, z0), v(x0, 0, z1)],
      ];
      for (const [nx, ny, a, b] of sides) {
        // Beyond the margin the land continues (no slab edge): the terrain meets it there.
        const outside = nx < -MARGIN || ny < -MARGIN || nx >= width + MARGIN || ny >= height + MARGIN;
        if (outside) continue;
        const nh = groundH(nx, ny);
        if (nh >= h - 1e-4) continue;
        gb.quad(v(a.x, nh, a.z), v(b.x, nh, b.z), v(b.x, h, b.z), v(a.x, h, a.z), look.side);
      }
    }
  }
  return chunks;
}

/** Road paint: dashed centre lines on two-lane roads and zebra crossings (a separate, slightly raised layer). */
export function buildRoadPaint(town: CompiledTown): GeoBuilder {
  const gb = new GeoBuilder();
  const { width } = town;
  const f = { width, height: town.height };
  const g = town.raster.ground;
  const roadCount = new Uint8Array(width * town.height);
  for (const r of town.def.roads) {
    const [rx, ry, rw, rh] = r.rect;
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) roadCount[y * width + x]! += 1;
  }
  const y0 = 0.006;
  const plain = (x: number, y: number) => g[y * width + x] === GROUND.road && roadCount[y * width + x] === 1;
  const paint = new Color(G.laneMark);
  const v = (x: number, z: number) => new Vector3(x, y0, z);
  for (const r of town.def.roads) {
    const [rx, ry, rw, rh] = r.rect;
    if (rh === 2 && rw > 2) {
      // Horizontal: the centre line runs between rows ry and ry + 1.
      const z = sceneZ(f, ry) + 0.5;
      for (let x = rx; x < rx + rw; x++) {
        if (x % 2 || !plain(x, ry) || !plain(x, ry + 1)) continue;
        const cx = sceneX(f, x);
        gb.quad(v(cx - 0.42, z + 0.035), v(cx + 0.42, z + 0.035), v(cx + 0.42, z - 0.035), v(cx - 0.42, z - 0.035), paint);
      }
    } else if (rw === 2 && rh > 2) {
      const xx = sceneX(f, rx) + 0.5;
      for (let y = ry; y < ry + rh; y++) {
        if (y % 2 || !plain(rx, y) || !plain(rx + 1, y)) continue;
        const cz = sceneZ(f, y);
        gb.quad(v(xx - 0.035, cz + 0.42), v(xx + 0.035, cz + 0.42), v(xx + 0.035, cz - 0.42), v(xx - 0.035, cz - 0.42), paint);
      }
    }
  }
  const zebra = new Color(G.crosswalk);
  for (const xg of town.def.crossings) {
    const [cx, cy, cw, ch] = xg.rect;
    const xa = sceneX(f, cx) - 0.5;
    const xb = sceneX(f, cx + cw - 1) + 0.5;
    const za = sceneZ(f, cy) - 0.5;
    const zb = sceneZ(f, cy + ch - 1) + 0.5;
    if (ch >= cw) {
      // People walk north–south: bars run east–west, stepped along z.
      const n = ch * 3;
      for (let i = 0; i < n; i++) {
        const z = za + ((i + 0.5) / n) * (zb - za);
        gb.quad(v(xa + 0.1, z + 0.09), v(xb - 0.1, z + 0.09), v(xb - 0.1, z - 0.09), v(xa + 0.1, z - 0.09), zebra);
      }
    } else {
      const n = cw * 3;
      for (let i = 0; i < n; i++) {
        const x = xa + ((i + 0.5) / n) * (xb - xa);
        gb.quad(v(x - 0.09, zb - 0.1), v(x + 0.09, zb - 0.1), v(x + 0.09, za + 0.1), v(x - 0.09, za + 0.1), zebra);
      }
    }
  }
  return gb;
}

/** The pond's water surface sits in its basin; a slightly lighter rim reads as the shallows. */
export function waterLevel(): number {
  return SURFACE_Y[GROUND.water]! + 0.06;
}

/** Water surface quads (separate material: a soft sheen). */
export function buildWater(town: CompiledTown): GeoBuilder {
  const gb = new GeoBuilder();
  const f = { width: town.width, height: town.height };
  const y = waterLevel();
  for (let gy = 0; gy < town.height; gy++) {
    for (let gx = 0; gx < town.width; gx++) {
      if (town.raster.ground[gy * town.width + gx] !== GROUND.water) continue;
      const x0 = sceneX(f, gx) - 0.5;
      const z0 = sceneZ(f, gy) - 0.5;
      const edge = [
        [gx, gy - 1],
        [gx + 1, gy],
        [gx, gy + 1],
        [gx - 1, gy],
      ].some(([nx, ny]) => town.raster.ground[ny! * town.width + nx!] !== GROUND.water);
      const c = edge ? mixHex(G.water, '#ffffff', 0.12) : noise2(gx, gy, 3) < 0.5 ? G.water : G.waterDeep;
      gb.quad(new Vector3(x0, y, z0 + 1), new Vector3(x0 + 1, y, z0 + 1), new Vector3(x0 + 1, y, z0), new Vector3(x0, y, z0), c);
    }
  }
  return gb;
}
