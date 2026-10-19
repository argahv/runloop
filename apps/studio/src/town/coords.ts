/**
 * Town grid ↔ scene space. One cell is one scene unit. Grid x = column (east),
 * y = row (south); cell centres are integers (as in world-engine's positionAt).
 * Scene: +x east, +y up, +z south, the town centred on the origin.
 */
import type { CompiledTown } from '@runloop-world/town';
import { GROUND } from '@runloop-world/town';

export interface GridFrame {
  width: number;
  height: number;
}

export const sceneX = (f: GridFrame, gx: number) => gx - (f.width - 1) / 2;
export const sceneZ = (f: GridFrame, gy: number) => gy - (f.height - 1) / 2;
export const gridX = (f: GridFrame, x: number) => x + (f.width - 1) / 2;
export const gridY = (f: GridFrame, z: number) => z + (f.height - 1) / 2;

/** Surface heights by ground code (scene units). Roads are the datum; curbs, lawns and plazas stand a little above. */
export const SURFACE_Y: Record<number, number> = {
  [GROUND.grass]: 0.08,
  [GROUND.road]: 0,
  [GROUND.sidewalk]: 0.1,
  [GROUND.crosswalk]: 0.004,
  [GROUND.plaza]: 0.1,
  [GROUND.path]: 0.085,
  [GROUND.park]: 0.08,
  [GROUND.garden]: 0.09,
  [GROUND.water]: -0.14,
  [GROUND.lot]: 0.085,
  [GROUND.footprint]: 0.1,
  [GROUND.door]: 0.1,
  [GROUND.landmark]: 0.1,
};

/** One storey of a building (a resident is 0.95 tall). */
export const STOREY = 1.7;
/** Grass margin drawn around the map (cells). */
export const MARGIN = 2;

/** Surface height of a cell (out of bounds: grass). */
export function cellY(town: CompiledTown, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= town.width || y >= town.height) return SURFACE_Y[GROUND.grass]!;
  return SURFACE_Y[town.raster.ground[y * town.width + x]!] ?? 0.08;
}

/** Height a walker's feet are at, smoothed across curbs (continuous grid position). */
export function walkY(town: CompiledTown, gx: number, gy: number): number {
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = smooth(gx - x0);
  const fy = smooth(gy - y0);
  const a = cellY(town, x0, y0);
  const b = cellY(town, x0 + 1, y0);
  const c = cellY(town, x0, y0 + 1);
  const d = cellY(town, x0 + 1, y0 + 1);
  // Water and lawns are never walked on; treat them like the curb so a lane offset never dips a walker.
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return Math.max(0, top + (bottom - top) * fy);
}

function smooth(t: number): number {
  const s = Math.min(1, Math.max(0, (t - 0.35) / 0.3));
  return s * s * (3 - 2 * s);
}

/** Yaw (about +y) that turns a model facing +z towards grid direction (dx, dy). */
export const yawOf = (dx: number, dy: number) => Math.atan2(dx, dy);
