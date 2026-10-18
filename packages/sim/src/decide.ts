/**
 * Decide (plan §3 phase 3): a due resident scores at most 10 candidates in
 * integer arithmetic and takes the best one:
 *
 *   total = Σ w·u²/100 (needs it relieves) + schedule bias + trait
 *           − k·travelMin + stay bonus + hash32(seed, T, idx, 'dec', option) % jitter
 *
 * Ties go to the lower action ordinal, then the lower place id. The decision
 * is recorded with its needs and its best three options, so explanations come
 * only from the event (P10). A move also records the walk (`departed`).
 */
import {
  NEED_MAX,
  RESIDENT_ACTIONS,
  encodeRoute,
  placeId,
  type DecisionOption,
  type DecisionReason,
  type NeedValues,
  type ResidentAction,
  type ResidentState,
  type Tick,
  residentId,
  type WorldCell,
  type WorldEvent,
  type WorldEventDraft,
} from '@runloop-world/events';
import { hash32, hashRange, pathTo, stepsTo, type Weights } from '@runloop-world/town';
import type { SimState } from './apply';
import { needPart, needsAt, points, ratesFor } from './needs';
import { destinationOf, isAvailable, placeOf, type Occupancy } from './occupancy';
import { blockAt, scheduleOf, scheduleShift } from './schedule';
import type { PlaceDef, SimIndex, SimWorld } from './world';

export const MAX_CANDIDATES = 10;
/** Stroll destinations: one of this many nearest, picked by hash, so neighbours do not all walk to the same bench. */
const STROLL_CHOICES = 3;

export interface Emitter {
  (draft: WorldEventDraft): WorldEvent;
}

export interface DecideContext {
  world: SimWorld;
  ix: SimIndex;
  s: SimState;
  occ: Occupancy;
  emit: Emitter;
}

interface Option {
  action: ResidentAction;
  place: PlaceDef;
  slot: string;
  /** Navigation target: the building id, or the spot slot id. */
  target: string;
  travelMin: number;
  stay: boolean;
  need: number;
  sched: number;
  travel: number;
  total: number;
}

/** The cell index a resident stands on at `tick` (its door, its spot cell, or where it is on its walk). */
export function cellNow(ix: SimIndex, r: ResidentState, tick: Tick): number {
  const { town } = ix;
  if (r.motion) {
    const path = r.motion.path;
    const i = Math.min(path.length - 1, Math.max(0, (tick - r.motion.startTick) * ix.walkCellsPerMinute));
    const [x, y] = path[i]!;
    return y * town.width + x;
  }
  if (r.place.kind === 'building') return town.buildingById.get(r.place.buildingId)!.doorIndex;
  const spot = r.place.spotId ? town.spotById.get(r.place.spotId) : undefined;
  const slot = r.slotId ? Number(r.slotId.slice(r.slotId.indexOf('#') + 1)) : 0;
  if (!spot) throw new Error(`${r.id} is outdoors with no spot and no walk`);
  return spot.cellIndex[slot] ?? spot.cellIndex[0]!;
}

/** The tick a walk ends: ceil(startTick + (len − 1) / walkCellsPerMinute). */
export function arrivalTick(ix: SimIndex, motion: NonNullable<ResidentState['motion']>): Tick {
  return motion.startTick + Math.ceil((motion.path.length - 1) / ix.walkCellsPerMinute);
}

/** First-decision needs, drawn per resident from the town's start ranges. */
export function startNeeds(world: SimWorld, idx: number): NeedValues {
  const [h, e, so] = world.town.def.needs;
  const draw = (n: typeof h, i: number) => Math.min(NEED_MAX, hashRange(n.start[0] * 1000, n.start[1] * 1000 + 999, world.seed, 'need', idx, i));
  return [draw(h, 0), draw(e, 1), draw(so, 2)];
}

const ordinal = (a: ResidentAction) => RESIDENT_ACTIONS.indexOf(a);

/** Trait axis 2 ("outdoorsy", @runloop-world/events TRAIT_IDS) also favours any outdoor place. */
const OUTDOORSY = 2;

/**
 * The trait part: the action's trait axis (weights.traitOf), plus the
 * outdoorsy axis for an outdoor place; each axis counts once.
 */
export function traitPart(w: Weights, traits: readonly [number, number, number], action: ResidentAction, outdoor: boolean): number {
  const axes = new Set<number>();
  const axis = w.traitOf[action];
  if (axis !== undefined) axes.add(axis);
  if (outdoor) axes.add(OUTDOORSY);
  let total = 0;
  for (const a of axes) total += Math.floor((traits[a]! * w.trait) / 100);
  return total;
}

function compare(a: Option, b: Option): number {
  return b.total - a.total || ordinal(a.action) - ordinal(b.action) || (a.place.id < b.place.id ? -1 : a.place.id > b.place.id ? 1 : 0);
}

/** Decide for one resident at `tick`, emitting `decided` (and `departed`, and `arrived` for a zero-length walk). */
export function decide(ctx: DecideContext, r: ResidentState, tick: Tick, reason: DecisionReason): void {
  const { world, ix, s, occ } = ctx;
  const { town } = ix;
  const w = town.def.weights;
  const walking = r.motion !== null;
  const here = cellNow(ix, r, tick);
  const current = walking ? null : placeId(r.place);
  const values = reason === 'start' ? startNeeds(world, r.idx) : needsAt(r, tick);
  const pts = [points(values[0]), points(values[1]), points(values[2])] as const;
  const shift = scheduleShift(world.seed, r.idx);
  const block = blockAt(scheduleOf(ix, r), shift, tick);
  const { bed, work } = occ.beds[r.idx]!;
  const home = ix.place(r.homeId);

  const options: Option[] = [];
  const seen = new Set<string>();
  const add = (action: ResidentAction, place: PlaceDef | undefined, slot: string | null, force = false): void => {
    if (!place || !slot || options.length >= MAX_CANDIDATES) return;
    const key = `${action}@${place.id}`;
    if (seen.has(key) || (!force && !isAvailable(ix, s, place, tick, r))) return;
    const same = current === place.id;
    // At the same spot a resident keeps its cell.
    const slotId = same && place.kind === 'spot' && r.slotId ? r.slotId : slot;
    const target = place.kind === 'building' ? place.id : slotId;
    const steps = same ? 0 : stepsTo(town, here, target);
    if (steps < 0) return;
    seen.add(key);
    const travelMin = Math.ceil(steps / ix.walkCellsPerMinute);
    const stay = same && r.action === action && reason !== 'start';
    const need = needPart(w, action, pts);
    const sched = block.bias[action] ?? 0;
    const trait = traitPart(w, r.traits, action, place.kind === 'spot');
    const travel = w.travelPerMinute * travelMin;
    const jitter = hash32(world.seed, tick, r.idx, 'dec', action, place.id) % w.jitter;
    const total = need + sched + trait - travel + (stay ? w.stay : 0) + jitter;
    options.push({ action, place, slot: slotId, target, travelMin, stay, need, sched, travel, total });
  };
  /** The nearest available places for `action` (outside home) with a free slot there, nearest first. */
  const nearest = (action: ResidentAction, n: number, opts: { outdoorOnly?: boolean; elsewhere?: boolean } = {}): { place: PlaceDef; slot: string; steps: number }[] => {
    const found: { place: PlaceDef; slot: string; steps: number }[] = [];
    for (const place of ix.placesFor[action]) {
      if ((opts.outdoorOnly && place.kind !== 'spot') || (opts.elsewhere && place.id === current)) continue;
      if (!isAvailable(ix, s, place, tick, r)) continue;
      if (place.kind === 'building') {
        const slot = occ.freeSlot(place, action, r.idx);
        const steps = slot ? (current === place.id ? 0 : stepsTo(town, here, place.id)) : -1;
        if (slot && steps >= 0) found.push({ place, slot, steps });
      } else {
        // The nearest free cell of the spot (its own cell when already there).
        let best: { slot: string; steps: number } | null = null;
        for (const sl of place.s.slots) {
          const by = occ.holder(place.id, sl.id);
          if (by !== undefined && by !== r.idx) continue;
          const steps = current === place.id && r.slotId === sl.id ? 0 : stepsTo(town, here, sl.id);
          if (steps >= 0 && (!best || steps < best.steps)) best = { slot: sl.id, steps };
        }
        if (best) found.push({ place, ...best });
      }
    }
    found.sort((a, b) => a.steps - b.steps || (a.place.id < b.place.id ? -1 : 1));
    return found.slice(0, n);
  };

  // Staying with what they are doing comes first, so it is never crowded out.
  if (current && !walking && reason !== 'start') {
    const place = ix.place(current);
    if (place) add(r.action, place, r.slotId ?? occ.freeSlot(place, r.action, r.idx));
  }
  if (r.workId && work && (block.bias.work ?? 0) > 0) add('work', ix.place(r.workId), work);
  if (home) add('eat', home, occ.freeSlot(home, 'eat', r.idx));
  for (const f of nearest('eat', w.foodChoices)) add('eat', f.place, f.slot);
  if (home) add('sleep', home, bed);
  if (home) add('rest', home, occ.freeSlot(home, 'rest', r.idx) ?? bed);
  // Socialise at the nearest place, and at the nearest outdoor one when that is another place.
  for (const f of nearest('socialize', 1)) add('socialize', f.place, f.slot);
  for (const f of nearest('socialize', 1, { outdoorOnly: true })) add('socialize', f.place, f.slot);
  // A stroll goes somewhere else (staying put is the stay option).
  const strolls = nearest('stroll', STROLL_CHOICES, { elsewhere: true });
  if (strolls.length) {
    const pick = strolls[hash32(world.seed, tick, r.idx, 'stroll') % strolls.length]!;
    add('stroll', pick.place, pick.slot);
  }
  // Nowhere else to be (everything closed or full, even home): rest in their own bed.
  if (!options.length) add('rest', home, bed, true);
  if (!options.length) throw new Error(`${r.id} has nowhere to be at tick ${tick}`);

  options.sort(compare);
  const chosen = options[0]!;
  const moving = walking || current !== chosen.place.id;
  const [lo, hi] = w.durations[chosen.action];
  const arrive = tick + (moving ? chosen.travelMin : 0);
  const until = arrive + hashRange(lo, hi, world.seed, tick, r.idx, 'dur');
  const place = placeOf(chosen.place);
  const top = options.slice(0, 3).map((o): DecisionOption => [o.action, o.place.id, o.total, o.need, o.sched, o.travel]);

  occ.release(destinationOf(ix, r), r.slotId, r.idx);
  occ.hold(chosen.place.id, chosen.slot, r.idx);
  const actor = residentId(r.idx);
  ctx.emit({
    tick,
    type: 'resident.decided',
    prov: 'simulation',
    actor,
    p: {
      r: r.idx,
      a: chosen.action,
      place,
      slotId: chosen.slot,
      reason,
      block: block.id,
      needs: values,
      rates: ratesFor(w, moving ? 'walk' : chosen.action),
      until,
      top,
    },
  });
  if (!moving) return;
  const from: WorldCell = [here % town.width, Math.floor(here / town.width)];
  const path = pathTo(town, from, chosen.target);
  if (!path) throw new Error(`${r.id}: no walk from ${from} to ${chosen.target}`);
  ctx.emit({ tick, type: 'resident.departed', prov: 'simulation', actor, p: { r: r.idx, route: encodeRoute(path), startTick: tick, dest: place } });
  if (path.length === 1) emitArrival(ctx, r, tick);
}

/** Emit `arrived` at the walk's destination with the needs now and the action's rates. */
export function emitArrival(ctx: DecideContext, r: ResidentState, tick: Tick): void {
  const dest = destinationOf(ctx.ix, r);
  const place = dest ? ctx.ix.place(dest) : undefined;
  if (!place) throw new Error(`${r.id}: walk ends nowhere`);
  ctx.emit({
    tick,
    type: 'resident.arrived',
    prov: 'simulation',
    actor: residentId(r.idx),
    p: { r: r.idx, place: placeOf(place), slotId: r.slotId, needs: needsAt(r, tick), rates: ratesFor(ctx.ix.town.def.weights, r.action) },
  });
}
