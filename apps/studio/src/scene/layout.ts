import type { Incident } from '@runloop-world/core';
import type { RunState } from '@runloop-world/replay';
import {
  bfs,
  gridToScene,
  matchActivityRule,
  type Cell,
  type CompiledWorld,
  type Station,
  type Zone,
} from '@runloop-world/world-engine';

/**
 * Pure layout helpers: everything the scene draws is derived from the world
 * definition here (no hard-coded map). Grid space: x = column, y = row.
 */

/** Top of corridor floor tiles. */
export const FLOOR_Y = 0.06;
/** Top of raised room floors. */
export const ROOM_Y = 0.16;
/** Height of a back (north/west) room wall above the room floor. */
export const BACK_WALL_H = 1.3;
/** Height of a front (south/east) curb above the room floor. */
export const CURB_H = 0.26;

const DIRS: readonly Cell[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const key = (x: number, y: number) => `${x},${y}`;

const inRect = (z: Zone, x: number, y: number) =>
  x >= z.rect[0] && y >= z.rect[1] && x < z.rect[0] + z.rect[2] && y < z.rect[1] + z.rect[3];

/** The room (non-hub zone) containing a cell, if any. */
export function roomAt(world: CompiledWorld, x: number, y: number): Zone | null {
  for (const z of world.def.zones) if (z.kind !== 'hub' && inRect(z, x, y)) return z;
  return null;
}

/** The zone (hub included) containing a cell, if any. */
export function zoneAt(world: CompiledWorld, x: number, y: number): Zone | null {
  return world.def.zones.find((z) => inRect(z, x, y)) ?? null;
}

export const isWall = (world: CompiledWorld, x: number, y: number) => world.def.grid[y]?.[x] === '#';

/** Floor height of a cell (rooms are raised platforms). */
export function cellTop(world: CompiledWorld, x: number, y: number): number {
  return roomAt(world, x, y) ? ROOM_Y : FLOOR_Y;
}

const smooth = (t: number) => {
  const s = Math.min(1, Math.max(0, (t - 0.3) / 0.4));
  return s * s * (3 - 2 * s);
};

/** Floor height at a continuous grid position (steps up/down at the cell boundary). */
export function heightAt(world: CompiledWorld, gx: number, gy: number): number {
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const h = (x: number, y: number) => cellTop(world, Math.min(world.width - 1, x), Math.min(world.height - 1, y));
  const top = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * smooth(fx);
  const bottom = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * smooth(fx);
  return top + (bottom - top) * smooth(fy);
}

/** Scene position [x, y, z] of a (continuous) grid position at height y. */
export function toScene(world: CompiledWorld, gx: number, gy: number, y = 0): [number, number, number] {
  const p = gridToScene(gx, gy, world);
  return [p.x, y, p.z];
}

export interface WallCell {
  cell: Cell;
  /** 'back' = tall wall on a room's north/west edge; 'curb' = low wall elsewhere (cutaway). */
  kind: 'back' | 'curb';
  /** Room the wall belongs to (null for free-standing walls). */
  zone: Zone | null;
  /** Which edge of the room it sits on (back walls get panels on their inner face). */
  side: 'n' | 'w' | 's' | 'e' | null;
}

/** Classify every '#' cell for a cutaway look from the south-east. */
export function classifyWalls(world: CompiledWorld): WallCell[] {
  const out: WallCell[] = [];
  world.def.grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      const zone = roomAt(world, x, y);
      if (!zone) {
        out.push({ cell: [x, y], kind: 'curb', zone: null, side: null });
        continue;
      }
      const [rx, ry, rw, rh] = zone.rect;
      const side = y === ry ? 'n' : x === rx ? 'w' : y === ry + rh - 1 ? 's' : x === rx + rw - 1 ? 'e' : null;
      out.push({ cell: [x, y], kind: side === 'n' || side === 'w' ? 'back' : 'curb', zone, side });
    }
  });
  return out;
}

export interface FloorTile {
  cell: Cell;
  zone: Zone | null;
  top: number;
}

/** One tile per non-wall cell (stations, props and the hub core stand on tiles). */
export function floorTiles(world: CompiledWorld): FloorTile[] {
  const out: FloorTile[] = [];
  world.def.grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') continue;
      out.push({ cell: [x, y], zone: zoneAt(world, x, y), top: cellTop(world, x, y) });
    }
  });
  return out;
}

export interface GlowPath {
  key: string;
  color: string;
  cells: Cell[];
  /** Branches run from a room door to its stations (drawn fainter). */
  branch: boolean;
}

/** Walkable cells around the hub core, in a fixed order. */
export function hubRing(world: CompiledWorld): Cell[] {
  const core = world.def.hub.core;
  const coreSet = new Set(core.map(([x, y]) => key(x, y)));
  const seen = new Set<string>();
  const ring: Cell[] = [];
  for (const [cx, cy] of core) {
    for (const [dx, dy] of DIRS) {
      const x = cx + dx;
      const y = cy + dy;
      const k = key(x, y);
      if (coreSet.has(k) || seen.has(k) || !world.isWalkable(x, y)) continue;
      seen.add(k);
      ring.push([x, y]);
    }
  }
  if (ring.length === 0) {
    const c: Cell = [Math.round(world.def.hub.center[0]), Math.round(world.def.hub.center[1])];
    if (world.isWalkable(c[0], c[1])) ring.push(c);
  }
  return ring;
}

/**
 * Conveyor-like glow paths: hub → each room door, hub → stations in rooms
 * without a door (e.g. the gate), and door → each station in that room.
 */
export function glowPaths(world: CompiledWorld): GlowPath[] {
  const ring = hubRing(world);
  const out: GlowPath[] = [];
  const shortestFromHub = (to: Cell): Cell[] | null => {
    let best: Cell[] | null = null;
    for (const start of ring) {
      const p = bfs(world, start, to);
      if (p && (!best || p.length < best.length)) best = p;
    }
    return best;
  };

  for (const zone of world.def.zones) {
    if (zone.kind === 'hub' || !zone.door) continue;
    const main = shortestFromHub(zone.door);
    if (main) out.push({ key: `hub>${zone.id}`, color: zone.color, cells: [...main], branch: false });
    for (const s of world.def.stations) {
      if (s.zoneId !== zone.id) continue;
      const p = bfs(world, zone.door, s.slots[0]!);
      if (p && p.length > 1) out.push({ key: `${zone.id}>${s.id}`, color: zone.color, cells: [...p], branch: true });
    }
  }
  for (const s of world.def.stations) {
    const zone = world.zonesById[s.zoneId];
    if (zone && zone.kind !== 'hub' && zone.door) continue;
    const p = shortestFromHub(s.slots[0]!);
    if (p) out.push({ key: `hub>${s.id}`, color: zone?.color ?? '#f59e0b', cells: [...p], branch: false });
  }
  return out;
}

/**
 * Scene-space polyline for a path of cells, `lift` above the floor. Height
 * changes (corridor ↔ room) become a vertical riser at the cell boundary.
 */
export function pathPoints(world: CompiledWorld, cells: readonly Cell[], lift: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  cells.forEach((c, i) => {
    const h = cellTop(world, c[0], c[1]) + lift;
    if (i > 0) {
      const prev = cells[i - 1]!;
      const hp = cellTop(world, prev[0], prev[1]) + lift;
      if (hp !== h) {
        const mx = (prev[0] + c[0]) / 2;
        const my = (prev[1] + c[1]) / 2;
        pts.push(toScene(world, mx, my, hp), toScene(world, mx, my, h));
      }
    }
    pts.push(toScene(world, c[0], c[1], h));
  });
  return pts;
}

const FACING: Record<Station['facing'], Cell> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** Grid direction a station's front faces (towards its first slot; falls back to `facing`). */
export function stationFront(s: Station): Cell {
  const slot = s.slots[0]!;
  const dx = slot[0] - s.cell[0];
  const dy = slot[1] - s.cell[1];
  if (Math.abs(dx) + Math.abs(dy) === 1) return [dx, dy];
  return FACING[s.facing];
}

/** Y rotation that turns a model whose front is +z towards a grid direction. */
export const yawFor = (dx: number, dy: number) => Math.atan2(dx, dy);

/** Y rotation for a world-engine heading (radians in grid space, 0 = +x, π/2 = +y). */
export const yawForHeading = (heading: number) => Math.atan2(Math.cos(heading), Math.sin(heading));

export function stationColor(world: CompiledWorld, s: Station): string {
  return world.zonesById[s.zoneId]?.color ?? '#f59e0b';
}

/**
 * Station an incident marker belongs to. Prefers the station the agent was
 * working at for that task (remembered in `cache`), else the first station
 * the activity rules map the task kind to.
 */
export function incidentStationId(
  world: CompiledWorld,
  state: RunState,
  inc: Incident,
  cache: Map<string, string>,
): string | null {
  const hit = cache.get(inc.eventId);
  if (hit) return hit;
  const ch = inc.agentId ? state.world.characters[inc.agentId] : undefined;
  if (ch && ch.stationId && (inc.taskId === null || ch.taskId === inc.taskId)) {
    cache.set(inc.eventId, ch.stationId);
    return ch.stationId;
  }
  const task = inc.taskId ? state.exec.tasks[inc.taskId] : undefined;
  if (!task) return null;
  const kind = matchActivityRule(world.def.activityRules, { taskKind: task.kind, permission: false });
  return (kind && world.stationsByKind[kind]?.[0]?.id) || null;
}

/** Cheap deterministic per-cell noise in [0, 1). */
export function cellNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
