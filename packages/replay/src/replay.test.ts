import { readFileSync } from 'node:fs';
import { SequenceGapError } from '@runloop-world/core';
import { SequenceBuffer, type AnyEvent, type RunEvent } from '@runloop-world/events';
import { codingMissionFixture, deliver, mulberry32, runBuilder } from '@runloop-world/testkit';
import { loadWorld, presentationAt } from '@runloop-world/world-engine';
import { describe, expect, it } from 'vitest';
import { initialRunState, reduceRun } from './reduce-run';
import { ReplayIndex } from './replay-index';
import type { RunState } from './types';

const world = loadWorld(
  JSON.parse(readFileSync(new URL('../../../worlds/research-campus/world.json', import.meta.url), 'utf8')),
);
const fixture = codingMissionFixture();

/** States after each event (index 0 = initial), folded one by one. */
function incremental(events: readonly AnyEvent[]): RunState[] {
  const out = [initialRunState()];
  for (const e of events) out.push(reduceRun(out.at(-1)!, e, world));
  return out;
}

/** A long run (≈ 250 events) with irregular timing, to exercise snapshots. */
function longRun(seed = 9): RunEvent[] {
  const rand = mulberry32(seed);
  const b = runBuilder({ startIso: '2026-10-17T10:00:00.000Z', namespace: 0xa1 });
  b.add('run.started', {
    title: 'long',
    missionId: 'm',
    worldId: 'research-campus',
    seed,
    adapter: { id: 'x', kind: 'scripted', label: 'X' },
    workspace: 'workspaces/long',
  });
  const agents = ['researcher', 'builder', 'tester'];
  for (const a of agents) {
    b.wait(100).add('agent.registered', { agentId: a, name: a, role: a, model: null, tools: [], embodied: true, characterPreset: a });
  }
  const kinds = ['research', 'code', 'test', 'fix'] as const;
  let call = 0;
  for (let i = 1; i <= 40; i++) {
    const agentId = agents[i % 3]!;
    const taskId = `T${i}`;
    b.wait(100 + Math.floor(rand() * 900)).add('task.created', { taskId, title: taskId, kind: kinds[i % 4]!, dependsOn: [], plannedSteps: 2 });
    b.wait(Math.floor(rand() * 400)).add('task.started', { taskId, agentId });
    for (let k = 0; k < 2; k++) {
      call += 1;
      b.wait(Math.floor(rand() * 1500)).add('tool.call_started', { callId: `c${call}`, agentId, taskId, tool: 'read_file', inputSummary: 'f' });
      // Occasionally the clock runs backwards a little: order must still come from sequence.
      b.wait(rand() < 0.15 ? -300 : Math.floor(rand() * 300)).add('tool.call_completed', {
        callId: `c${call}`,
        status: rand() < 0.2 ? 'error' : 'success',
        durationMs: 5,
        outputSummary: 'ok',
      });
    }
    if (rand() < 0.15) b.wait(200).add('task.failed', { taskId, reason: 'nope' });
    else b.wait(200).add('task.completed', { taskId, summary: 'done', artifactIds: [] });
  }
  b.wait(500).add('run.completed', { outcome: 'succeeded' });
  return b.events;
}

describe('reduceRun', () => {
  it('folds execution then world, and ignores redelivered sequences', () => {
    const s = incremental(fixture.slice(0, 10)).at(-1)!;
    expect(s.exec.lastSequence).toBe(10);
    expect(s.world.lastSequence).toBe(10);
    expect(reduceRun(s, fixture[4]!, world)).toBe(s);
    expect(() => reduceRun(s, fixture[11]!, world)).toThrow(SequenceGapError);
  });
});

describe('ReplayIndex', () => {
  it('stateAt(N) deep-equals the incremental fold for every N (fixture)', () => {
    const idx = new ReplayIndex(world, fixture);
    const folds = incremental(fixture);
    // Visit out of order so snapshots and the memo are both exercised.
    const order = fixture.map((e) => e.sequence).reverse();
    order.push(0, 25, 51, 50, 7);
    for (const n of order) expect(idx.stateAt(n)).toEqual(folds[n]);
    expect(idx.latest()).toBe(idx.stateAt(fixture.length));
    expect(idx.latest()).toEqual(folds.at(-1));
  });

  it('stateAt(N) deep-equals the incremental fold for a long run (snapshots every 50)', () => {
    const events = longRun();
    expect(events.length).toBeGreaterThan(200);
    const idx = new ReplayIndex(world, events);
    const folds = incremental(events);
    const rand = mulberry32(3);
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rand() * (events.length + 1));
      expect(idx.stateAt(n)).toEqual(folds[n]);
    }
    for (let n = 0; n <= events.length; n++) expect(idx.stateAt(n)).toEqual(folds[n]);
  });

  it('memoizes and clamps', () => {
    const idx = new ReplayIndex(world, fixture);
    expect(idx.stateAt(23)).toBe(idx.stateAt(23));
    expect(idx.stateAt(23.7)).toBe(idx.stateAt(23));
    expect(idx.stateAt(-4)).toEqual(initialRunState());
    expect(idx.stateAt(10_000)).toBe(idx.latest());
    expect(new ReplayIndex(world).latest()).toEqual(initialRunState());
  });

  it('append builds the same index incrementally, ignores known sequences and throws on gaps', () => {
    const idx = new ReplayIndex(world);
    for (let i = 0; i < fixture.length; i += 7) idx.append(fixture.slice(Math.max(0, i - 2), i + 7));
    expect(idx.lastSequence).toBe(fixture.length);
    expect(idx.events).toEqual(fixture);
    expect(idx.latest()).toEqual(new ReplayIndex(world, fixture).latest());
    const short = new ReplayIndex(world, fixture.slice(0, 5));
    expect(() => short.append([fixture[6]!])).toThrow(SequenceGapError);
  });

  it('shuffled + duplicated delivery through SequenceBuffer then folding equals replay', () => {
    const replay = new ReplayIndex(world, fixture).latest();
    for (let seed = 1; seed <= 50; seed++) {
      const buffer = new SequenceBuffer<RunEvent>();
      const live = new ReplayIndex(world);
      let state = initialRunState();
      for (const e of deliver(fixture, seed, { dupRate: 0.2, shuffleWindow: 8 })) {
        const released = buffer.push(e);
        live.append(released);
        for (const r of released) state = reduceRun(state, r, world);
      }
      expect(buffer.missing()).toBeNull();
      expect(buffer.conflicts).toEqual([]);
      expect(state).toEqual(replay);
      expect(live.latest()).toEqual(replay);
    }
  });

  it('two independent folds produce identical JSON', () => {
    const a = JSON.stringify(new ReplayIndex(world, codingMissionFixture()).latest());
    const b = JSON.stringify(incremental(codingMissionFixture()).at(-1));
    expect(a).toBe(b);
  });
});

describe('ReplayIndex time mapping', () => {
  it('maps sequences to monotonic time and back, even when timestamps go backwards', () => {
    const b = runBuilder({ startIso: '2026-10-17T10:00:00.000Z' });
    const reg = (id: string) => ({ agentId: id, name: id, role: 'r', model: null, tools: [], embodied: false });
    b.add('agent.registered', reg('a')); // 0 ms
    b.wait(1000).add('agent.registered', reg('b')); // 1000
    b.wait(-600).add('agent.registered', reg('c')); // 400 → clamped to 1000
    b.wait(1100).add('agent.registered', reg('d')); // 1500
    const idx = new ReplayIndex(world, b.events);
    expect([0, 1, 2, 3, 4].map((s) => idx.timeOfSeq(s))).toEqual([0, 0, 1000, 1000, 1500]);
    expect(idx.durationMs).toBe(1500);
    expect(idx.runStartMs).toBe(Date.parse('2026-10-17T10:00:00.000Z'));
    expect(idx.seqAtTime(-1)).toBe(0);
    expect(idx.seqAtTime(0)).toBe(1);
    expect(idx.seqAtTime(999)).toBe(1);
    expect(idx.seqAtTime(1000)).toBe(3);
    expect(idx.seqAtTime(1499)).toBe(3);
    expect(idx.seqAtTime(1e9)).toBe(4);
    expect(idx.tickAtMs(1250)).toBeCloseTo(12.5);
    expect(new ReplayIndex(world).seqAtTime(5000)).toBe(0);
    expect(new ReplayIndex(world).durationMs).toBe(0);
  });

  it('agrees with the world tick of every event', () => {
    const events = longRun(4);
    const idx = new ReplayIndex(world, events);
    for (const e of events) {
      expect(idx.tickAtMs(idx.timeOfSeq(e.sequence))).toBe(idx.stateAt(e.sequence).world.tick);
      expect(idx.seqAtTime(idx.timeOfSeq(e.sequence))).toBeGreaterThanOrEqual(e.sequence);
    }
  });

  it('a re-route between ticks continues from where the playhead is (no jump)', () => {
    const b = runBuilder({ startIso: '2026-10-17T09:00:00.000Z' });
    b.add('run.started', { title: 't', missionId: 'm', worldId: 'research-campus', seed: 1, adapter: { id: 'x', kind: 'scripted', label: 'X' }, workspace: 'w' });
    b.wait(100).add('agent.registered', { agentId: 't', name: 't', role: 't', model: null, tools: [], embodied: true, characterPreset: 'tester' });
    b.wait(100).add('task.created', { taskId: 'T1', title: '', kind: 'test', dependsOn: [] });
    b.wait(100).add('task.started', { taskId: 'T1', agentId: 't' }); // 300 ms: walk to the probe
    b.wait(490).add('task.blocked', { taskId: 'T1', reason: 'x' }); // 790 ms, between ticks: walk back home
    b.wait(1230).add('task.started', { taskId: 'T1', agentId: 't' }); // 2020 ms: and out again
    const idx = new ReplayIndex(world, b.events);
    const maxStep = 1 / world.def.ticksPerCell / world.def.tickHz; // cells per ms at walking speed
    let prev: { x: number; y: number } | null = null;
    for (let ms = 300; ms <= 6000; ms += 1) {
      const c = idx.stateAt(idx.seqAtTime(ms)).world.characters.t!;
      const p = presentationAt(c, idx.tickAtMs(ms), world);
      if (prev) expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y), `jump at ${ms} ms`).toBeLessThanOrEqual(maxStep + 1e-9);
      prev = p;
    }
  });

  it('positions are identical between a live fold and replay at many ticks', () => {
    for (const events of [fixture, longRun(11)]) {
      const idx = new ReplayIndex(world, events);
      // "Live": fold events as their (monotonic) time arrives, render at the current time.
      let live = initialRunState();
      let next = 0;
      const end = idx.durationMs + 5000;
      for (let ms = 0; ms <= end; ms += 37) {
        while (next < events.length && idx.timeOfSeq(next + 1) <= ms) live = reduceRun(live, events[next++]!, world);
        const replay = idx.stateAt(idx.seqAtTime(ms));
        expect(replay.exec.lastSequence).toBe(live.exec.lastSequence);
        const tick = idx.tickAtMs(ms);
        for (const id of live.world.characterOrder) {
          const a = presentationAt(live.world.characters[id]!, tick, world, { paused: live.world.paused });
          const r = presentationAt(replay.world.characters[id]!, tick, world, { paused: replay.world.paused });
          expect(r).toEqual(a);
        }
      }
    }
  });
});
