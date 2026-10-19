/**
 * Occupancy (plan §0 Interiors: furniture uses are slots, no queues). Who
 * holds which slot is read off the state: a resident holds its `slotId` at
 * its place, or at its destination while walking. Beds and work places are
 * assigned per resident from the roster (k-th resident of a home gets its
 * k-th bed), so they never need a search and nobody else takes them.
 */
import { placeId, type Place, type ResidentAction, type ResidentState, type Tick } from '@runloop-world/events';
import { isOpenAt, type TownSlot } from '@runloop-world/town';
import type { SimState } from './apply';
import type { PlaceDef, SimIndex } from './world';

export interface Assignment {
  /** Bed slot at home (null if the home has too few beds). */
  bed: string | null;
  /** Work slot at workId (null when no workplace or no slot). */
  work: string | null;
}

const assignments = new WeakMap<readonly ResidentState[], { ix: SimIndex; list: Assignment[]; assigned: Map<string, Set<string>> }>();

/** Beds and work slots of every resident, and every assigned slot by place. */
export function assignmentsOf(ix: SimIndex, residents: readonly ResidentState[]) {
  const cached = assignments.get(residents);
  if (cached && cached.ix === ix && cached.list.length === residents.length) return cached;
  const list: Assignment[] = [];
  const assigned = new Map<string, Set<string>>();
  const rank = new Map<string, number>();
  const take = (place: string, slots: readonly TownSlot[], key: string): string | null => {
    const k = rank.get(key) ?? 0;
    rank.set(key, k + 1);
    const slot = slots[k];
    if (!slot) return null;
    let set = assigned.get(place);
    if (!set) assigned.set(place, (set = new Set()));
    set.add(slot.id);
    return slot.id;
  };
  for (const r of residents) {
    const home = ix.town.buildingById.get(r.homeId);
    const bed = home ? take(home.def.id, home.slots.filter((s) => s.tags.includes('sleep')), `bed:${home.def.id}`) : null;
    let work: string | null = null;
    const role = ix.roles.get(r.role);
    const wb = r.workId ? ix.town.buildingById.get(r.workId) : undefined;
    if (role?.work && wb) {
      const tag = role.work.tag ?? 'work';
      work = take(wb.def.id, wb.slots.filter((s) => s.tags.includes('work') && s.tags.includes(tag)), `work:${wb.def.id}:${tag}`);
    }
    list.push({ bed, work });
  }
  const out = { ix, list, assigned };
  assignments.set(residents, out);
  return out;
}

/** Where a resident is bound: its destination while walking, else its place (null = in transit with no destination). */
export function destinationOf(ix: SimIndex, r: ResidentState): string | null {
  if (r.motion) {
    const [x, y] = r.motion.path[r.motion.path.length - 1]!;
    const cell = y * ix.town.width + x;
    return ix.town.doorAt.get(cell) ?? ix.town.spotSlotAt.get(cell)?.spotId ?? null;
  }
  return placeId(r.place);
}

export function placeOf(def: PlaceDef): Place {
  return def.kind === 'building' ? { kind: 'building', buildingId: def.id } : { kind: 'outdoor', spotId: def.id };
}

/** Slots held now: place id → slot id → resident idx. */
export class Occupancy {
  private readonly held = new Map<string, Map<string, number>>();
  readonly assigned: Map<string, Set<string>>;
  readonly beds: readonly Assignment[];

  constructor(
    private readonly ix: SimIndex,
    s: SimState,
  ) {
    const a = assignmentsOf(ix, s.residents);
    this.assigned = a.assigned;
    this.beds = a.list;
    for (const r of s.residents) {
      const place = destinationOf(ix, r);
      if (place && r.slotId) this.hold(place, r.slotId, r.idx);
    }
  }

  holder(place: string, slot: string): number | undefined {
    return this.held.get(place)?.get(slot);
  }

  hold(place: string, slot: string, r: number): void {
    let m = this.held.get(place);
    if (!m) this.held.set(place, (m = new Map()));
    m.set(slot, r);
  }

  release(place: string | null, slot: string | null, r: number): void {
    if (!place || !slot) return;
    const m = this.held.get(place);
    if (m?.get(slot) === r) m.delete(slot);
  }

  /** A slot at `place` for `action` that `r` may take: its own, or one nobody holds and nobody is assigned. */
  freeSlot(place: PlaceDef, action: ResidentAction, r: number): string | null {
    const slots = place.kind === 'building' ? place.b.slots : place.s.slots;
    const assigned = this.assigned.get(place.id);
    for (const slot of slots) {
      if (!slot.tags.includes(action)) continue;
      const by = this.holder(place.id, slot.id);
      if (by !== undefined && by !== r) continue;
      if (assigned?.has(slot.id)) continue;
      return slot.id;
    }
    return null;
  }

  /** How many residents hold a slot at `place`. */
  count(place: string): number {
    return this.held.get(place)?.size ?? 0;
  }
}

/**
 * Whether `r` may be at `place` at `tick`: the user has not closed it, it is
 * within its hours, and its access allows them (homes for their residents,
 * staff buildings for their workers).
 */
export function isAvailable(ix: SimIndex, s: SimState, place: PlaceDef, tick: Tick, r: Pick<ResidentState, 'homeId' | 'workId'>): boolean {
  if (place.kind === 'spot') return isOpenAt(place.s.hours, tick);
  const b = place.b;
  if (s.buildings[b.idx]?.open === false) return false;
  if (b.def.access === 'residents' && r.homeId !== b.def.id) return false;
  if (b.def.access === 'staff' && r.workId !== b.def.id) return false;
  return isOpenAt(b.hours, tick);
}
