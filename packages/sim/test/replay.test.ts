/**
 * Replay = live (plan §8 S2, §9): WorldReplay.stateAt(seq) equals the live
 * state at every sampled point, with or without checkpoints, and a replayed
 * explain(atSeq) matches the one taken live.
 */
import { describe, expect, it } from 'vitest';
import type { Explanation } from '@runloop-world/events';
import { WorldReplay, explain, hashState, type WorldCheckpoint } from '../src/index';
import { commons, newWorld, runUntil, scriptedCommands } from './helpers';

const town = commons();

describe('WorldReplay', () => {
  const run = newWorld({ seed: 11 });
  const start = run.tick;
  const live: { seq: number; hash: string }[] = [];
  const checkpoints: WorldCheckpoint[] = [];
  const explained: { r: number; seq: number; x: Explanation }[] = [];
  runUntil(run, start + 1440, {
    inputs: scriptedCommands(start),
    each: (t) => {
      if (t % 60 === 0) live.push({ seq: run.state.seq, hash: hashState(run.state) });
      if (t % 180 === 0) checkpoints.push({ seq: run.state.seq, state: structuredClone(run.state) });
      if (t % 97 === 0) {
        // What a Why panel shows right now for three residents.
        for (const r of [3, 17, 41]) {
          const res = run.state.residents[r]!;
          const decided = run.events[res.lastDecisionSeq - 1]!;
          if (decided.type === 'resident.decided') explained.push({ r, seq: run.state.seq, x: explain(decided, town, res.role) });
        }
      }
    },
  });

  it('folds to the live state at every sampled seq, from world.created and from checkpoints', () => {
    const plain = new WorldReplay(run.events, [], town);
    const fast = new WorldReplay(run.events, checkpoints, town);
    expect(live.length).toBeGreaterThan(20);
    for (const { seq, hash } of live) {
      expect(hashState(plain.stateAt(seq))).toBe(hash);
      expect(hashState(fast.stateAt(seq))).toBe(hash);
    }
    expect(hashState(fast.stateAt(run.state.seq))).toBe(hashState(run.state));
    // Checkpoints are not mutated by replay.
    expect(hashState(checkpoints[0]!.state)).toBe(hashState(new WorldReplay(run.events, [], town).stateAt(checkpoints[0]!.seq)));
  });

  it('explains the same decision the same way when replayed at that seq', () => {
    const replay = new WorldReplay(run.events, checkpoints, town);
    expect(explained.length).toBeGreaterThan(30);
    for (const { r, seq, x } of explained) {
      const state = replay.stateAt(seq);
      const decided = replay.decisionAt(r, seq)!;
      expect(decided.seq).toBe(state.residents[r]!.lastDecisionSeq);
      if (decided.type !== 'resident.decided') throw new Error('not a decision');
      expect(explain(decided, town, state.residents[r]!.role)).toEqual(x);
    }
  });

  it('refuses gaps and seqs it does not have', () => {
    expect(() => new WorldReplay([run.events[0]!, run.events[2]!], [], town)).toThrow(/gap/);
    expect(() => new WorldReplay(run.events, [], town).stateAt(run.state.seq + 1)).toThrow(/no event/);
  });
});
