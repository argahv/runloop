/**
 * Where each resident is drawn, from the engine's state only (pure): walking
 * along its recorded route (closed-form, `positionAt` from world-engine), at
 * an outdoor spot's cell, or at a furniture slot inside a building. Nothing
 * here decides anything; it only reads ResidentState.
 *
 * Grid coordinates: x = column, y = row, cell centres are integers.
 * Headings are grid directions [dx, dy] (dy > 0 = south).
 */
import type { ResidentState } from '@runloop-world/events';
import { GROUND, interiorSize, interiorToTown, rotateDir, type CompiledTown, type Dir, type FurnitureKind, type GridInterior } from '@runloop-world/town';
import { ANIM, type AnimId } from './rig/residentRig';

export interface SlotPlace {
  gx: number;
  gy: number;
  /** Facing as a grid direction. */
  dx: number;
  dy: number;
  pose: 'sit' | 'stand' | 'sleep';
  floor: number;
  furniture: FurnitureKind | null;
}

export interface ResidentPose {
  gx: number;
  gy: number;
  dx: number;
  dy: number;
  anim: AnimId;
  /** Inside this building (drawn only when it is the focused interior), or null outdoors. */
  inside: string | null;
  floor: number;
  walking: boolean;
}

const DIR_VEC: Record<Dir, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const DIRS4: readonly [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

/** Precomputed slot positions for one town (outdoor spot cells and every interior slot). */
export class TownPlaces {
  private readonly spotSlots = new Map<string, SlotPlace>();
  private readonly buildingSlots = new Map<string, Map<string, SlotPlace>>();
  /** Cells per sim minute (the town's walking speed). */
  readonly cellsPerTick: number;

  constructor(readonly town: CompiledTown) {
    this.cellsPerTick = town.def.walkCellsPerMinute;
    for (const s of town.spots) {
      const cells = s.def.cells;
      const cx = cells.reduce((n, c) => n + c[0], 0) / cells.length;
      const cy = cells.reduce((n, c) => n + c[1], 0) / cells.length;
      cells.forEach((c, i) => {
        const [dx, dy] = spotFacing(town, s.def.kind, s.def.pose, c, [cx, cy], new Set(s.cellIndex));
        this.spotSlots.set(`${s.def.id}#${i}`, { gx: c[0], gy: c[1], dx, dy, pose: s.def.pose, floor: 0, furniture: null });
      });
    }
  }

  /** A building's slots, keyed by slot id (built on first use). */
  slotsOf(buildingId: string): Map<string, SlotPlace> {
    let m = this.buildingSlots.get(buildingId);
    if (m) return m;
    m = new Map();
    this.buildingSlots.set(buildingId, m);
    const b = this.town.buildingById.get(buildingId);
    const interior = b ? this.town.interiors[b.def.interior] : undefined;
    if (!b || !interior || interior.kind !== 'grid') return m;
    const size = interiorSize(interior);
    const origin: [number, number] = [b.def.footprint[0], b.def.footprint[1]];
    for (const f of interior.furniture) {
      f.uses.forEach((u, ui) => {
        const [gx, gy] = interiorToTown(u.cell, size, origin, b.def.facing);
        const dir = u.facing ?? towardFurniture(u.cell, f.cells);
        const [dx, dy] = DIR_VEC[rotateDir(dir, b.def.facing)];
        for (let floor = 0; floor < b.def.floors; floor++) {
          m!.set(`${f.id}#${ui}@${floor}`, { gx, gy, dx, dy, pose: u.pose, floor, furniture: f.kind });
        }
      });
    }
    return m;
  }

  spotSlot(slotId: string): SlotPlace | undefined {
    return this.spotSlots.get(slotId);
  }

  /** The door cell of a building, inside the footprint. */
  door(buildingId: string): [number, number] | null {
    const b = this.town.buildingById.get(buildingId);
    return b ? [b.def.door[0], b.def.door[1]] : null;
  }

  /** Where a resident is at `tick` (fractional), or null when the state gives no position. */
  pose(r: ResidentState, tick: number): ResidentPose | null {
    const out: ResidentPose = { gx: 0, gy: 0, dx: 0, dy: 1, anim: ANIM.idle, inside: null, floor: 0, walking: false };
    return this.poseInto(r, tick, out) ? out : null;
  }

  /**
   * The same, written into `out` without allocating (the renderer calls it for every resident every frame).
   * Walks follow world-engine's positionAt closed form (one cell per 1/cellsPerTick ticks); returns false when
   * the state gives no position.
   */
  poseInto(r: ResidentState, tick: number, out: ResidentPose): boolean {
    out.inside = null;
    out.floor = 0;
    out.walking = false;
    const motion = r.motion;
    if (motion) {
      const path = motion.path;
      const last = path.length - 1;
      const steps = Math.max(0, tick - motion.startTick) * this.cellsPerTick;
      if (steps >= last - 1e-9) {
        const a = path[Math.max(0, last - 1)]!;
        const b = path[last]!;
        out.gx = b[0];
        out.gy = b[1];
        out.dx = b[0] - a[0];
        out.dy = b[1] - a[1];
        if (out.dx === 0 && out.dy === 0) out.dy = 1;
        out.anim = ANIM.idle;
        return true;
      }
      const i = Math.floor(steps);
      const frac = steps - i;
      const a = path[i]!;
      const b = path[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      // Walkers keep to the right of their direction of travel, so two-way traffic passes instead of overlapping.
      const lane = laneOffset(r.idx);
      out.gx = a[0] + dx * frac - dy * lane;
      out.gy = a[1] + dy * frac + dx * lane;
      out.dx = dx;
      out.dy = dy;
      out.anim = ANIM.walk;
      out.walking = true;
      return true;
    }
    if (r.place.kind === 'outdoor') {
      const s = r.slotId ? this.spotSlots.get(r.slotId) : undefined;
      if (!s) return false;
      const k = s.pose === 'sit' ? 0.08 : 0.16;
      out.gx = s.gx + (hashIdx(r.idx, 1) - 0.5) * 2 * k;
      out.gy = s.gy + (hashIdx(r.idx, 2) - 0.5) * 2 * k;
      out.dx = s.dx;
      out.dy = s.dy;
      out.anim = animFor(r.action, s.pose, null);
      return true;
    }
    const id = r.place.buildingId;
    out.inside = id;
    const s = r.slotId ? this.slotsOf(id).get(r.slotId) : undefined;
    if (s) {
      out.gx = s.gx;
      out.gy = s.gy;
      out.dx = s.dx;
      out.dy = s.dy;
      out.anim = animFor(r.action, s.pose, s.furniture);
      out.floor = s.floor;
      return true;
    }
    // Inside without a slot: just past the door.
    const b = this.town.buildingById.get(id);
    if (!b) return false;
    const [fx, fy] = DIR_VEC[b.def.facing];
    out.gx = b.def.door[0] - fx;
    out.gy = b.def.door[1] - fy;
    out.dx = -fx;
    out.dy = -fy;
    out.anim = ANIM.idle;
    return true;
  }
}

/** The animation for an action held at a slot. */
export function animFor(action: ResidentState['action'], pose: SlotPlace['pose'], furniture: FurnitureKind | null): AnimId {
  if (pose === 'sleep' || action === 'sleep') return pose === 'sleep' ? ANIM.sleep : ANIM.sit;
  if (pose === 'sit') {
    if (action === 'work') return ANIM.deskwork;
    if (action === 'socialize' || action === 'eat') return furniture === 'bed' || furniture === 'double_bed' ? ANIM.sit : ANIM.sittalk;
    return ANIM.sit;
  }
  if (action === 'work') return ANIM.work;
  if (action === 'socialize') return ANIM.talk;
  return ANIM.idle;
}

/** The furniture side a use faces when the file does not say (towards its nearest furniture cell). */
function towardFurniture(cell: readonly [number, number], cells: readonly (readonly [number, number])[]): Dir {
  let best: Dir = 's';
  let bestD = Infinity;
  for (const c of cells) {
    const dx = c[0] - cell[0];
    const dy = c[1] - cell[1];
    const d = Math.abs(dx) + Math.abs(dy);
    if (d === 0 || d >= bestD) continue;
    bestD = d;
    best = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
  }
  return best;
}

/**
 * Which way someone at an outdoor spot cell faces: towards the board or the
 * stall at boards and stalls; away from what they sit on (the open side) on
 * benches, steps and fountain rims; towards the group elsewhere.
 */
function spotFacing(
  town: CompiledTown,
  kind: string,
  pose: 'sit' | 'stand',
  [x, y]: readonly [number, number],
  [cx, cy]: readonly [number, number],
  own: ReadonlySet<number>,
): [number, number] {
  const w = town.width;
  const inMap = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < w && ny < town.height;
  const walk = (nx: number, ny: number) => inMap(nx, ny) && town.walkable[ny * w + nx] === 1;
  const groundAt = (nx: number, ny: number) => (inMap(nx, ny) ? town.raster.ground[ny * w + nx]! : -1);
  if (kind === 'board' || kind === 'stall') {
    // Towards the nearest landmark cell (the board), else the nearest blocked cell straight ahead (the stall's truck).
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < bestD && groundAt(x + dx, y + dy) === GROUND.landmark) {
          bestD = d;
          best = [dx / d, dy / d];
        }
      }
    }
    if (best) return best;
    for (let r = 1; r <= 3; r++) for (const [dx, dy] of DIRS4) if (inMap(x + dx * r, y + dy * r) && !walk(x + dx * r, y + dy * r)) return [dx, dy];
  }
  if (kind === 'patio') return [x % 2 === 0 ? 1 : -1, 0];
  if (pose === 'sit') {
    // Benches by the pond face the water.
    for (const [dx, dy] of DIRS4) if (groundAt(x + dx, y + dy) === GROUND.water) return [dx, dy];
    // Prefer an open walkable side that is not another seat; DIRS4 lists south and east first (towards the default camera).
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (walk(nx, ny) && !own.has(ny * w + nx) && !walk(x - dx, y - dy)) return [dx, dy];
    }
    for (const [dx, dy] of DIRS4) if (walk(x + dx, y + dy) && !own.has((y + dy) * w + x + dx)) return [dx, dy];
  }
  const vx = cx - x;
  const vy = cy - y;
  if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return [0, 1];
  const n = Math.hypot(vx, vy);
  return [vx / n, vy / n];
}

/** Small per-resident offsets (deterministic), so a crowd is not on a grid. */
function hashIdx(i: number, salt: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Right-hand lane offset for a walker (cells), 0.16–0.28. */
export function laneOffset(idx: number): number {
  return 0.16 + 0.12 * hashIdx(idx, 3);
}

/** A per-resident animation phase (radians). */
export function residentPhase(idx: number): number {
  return hashIdx(idx, 4) * Math.PI * 2;
}

/** The town building that holds a grid interior (and its interior), for interior views. */
export function gridInteriorOf(town: CompiledTown, buildingId: string): GridInterior | null {
  const b = town.buildingById.get(buildingId);
  const i = b ? town.interiors[b.def.interior] : undefined;
  return i && i.kind === 'grid' ? i : null;
}

/** Cells beyond an open interior, on the sides facing the camera, whose trees and props are hidden. */
const CUT_FRONT = 3;
const CUT_BACK = 1;

/**
 * The decoration cut while an interior is open: the building's footprint (or an
 * agent headquarters' lot, which its diorama covers) grown by CUT_FRONT cells
 * toward the camera and CUT_BACK elsewhere, so no tree stands in front of it.
 */
export function cutRect(town: CompiledTown, entered: string | null, camAz: number): [number, number, number, number] | null {
  if (!entered) return null;
  const rect = town.buildingById.get(entered)?.def.footprint ?? town.agentLots.find((l) => l.buildingId === entered)?.rect;
  if (!rect) return null;
  const [x, y, w, h] = rect;
  const cx = Math.sin(camAz);
  const cz = Math.cos(camAz);
  return [
    x - (cx < -0.2 ? CUT_FRONT : CUT_BACK),
    y - (cz < -0.2 ? CUT_FRONT : CUT_BACK),
    x + w + (cx > 0.2 ? CUT_FRONT : CUT_BACK),
    y + h + (cz > 0.2 ? CUT_FRONT : CUT_BACK),
  ];
}

