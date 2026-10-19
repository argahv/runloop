/**
 * Outdoor navigation (plan §0 Navigation): a raster grid with one BFS field
 * per target cell (a door or a spot cell). A field stores the distance from
 * every cell to the target and each cell's BFS-tree parent, so a walk is read
 * off by following parents: exactly `bfs(grid, target, from)` reversed
 * (world-engine's bfs explores N, E, S, W from the target the same way).
 * Fields are built lazily and memoized per compiled town.
 */
import type { CompiledTown } from './compile';
import type { Cell } from './schema';

/** Structurally the same as world-engine's Grid, so its bfs runs on the town. */
export interface TownGrid {
  readonly width: number;
  readonly height: number;
  isWalkable(x: number, y: number): boolean;
}

export interface NavField {
  /** Steps to the nearest target cell from every cell; -1 = unreachable. */
  dist: Int32Array;
  /** The next cell (index) toward the target; the target points at itself; -1 = unreachable. */
  parent: Int32Array;
}

const grids = new WeakMap<CompiledTown, TownGrid>();
const fields = new WeakMap<CompiledTown, Map<string, NavField>>();

/** Outdoor walkability for residents (agent lots excluded, P6). */
export function outdoorGrid(town: CompiledTown): TownGrid {
  let g = grids.get(town);
  if (!g) {
    const { width, height, walkable } = town;
    g = {
      width,
      height,
      isWalkable: (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && walkable[y * width + x] === 1,
    };
    grids.set(town, g);
  }
  return g;
}

/** Multi-source BFS over walkable cells from `seeds` (cell indexes), neighbours N, E, S, W. */
function buildField(town: CompiledTown, seeds: readonly number[]): NavField {
  const { width, height, walkable } = town;
  const dist = new Int32Array(width * height).fill(-1);
  const parent = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let tail = 0;
  for (const s of seeds) {
    if (dist[s] !== -1) continue;
    dist[s] = 0;
    parent[s] = s;
    queue[tail++] = s;
  }
  const next = [0, 0, 0, 0];
  for (let head = 0; head < tail; head++) {
    const cur = queue[head]!;
    const x = cur % width;
    const y = (cur - x) / width;
    const d = dist[cur]! + 1;
    // N, E, S, W (-1 = off the map)
    next[0] = y > 0 ? cur - width : -1;
    next[1] = x < width - 1 ? cur + 1 : -1;
    next[2] = y < height - 1 ? cur + width : -1;
    next[3] = x > 0 ? cur - 1 : -1;
    for (const n of next) {
      if (n < 0 || dist[n] !== -1 || walkable[n] !== 1) continue;
      dist[n] = d;
      parent[n] = cur;
      queue[tail++] = n;
    }
  }
  return { dist, parent };
}

/** The target cells (indexes) of a building id (its door), a slot id (`spot_x#2`) or a spot id (all its cells). */
export function targetCells(town: CompiledTown, target: string): number[] {
  const b = town.buildingById.get(target);
  if (b) return [b.doorIndex];
  const hash = target.indexOf('#');
  if (hash >= 0) {
    const spot = town.spotById.get(target.slice(0, hash));
    const i = Number(target.slice(hash + 1));
    const cell = spot?.cellIndex[i];
    if (cell !== undefined) return [cell];
  } else {
    const spot = town.spotById.get(target);
    if (spot) return [...spot.cellIndex];
  }
  throw new Error(`Unknown navigation target ${target}`);
}

/** The memoized field toward `target` (see targetCells). */
export function navField(town: CompiledTown, target: string): NavField {
  let byTarget = fields.get(town);
  if (!byTarget) fields.set(town, (byTarget = new Map()));
  let f = byTarget.get(target);
  if (!f) {
    f = buildField(town, targetCells(town, target));
    byTarget.set(target, f);
  }
  return f;
}

/** BFS steps to `target` (a building's door, a spot slot or a spot) from every cell; -1 = unreachable. */
export function distanceField(town: CompiledTown, target: string): Int32Array {
  return navField(town, target).dist;
}

/** Steps from cell index `from` to `target`, or -1. */
export function stepsTo(town: CompiledTown, from: number, target: string): number {
  return navField(town, target).dist[from] ?? -1;
}

/** The walk from `from` to `target` (both ends included), by following its field; null when unreachable. */
export function pathTo(town: CompiledTown, from: Cell, target: string): Cell[] | null {
  const { width, height } = town;
  if (from[0] < 0 || from[1] < 0 || from[0] >= width || from[1] >= height) return null;
  const { parent } = navField(town, target);
  let cur = from[1] * width + from[0];
  if (parent[cur] === -1) return null;
  const out: Cell[] = [];
  for (;;) {
    const x = cur % width;
    out.push([x, (cur - x) / width]);
    const next = parent[cur]!;
    if (next === cur) return out;
    cur = next;
  }
}

/** Cell index ↔ cell. */
export function cellIndex(town: CompiledTown, [x, y]: Cell): number {
  return y * town.width + x;
}
export function cellAt(town: CompiledTown, index: number): Cell {
  const x = index % town.width;
  return [x, (index - x) / town.width];
}
