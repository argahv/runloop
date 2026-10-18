/**
 * Needs (plan §3): closed form, re-anchored only by events, so a resident
 * whose action does not change costs nothing per tick. Values are urgencies
 * in milli-points (0 = satisfied, 100 000 = urgent).
 */
import { NEED_MAX, NEED_SCALE, needAt, type NeedRates, type NeedValues, type ResidentAction, type ResidentState, type Tick } from '@runloop-world/events';
import type { Weights } from '@runloop-world/town';

export const NEED_KEYS = ['hunger', 'energy', 'social'] as const;

/** Need values at `tick`. */
export function needsAt(r: Pick<ResidentState, 'needs'>, tick: Tick): NeedValues {
  return [needAt(r.needs[0], tick), needAt(r.needs[1], tick), needAt(r.needs[2], tick)];
}

/** Whole points (0–100) of a value in milli-points. */
export function points(v: number): number {
  return Math.floor(v / NEED_SCALE);
}

/** The rates while doing `action` (or walking). */
export function ratesFor(weights: Weights, action: ResidentAction | 'walk'): NeedRates {
  const r = weights.rates[action];
  return [r[0], r[1], r[2]];
}

/** Values after `minutes` at constant `rates`, clamped like needAt. */
export function advance(values: NeedValues, rates: NeedRates, minutes: number): NeedValues {
  const at = (i: 0 | 1 | 2) => Math.min(NEED_MAX, Math.max(0, values[i] + rates[i] * minutes));
  return [at(0), at(1), at(2)];
}

/**
 * The tick at which a growing need reaches its threshold (plan §3:
 * t0 + ceil((thr − v0) / rate)); null if it is falling, flat, or already over
 * the threshold at its anchor.
 */
export function crossingTick(track: ResidentState['needs'][number], threshold: number): Tick | null {
  if (track.rate <= 0 || track.v0 >= threshold) return null;
  return track.t0 + Math.ceil((threshold - track.v0) / track.rate);
}

/** The need part of a score: Σ w·u²/100 over the needs the action relieves (u in points). */
export function needPart(weights: Weights, action: ResidentAction, pts: readonly [number, number, number]): number {
  let total = 0;
  for (const need of weights.satisfies[action]) {
    const i = NEED_KEYS.indexOf(need);
    total += Math.floor((weights.need[need] * pts[i]! * pts[i]!) / 100);
  }
  return total;
}
