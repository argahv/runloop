/**
 * What the engine derives from the town once (memoized per compiled town):
 * schedules by minute, roles, needs thresholds, and the places each action
 * can happen at. Nothing here is state; the state is the snapshot.
 */
import { DAY_MINUTES, minuteOf, type CompiledBuilding, type CompiledSpot, type CompiledTown, type Role, type Schedule } from '@runloop-world/town';
import { NEED_SCALE, type ResidentAction } from '@runloop-world/events';

/** The town plus the world's seed: everything `step` reads besides the state. */
export interface SimWorld {
  town: CompiledTown;
  seed: number;
}

export interface ScheduleIndex {
  def: Schedule;
  /** Block index in force at each minute of the day. */
  blockAt: Uint8Array;
  /** 1 where a block starts. */
  boundary: Uint8Array;
}

/** A place an action can happen at: a building or an outdoor spot. */
export type PlaceDef = { kind: 'building'; id: string; b: CompiledBuilding } | { kind: 'spot'; id: string; s: CompiledSpot };

export interface SimIndex {
  town: CompiledTown;
  walkCellsPerMinute: number;
  schedules: ReadonlyMap<string, ScheduleIndex>;
  roles: ReadonlyMap<string, Role>;
  /** Wake thresholds in milli-points, [hunger, energy, social]. */
  thresholds: readonly [number, number, number];
  /**
   * Places outside home where each action can happen, in id order: spots
   * tagged with it, and public buildings with a slot for it (except stroll,
   * which is always outdoors).
   */
  placesFor: Readonly<Record<ResidentAction, readonly PlaceDef[]>>;
  place(id: string): PlaceDef | undefined;
}

const indexes = new WeakMap<CompiledTown, SimIndex>();

function indexSchedule(def: Schedule): ScheduleIndex {
  const blockAt = new Uint8Array(DAY_MINUTES);
  const boundary = new Uint8Array(DAY_MINUTES);
  def.blocks.forEach((b, i) => {
    const from = minuteOf(b.from);
    const len = (minuteOf(b.to) - from + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
    boundary[from] = 1;
    for (let m = 0; m < len; m++) blockAt[(from + m) % DAY_MINUTES] = i;
  });
  return { def, blockAt, boundary };
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function simIndex(town: CompiledTown): SimIndex {
  let ix = indexes.get(town);
  if (ix) return ix;
  const { def } = town;
  const places = new Map<string, PlaceDef>();
  for (const b of town.buildings) places.set(b.def.id, { kind: 'building', id: b.def.id, b });
  for (const s of town.spots) places.set(s.def.id, { kind: 'spot', id: s.def.id, s });
  const placesFor = {} as Record<ResidentAction, PlaceDef[]>;
  for (const a of ['sleep', 'rest', 'eat', 'work', 'socialize', 'stroll'] as const) {
    const list: PlaceDef[] = [];
    for (const p of places.values()) {
      if (p.kind === 'building') {
        // A stroll is a walk outdoors: indoor 'stroll' slots (shop shelves) are not stroll destinations.
        if (a !== 'stroll' && p.b.def.access === 'public' && p.b.slots.some((s) => s.tags.includes(a))) list.push(p);
      } else if (p.s.def.tags.includes(a)) list.push(p);
    }
    placesFor[a] = list.sort(byId);
  }
  ix = {
    town,
    walkCellsPerMinute: def.walkCellsPerMinute,
    schedules: new Map(def.schedules.map((s) => [s.id, indexSchedule(s)])),
    roles: new Map(def.roles.map((r) => [r.id, r])),
    thresholds: [def.needs[0].threshold * NEED_SCALE, def.needs[1].threshold * NEED_SCALE, def.needs[2].threshold * NEED_SCALE],
    placesFor,
    place: (id) => places.get(id),
  };
  indexes.set(town, ix);
  return ix;
}
