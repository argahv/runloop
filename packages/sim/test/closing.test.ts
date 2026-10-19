/**
 * S2 acceptance (plan §8): closing the café gives 0 new routes to it, and
 * residents already on the way re-decide in the same tick (dest_closed),
 * whether the command arrives with a tick (step) or between ticks
 * (applyInputs, what the host does).
 */
import { describe, expect, it } from 'vitest';
import type { CommandEnvelope, WorldEvent } from '@runloop-world/events';
import { destinationOf, simIndex } from '../src/index';
import { between, commons, newWorld, runUntil, type Run } from './helpers';

const CAFE = 'bld_corner_cafe';
const close: CommandEnvelope = { id: 'close:cafe', source: 'user', command: { type: 'building.set_open', buildingId: CAFE, open: false } };
const town = commons();
const ix = simIndex(town);

/** Run to a busy moment: some residents walking to the café and some inside it. */
function busyCafe(): { run: Run; walking: number[]; inside: number[] } {
  const run = newWorld({ seed: 42 });
  for (let t = run.tick + 1; t < run.tick + 600; t++) {
    runUntil(run, t);
    const walking = run.state.residents.filter((r) => r.motion && destinationOf(ix, r) === CAFE).map((r) => r.idx);
    const inside = run.state.residents.filter((r) => !r.motion && r.place.kind === 'building' && r.place.buildingId === CAFE).map((r) => r.idx);
    if (walking.length >= 2 && inside.length >= 2) return { run, walking, inside };
  }
  throw new Error('no busy café moment found');
}

function checkClosing(run: Run, from: number, tick: number, walking: number[], inside: number[]): void {
  const after = run.events.slice(from);
  const redecided = after.filter((e): e is Extract<WorldEvent, { type: 'resident.decided' }> => e.type === 'resident.decided' && e.p.reason === 'dest_closed' && e.tick === tick);
  // Everyone walking there or inside re-decides in the closing tick, for somewhere else.
  expect(new Set(redecided.map((e) => e.p.r))).toEqual(new Set([...walking, ...inside]));
  for (const e of redecided) expect(e.p.place).not.toEqual({ kind: 'building', buildingId: CAFE });
  // No new walk ever heads to the café while it is closed, and nobody is bound there.
  runUntil(run, tick + 240);
  for (const e of run.events.slice(from)) {
    if (e.type === 'resident.departed') expect(e.p.dest).not.toEqual({ kind: 'building', buildingId: CAFE });
    if (e.type === 'resident.decided') expect(placeOfDecision(e)).not.toBe(CAFE);
  }
  for (const r of run.state.residents) expect(destinationOf(ix, r)).not.toBe(CAFE);
  expect(run.state.buildings.find((b) => b.id === CAFE)).toMatchObject({ open: false, occupancy: 0 });
}

const placeOfDecision = (e: Extract<WorldEvent, { type: 'resident.decided' }>) => (e.p.place.kind === 'building' ? e.p.place.buildingId : e.p.place.spotId);

describe('closing the café', () => {
  it('as a tick input: walkers and guests re-decide in the same tick, and no route leads there', () => {
    const { run, walking, inside } = busyCafe();
    const from = run.events.length;
    const tick = run.tick + 1;
    runUntil(run, tick, { inputs: new Map([[tick, [close]]]) });
    expect(run.events[from]).toMatchObject({ type: 'building.open_changed', prov: 'user', cmdId: 'close:cafe', tick });
    checkClosing(run, from, tick, walking, inside);
  });

  it('between ticks (as the host applies commands): the same, at the current tick', () => {
    const { run, walking, inside } = busyCafe();
    const from = run.events.length;
    between(run, run.tick, [close]);
    checkClosing(run, from, run.events[from]!.tick, walking, inside);
  });

  it('reopening lets residents choose it again', () => {
    const { run } = busyCafe();
    between(run, run.tick, [close]);
    runUntil(run, run.tick + 30);
    const from = run.events.length;
    between(run, run.tick, [{ id: 'open:cafe', source: 'user', command: { type: 'building.set_open', buildingId: CAFE, open: true } }]);
    runUntil(run, run.tick + 600);
    expect(run.events.slice(from).some((e) => e.type === 'resident.departed' && e.p.dest.kind === 'building' && e.p.dest.buildingId === CAFE)).toBe(true);
  });
});
