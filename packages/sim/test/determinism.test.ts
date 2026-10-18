/**
 * Determinism (plan §9): the same seed and commands give the same event log,
 * across two runs, across a restart mid-day (state rebuilt from the log or
 * from a JSON checkpoint), and in another process.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorldReplay, hashState, type SimState } from '../src/index';
import { commons, logHash, newWorld, resume, runUntil, scriptedCommands } from './helpers';

const DAY = 1440;
const REPO = path.resolve(import.meta.dirname, '../../..');

function fullDay(seed: number) {
  const run = newWorld({ seed });
  const start = run.tick;
  runUntil(run, start + DAY, { inputs: scriptedCommands(start) });
  return run;
}

describe('determinism', () => {
  const a = fullDay(42);
  const hash = logHash(a.events);

  it('gives an identical event log for the same seed and commands', () => {
    const b = fullDay(42);
    expect(b.events.length).toBe(a.events.length);
    expect(logHash(b.events)).toBe(hash);
    expect(hashState(b.state)).toBe(hashState(a.state));
    expect(logHash(fullDay(7).events)).not.toBe(hash);
  });

  it('continues identically after a restart mid-day, from the log or from a checkpoint', () => {
    const start = a.events[0]!.tick;
    const half = newWorld({ seed: 42 });
    const inputs = scriptedCommands(start);
    runUntil(half, start + DAY / 2, { inputs });
    const log = half.events.map((e) => structuredClone(e));
    // Restart 1: fold the log (what a boot without checkpoints does).
    const folded = new WorldReplay(log, [], commons()).stateAt(log.at(-1)!.seq);
    const fromLog = resume(half.world, folded, [...log], start + DAY / 2);
    runUntil(fromLog, start + DAY, { inputs });
    expect(logHash(fromLog.events)).toBe(hash);
    // Restart 2: a JSON checkpoint of the state (what the host stores, gzipped).
    const checkpoint = JSON.parse(JSON.stringify(half.state)) as SimState;
    const fromCheckpoint = resume(half.world, checkpoint, [...log], start + DAY / 2);
    runUntil(fromCheckpoint, start + DAY, { inputs });
    expect(logHash(fromCheckpoint.events)).toBe(hash);
  });

  it('gives the same log in another process', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'print-day-hash.ts'), '42'], { cwd: REPO, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ events: a.events.length, hash, state: hashState(a.state) });
  });
});
