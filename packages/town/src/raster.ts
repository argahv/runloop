/**
 * The town's ground raster, painted in the layering documented in schema.ts.
 * `paintGround` reports what it cannot paint (out of bounds, a lot on a road,
 * a front walk leaving its lot…) so compileTown can list every problem.
 */
import { interiorToTown, rotatedSize, step } from './frame';
import type { Cell, InteriorDefinition, Rect, TownDefinition } from './schema';

/** Ground codes of the raster, one byte per cell. */
export const GROUND = {
  grass: 0,
  road: 1,
  sidewalk: 2,
  crosswalk: 3,
  plaza: 4,
  path: 5,
  park: 6,
  garden: 7,
  water: 8,
  lot: 9,
  footprint: 10,
  door: 11,
  landmark: 12,
} as const;
export type GroundCode = (typeof GROUND)[keyof typeof GROUND];
export const WALKABLE_GROUND: readonly GroundCode[] = [GROUND.sidewalk, GROUND.crosswalk, GROUND.plaza, GROUND.path, GROUND.door];
const WALKABLE = new Set<number>(WALKABLE_GROUND);

export function isWalkableGround(code: number): boolean {
  return WALKABLE.has(code);
}

export interface TownRaster {
  width: number;
  height: number;
  /** GROUND code per cell, row-major (index = y·width + x). */
  ground: Uint8Array;
}

/** Every cell of a rect, row by row. */
export function rectCells([x, y, w, h]: Rect): Cell[] {
  const out: Cell[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]);
  return out;
}

export function inRect([x, y]: readonly [number, number], [rx, ry, rw, rh]: Rect): boolean {
  return x >= rx && y >= ry && x < rx + rw && y < ry + rh;
}

/** The 1-cell sidewalk rect on `side` of a road rect. */
export function sidewalkRect([x, y, w, h]: Rect, side: 'n' | 'e' | 's' | 'w'): Rect {
  return side === 'n' ? [x, y - 1, w, 1] : side === 's' ? [x, y + h, w, 1] : side === 'w' ? [x - 1, y, 1, h] : [x + w, y, 1, h];
}

/** The door cell of a grid interior (its single 'D'), or null. */
export function interiorDoor(interior: InteriorDefinition): Cell | null {
  if (interior.kind !== 'grid') return null;
  for (let y = 0; y < interior.grid.length; y++) {
    const x = interior.grid[y]!.indexOf('D');
    if (x >= 0) return [x, y];
  }
  return null;
}

/** [w, h] of an interior as authored (facing south). */
export function interiorSize(interior: InteriorDefinition): [number, number] {
  return interior.kind === 'grid' ? [interior.grid[0]!.length, interior.grid.length] : [interior.size[0], interior.size[1]];
}

/** Where a building's door must be: its interior's D, rotated into the footprint. */
export function expectedDoor(b: TownDefinition['buildings'][number], interior: InteriorDefinition): Cell | null {
  const d = interiorDoor(interior);
  return d ? interiorToTown(d, interiorSize(interior), [b.footprint[0], b.footprint[1]], b.facing) : null;
}

export interface PaintResult {
  raster: TownRaster;
  /** Front-walk path cells painted for each building (inside its lot). */
  walks: Map<string, Cell[]>;
  /** Cells that are asphalt (roads), crosswalks included. */
  road: Uint8Array;
  problems: string[];
}

/** Paint the ground (schema.ts layering). Never throws; problems are returned. */
export function paintGround(def: TownDefinition, interiors: Readonly<Record<string, InteriorDefinition>>): PaintResult {
  const [width, height] = def.size;
  const ground = new Uint8Array(width * height); // grass
  const road = new Uint8Array(width * height);
  const problems: string[] = [];
  const inBounds = ([x, y]: Cell) => x >= 0 && y >= 0 && x < width && y < height;
  const at = ([x, y]: Cell) => ground[y * width + x]!;
  const paint = (rect: Rect, code: number, label: string) => {
    for (const c of rectCells(rect)) {
      if (!inBounds(c)) {
        problems.push(`${label}: cell ${c} is out of bounds`);
        continue;
      }
      ground[c[1] * width + c[0]] = code;
    }
  };

  // 2. Areas: park and garden, then plaza and path, then water.
  const areaCode = { park: GROUND.park, garden: GROUND.garden, plaza: GROUND.plaza, path: GROUND.path, water: GROUND.water } as const;
  for (const kinds of [['park', 'garden'], ['plaza', 'path'], ['water']] as const) {
    for (const a of def.areas) if ((kinds as readonly string[]).includes(a.kind)) paint(a.rect, areaCode[a.kind], a.id);
  }
  // 3. Sidewalks, 4. roads.
  for (const r of def.roads) for (const side of r.sidewalks) paint(sidewalkRect(r.rect, side), GROUND.sidewalk, `${r.id} sidewalk ${side}`);
  for (const r of def.roads) {
    paint(r.rect, GROUND.road, r.id);
    for (const c of rectCells(r.rect)) if (inBounds(c)) road[c[1] * width + c[0]] = 1;
  }
  // 5. Crossings: on a road, both ends meeting a walkable cell.
  for (const xg of def.crossings) {
    for (const c of rectCells(xg.rect)) if (inBounds(c) && !road[c[1] * width + c[0]]) problems.push(`${xg.id}: cell ${c} is not on a road`);
    paint(xg.rect, GROUND.crosswalk, xg.id);
  }
  for (const xg of def.crossings) {
    const [x, y, w, h] = xg.rect;
    const ends: Cell[] = h > w ? [[x, y - 1], [x, y + h]] : w > h ? [[x - 1, y], [x + w, y]] : [];
    for (const e of ends) {
      if (!inBounds(e) || !(at(e) === GROUND.sidewalk || at(e) === GROUND.crosswalk || at(e) === GROUND.plaza)) {
        problems.push(`${xg.id}: its end ${e} does not meet a sidewalk`);
      }
    }
  }
  // 6. Lots (never on a road, sidewalk or crossing, never overlapping).
  const lotAt = new Map<number, string>();
  for (const lot of def.lots) {
    for (const c of rectCells(lot.rect)) {
      if (!inBounds(c)) {
        problems.push(`${lot.id}: cell ${c} is out of bounds`);
        continue;
      }
      const i = c[1] * width + c[0];
      if (lotAt.has(i)) problems.push(`${lot.id}: overlaps ${lotAt.get(i)} at ${c}`);
      const g = ground[i]!;
      if (g === GROUND.road || g === GROUND.sidewalk || g === GROUND.crosswalk) problems.push(`${lot.id}: lies on a road or sidewalk at ${c}`);
      lotAt.set(i, lot.id);
      ground[i] = GROUND.lot;
    }
  }
  // 7. Footprints and doors, 8. front walks.
  const lots = new Map(def.lots.map((l) => [l.id, l]));
  const footprintOf = new Map<number, string>();
  const walks = new Map<string, Cell[]>();
  for (const b of def.buildings) {
    const lot = lots.get(b.lotId);
    const interior = interiors[b.interior];
    if (!lot) problems.push(`${b.id}: unknown lot ${b.lotId}`);
    else {
      if (lot.use !== 'building') problems.push(`${b.id}: stands on ${lot.id}, which is reserved for an agent`);
      if (b.facing !== lot.frontage) problems.push(`${b.id}: faces ${b.facing} but ${lot.id} fronts ${lot.frontage}`);
      for (const c of rectCells(b.footprint)) if (!inRect(c, lot.rect)) problems.push(`${b.id}: footprint leaves ${lot.id} at ${c}`);
    }
    if (!interior) problems.push(`${b.id}: unknown interior ${b.interior}`);
    else if (interior.kind !== 'grid') problems.push(`${b.id}: interior ${b.interior} is not a grid interior`);
    else {
      const size = rotatedSize(interiorSize(interior), b.facing);
      if (b.footprint[2] !== size[0] || b.footprint[3] !== size[1]) {
        problems.push(`${b.id}: footprint ${b.footprint[2]}×${b.footprint[3]} is not its interior's ${size[0]}×${size[1]}`);
      }
      const want = expectedDoor(b, interior);
      if (want && (want[0] !== b.door[0] || want[1] !== b.door[1])) problems.push(`${b.id}: door ${b.door} is not where the interior's D lands (${want})`);
    }
    if (!inRect(b.door, b.footprint)) problems.push(`${b.id}: door ${b.door} is outside its footprint`);
    for (const c of rectCells(b.footprint)) {
      if (!inBounds(c)) continue;
      const i = c[1] * width + c[0];
      if (footprintOf.has(i)) problems.push(`${b.id}: overlaps ${footprintOf.get(i)} at ${c}`);
      footprintOf.set(i, b.id);
      ground[i] = GROUND.footprint;
    }
    if (inBounds(b.door)) ground[b.door[1] * width + b.door[0]] = GROUND.door;
  }
  for (const b of def.buildings) {
    const lot = lots.get(b.lotId);
    if (!lot || !inBounds(b.door)) continue;
    const walk: Cell[] = [];
    let c = step(b.door, b.facing);
    while (inBounds(c) && !isWalkableGround(at(c))) {
      if (!inRect(c, lot.rect) || inRect(c, b.footprint) || at(c) !== GROUND.lot) {
        problems.push(`${b.id}: its front walk leaves ${lot.id} at ${c}`);
        break;
      }
      ground[c[1] * width + c[0]] = GROUND.path;
      walk.push(c);
      c = step(c, b.facing);
    }
    if (!inBounds(c)) problems.push(`${b.id}: its front walk runs off the map`);
    walks.set(b.id, walk);
  }
  // 9. Landmarks (on a plaza; they block walking).
  for (const lm of def.landmarks) {
    for (const c of rectCells(lm.rect)) {
      if (!inBounds(c)) {
        problems.push(`${lm.id}: cell ${c} is out of bounds`);
        continue;
      }
      if (at(c) !== GROUND.plaza) problems.push(`${lm.id}: cell ${c} is not on a plaza`);
      ground[c[1] * width + c[0]] = GROUND.landmark;
    }
  }
  return { raster: { width, height, ground }, walks, road, problems };
}
