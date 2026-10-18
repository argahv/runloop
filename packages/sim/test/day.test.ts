/**
 * S2 acceptance (plan §8): one sim day with no input, at 80 and at 120
 * residents. At least 95% of residents do at least 3 actions, sleep at least
 * 5 h and eat at least twice; no awake resident goes 6 h without deciding;
 * the liveliness floor holds (≥ 25% outdoors 08:00–20:00, ≥ 3% at night);
 * and a fresh world is moving: ≥ 48 of 80 residents walking within 3 ticks.
 */
import { describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY, placeId } from '@runloop-world/events';
import { newWorld, runUntil } from './helpers';

interface DayStats {
  population: number;
  actions: number[];
  eats: number[];
  sleepMinutes: number[];
  maxAwakeGap: number[];
  outdoorDayMin: number;
  outdoorNightMin: number;
  walkingAfter3: number;
}

function simulateDay(population: number, seed: number): DayStats {
  const run = newWorld({ population, seed });
  const start = run.tick;
  const actions = new Array<number>(population).fill(0);
  const eats = new Array<number>(population).fill(0);
  const sleepMinutes = new Array<number>(population).fill(0);
  const lastDecision = new Array<number>(population).fill(start);
  const maxAwakeGap = new Array<number>(population).fill(0);
  const current = new Array<string>(population).fill('');
  let outdoorDayMin = Infinity;
  let outdoorNightMin = Infinity;
  let walkingAfter3 = 0;
  let seen = 0;
  const count = () => {
    // Episodes: a decision that changes what a resident does, or where.
    for (; seen < run.events.length; seen++) {
      const e = run.events[seen]!;
      if (e.type !== 'resident.decided') continue;
      const k = `${e.p.a}@${placeId(e.p.place)}`;
      lastDecision[e.p.r] = e.tick;
      if (current[e.p.r] === k) continue;
      current[e.p.r] = k;
      actions[e.p.r]!++;
      if (e.p.a === 'eat') eats[e.p.r]!++;
    }
  };
  count();
  runUntil(run, start + MINUTES_PER_DAY, {
    each: (t) => {
      count();
      let outdoor = 0;
      for (const r of run.state.residents) {
        if (r.place.kind === 'outdoor') outdoor++;
        if (r.action === 'sleep' && !r.motion) sleepMinutes[r.idx]!++;
        else maxAwakeGap[r.idx] = Math.max(maxAwakeGap[r.idx]!, t - lastDecision[r.idx]!);
      }
      const minute = t % MINUTES_PER_DAY;
      const share = outdoor / population;
      if (minute >= 8 * 60 && minute < 20 * 60) outdoorDayMin = Math.min(outdoorDayMin, share);
      else outdoorNightMin = Math.min(outdoorNightMin, share);
      if (t === start + 3) walkingAfter3 = run.state.residents.filter((r) => r.motion).length;
    },
  });
  return { population, actions, eats, sleepMinutes, maxAwakeGap, outdoorDayMin, outdoorNightMin, walkingAfter3 };
}

const share = (xs: number[], ok: (x: number) => boolean) => xs.filter(ok).length / xs.length;

describe.each([80, 120])('one sim day with %i residents and no input', (population) => {
  const day = simulateDay(population, 42);

  it('keeps ≥ 95% of residents doing ≥ 3 actions, sleeping ≥ 5 h and eating ≥ 2 times', () => {
    expect(share(day.actions, (n) => n >= 3)).toBeGreaterThanOrEqual(0.95);
    expect(share(day.sleepMinutes, (n) => n >= 300)).toBeGreaterThanOrEqual(0.95);
    expect(share(day.eats, (n) => n >= 2)).toBeGreaterThanOrEqual(0.95);
  });

  it('lets no awake resident go 6 h without deciding', () => {
    expect(Math.max(...day.maxAwakeGap)).toBeLessThan(6 * 60);
  });

  it('holds the liveliness floor: ≥ 25% outdoors 08:00–20:00 and ≥ 3% at night', () => {
    expect(day.outdoorDayMin).toBeGreaterThanOrEqual(0.25);
    expect(day.outdoorNightMin).toBeGreaterThanOrEqual(0.03);
  });

  it('gets a fresh world moving: ≥ 60% of residents walking within 3 ticks (48 of 80)', () => {
    expect(day.walkingAfter3).toBeGreaterThanOrEqual(Math.ceil(population * 0.6));
  });
});
