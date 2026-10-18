/**
 * step(T) (plan §3): inputs, then wake, decide and interact.
 *
 * 1. Inputs: commands in submit order (commands.ts). While the world is
 *    paused, only this phase runs.
 * 2. Wake: walks that reach their end arrive; residents whose destination or
 *    place closed re-decide (dest_closed); the rest wake on their first
 *    decision, a need crossing its threshold, a (personally shifted)
 *    schedule boundary, or `until` running out.
 * 3. Decide: due residents in idx order (decide.ts).
 * 4. Interact (interact.ts).
 *
 * Every event goes through `emit`, which assigns the seq and applies it at
 * once (applyEvent is the only mutator), so later residents see earlier
 * residents' choices within the same tick.
 */
import type { CommandEnvelope, DecisionReason, ResidentState, Tick, WorldEvent, WorldEventDraft } from '@runloop-world/events';
import type { SimState } from './apply';
import { applyCommand } from './commands';
import { arrivalTick, decide, emitArrival, type DecideContext } from './decide';
import { interact } from './interact';
import { crossingTick } from './needs';
import { Occupancy, destinationOf, isAvailable } from './occupancy';
import { isBoundary, scheduleOf, scheduleShift } from './schedule';
import { simIndex, type SimWorld } from './world';

export type Emit = (draft: WorldEventDraft) => WorldEvent;

/** Why a resident who is not walking should decide now, or null. */
function wakeReason(ctx: DecideContext, r: ResidentState, tick: Tick): DecisionReason | null {
  const { ix, s, world } = ctx;
  const here = r.place.kind === 'building' ? r.place.buildingId : r.place.spotId;
  const place = here ? ix.place(here) : undefined;
  if (place && !isAvailable(ix, s, place, tick, r)) return 'dest_closed';
  if (r.lastDecisionSeq === 0) return 'start';
  for (let i = 0; i < 3; i++) if (crossingTick(r.needs[i]!, ix.thresholds[i]!) === tick) return 'need';
  if (isBoundary(scheduleOf(ix, r), scheduleShift(world.seed, r.idx), tick)) return 'schedule';
  if (r.until <= tick) return 'until';
  return null;
}

/** Phases 2–4 of tick `tick`. */
function runTick(ctx: DecideContext, tick: Tick): void {
  const { ix, s } = ctx;
  const due: [ResidentState, DecisionReason][] = [];
  for (const r of s.residents) {
    if (r.motion) {
      const dest = destinationOf(ix, r);
      const place = dest ? ix.place(dest) : undefined;
      if (!place || !isAvailable(ix, s, place, tick, r)) {
        due.push([r, 'dest_closed']);
        continue;
      }
      if (arrivalTick(ix, r.motion) > tick) continue;
      emitArrival(ctx, r, tick);
    }
    const reason = wakeReason(ctx, r, tick);
    if (reason) due.push([r, reason]);
  }
  for (const [r, reason] of due) decide(ctx, r, tick, reason);
  interact(ctx, tick);
}

function context(s: SimState, world: SimWorld, emit: Emit): DecideContext {
  const ix = simIndex(world.town);
  return { world, ix, s, occ: new Occupancy(ix, s), emit };
}

/**
 * Run tick `tick`: inputs (in submit order), then wake, decide and interact
 * (skipped while paused). `emit` assigns the seq and applies the event at once.
 * The host calls it once per tick, in order.
 */
export function step(s: SimState, world: SimWorld, tick: Tick, inputs: readonly CommandEnvelope[], emit: Emit): void {
  for (const env of inputs) applyCommand(s, world.town, env, tick, emit);
  if (s.speed === 0) return;
  runTick(context(s, world, emit), tick);
}

/**
 * Apply commands between ticks, at the current tick (the host does this as
 * soon as a command arrives, paused or not). When the world is running,
 * residents walking to a place that just closed, or inside it, re-decide in
 * this same tick (dest_closed); while paused they wait for the next tick.
 */
export function applyInputs(s: SimState, world: SimWorld, tick: Tick, inputs: readonly CommandEnvelope[], emit: Emit): WorldEvent[] {
  const out = inputs.map((env) => applyCommand(s, world.town, env, tick, emit));
  if (s.speed === 0 || !out.some((e) => e.type === 'building.open_changed' && !e.p.open)) return out;
  const ctx = context(s, world, emit);
  const { ix } = ctx;
  const due = s.residents.filter((r) => {
    const id = destinationOf(ix, r);
    const place = id ? ix.place(id) : undefined;
    return place !== undefined && !isAvailable(ix, s, place, tick, r);
  });
  for (const r of due) decide(ctx, r, tick, 'dest_closed');
  return out;
}

/** The start decisions of a new world (every resident, reason 'start'); used by createWorld. */
export function startTick(s: SimState, world: SimWorld, tick: Tick, emit: Emit): void {
  runTick(context(s, world, emit), tick);
}
