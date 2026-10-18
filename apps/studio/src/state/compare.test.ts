import { diffRuns, foldExecution, summarizeRun, type FieldDiff } from '@runloop-world/core';
import type { RunSummary } from '@runloop-world/events';
import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { baselineFor, compareHref, isPinned, parseComparePair, pinnedRuns, resolvePair } from './baselines';
import { CHANGE, changeView, foldRaw, noteText, outcomeChange, outcomeText } from './compare';
import { tracedFixture } from './test-utils';

const run = (runId: string, createdAt: string, pinnedAt: string | null = null): RunSummary => ({
  runId,
  title: runId,
  missionId: 'm',
  worldId: 'research-campus',
  status: 'succeeded',
  createdAt,
  endedAt: createdAt,
  lastSequence: 10,
  adapterLabel: 'x',
  paused: false,
  pinnedAt,
});

// Newest first, as the runtime lists them.
const RUNS = [
  run('r4', '2026-10-18T12:00:00.000Z'),
  run('r3', '2026-10-18T11:00:00.000Z', '2026-10-18T11:30:00.000Z'),
  run('r2', '2026-10-18T10:00:00.000Z'),
  run('r1', '2026-10-18T09:00:00.000Z', '2026-10-18T13:00:00.000Z'),
];

describe('baselines', () => {
  it('lists pinned runs, most recently pinned first', () => {
    expect(pinnedRuns(RUNS).map((r) => r.runId)).toEqual(['r1', 'r3']);
    expect(isPinned(RUNS[0])).toBe(false);
    expect(isPinned({ ...RUNS[0]!, pinnedAt: undefined })).toBe(false); // older runtimes omit the field
  });

  it('defaults to the newest baseline against the newest other run of the same task', () => {
    expect(resolvePair(RUNS, { a: null, b: null })).toEqual({ a: 'r1', b: 'r4' });
    const other = { ...RUNS[0]!, runId: 'r5', missionId: 'claude-code', createdAt: '2026-10-18T14:00:00.000Z' };
    expect(resolvePair([other, ...RUNS], { a: null, b: null })).toEqual({ a: 'r1', b: 'r4' });
    // Traced runs: the same project too; with no run of the same task, the newest other run.
    const traced = (runId: string, project: string): RunSummary => ({ ...RUNS[0]!, runId, missionId: 'claude-code', source: { kind: 'claude-code', sessionId: runId, segment: 1, projectLabel: project } });
    const t = [traced('t3', 'web'), traced('t2', 'api'), { ...traced('t1', 'api'), pinnedAt: '2026-10-18T12:00:00.000Z' }];
    expect(resolvePair(t, { a: null, b: null })).toEqual({ a: 't1', b: 't2' });
    expect(resolvePair([traced('t3', 'web'), t[2]!], { a: null, b: null })).toEqual({ a: 't1', b: 't3' });
    expect(resolvePair([RUNS[0]!, { ...RUNS[1]!, pinnedAt: null }], { a: null, b: null })).toEqual({ a: null, b: 'r4' });
    expect(resolvePair([{ ...RUNS[0]!, pinnedAt: '2026-10-18T12:00:00.000Z' }], { a: null, b: null })).toEqual({ a: 'r4', b: null });
    expect(resolvePair([], { a: null, b: null })).toEqual({ a: null, b: null });
  });

  it('keeps ids the URL names, even unknown ones, and fills only the missing side', () => {
    expect(resolvePair(RUNS, { a: 'r2', b: null })).toEqual({ a: 'r2', b: 'r4' });
    expect(resolvePair(RUNS, { a: null, b: 'r1' })).toEqual({ a: 'r1', b: 'r1' });
    expect(resolvePair(RUNS, { a: 'gone', b: 'r3' })).toEqual({ a: 'gone', b: 'r3' });
  });

  it('round-trips the deep link', () => {
    expect(compareHref({ a: 'r1', b: 'r4' })).toBe('/experiments?a=r1&b=r4');
    expect(compareHref({ a: null, b: null })).toBe('/experiments');
    expect(parseComparePair(new URLSearchParams('a=r1&b=r4'))).toEqual({ a: 'r1', b: 'r4' });
    expect(parseComparePair(new URLSearchParams('a=&x=1'))).toEqual({ a: null, b: null });
  });

  it('a run’s baseline is the newest pinned run of the same task other than itself', () => {
    expect(baselineFor(RUNS, 'r4')?.runId).toBe('r1');
    expect(baselineFor(RUNS, 'r1')?.runId).toBe('r3');
    expect(baselineFor([RUNS[0]!], 'r4')).toBeNull();
    expect(baselineFor(RUNS, 'unknown')).toBeNull();
    // A pin of another task (a Claude Code session) is not a demo run's baseline.
    const session: RunSummary = { ...RUNS[0]!, runId: 's1', missionId: 'claude-code', pinnedAt: '2026-10-18T15:00:00.000Z', source: { kind: 'claude-code', sessionId: 's1', segment: 1, projectLabel: 'web' } };
    expect(baselineFor([session, RUNS[0]!], 'r4')).toBeNull();
    expect(baselineFor([session, ...RUNS], 'r4')?.runId).toBe('r1');
  });
});

const field = (f: Partial<FieldDiff<number>>): FieldDiff<number> => ({ a: 1, b: 1, delta: 0, comparable: true, note: null, ...f });

describe('change wording', () => {
  it('never colours a change that is not comparable, and says why', () => {
    expect(changeView(field({ a: null, delta: null, comparable: false, note: 'not_reported_a' }), CHANGE.tokens)).toEqual({
      tone: 'muted',
      icon: 'minus',
      text: 'not comparable',
      detail: 'not reported for the baseline',
    });
  });

  it('judges only fields with a better direction', () => {
    expect(changeView(field({ a: 5000, b: 3000, delta: -2000 }), CHANGE.duration)).toMatchObject({ tone: 'ok', icon: 'arrowDown', text: '2.0 s faster' });
    expect(changeView(field({ a: 1, b: 3, delta: 2 }), CHANGE.failing)).toMatchObject({ tone: 'err', icon: 'arrowUp', text: '2 more failing' });
    expect(changeView(field({ a: 10, b: 12, delta: 2 }), CHANGE.passed)).toMatchObject({ tone: 'ok', text: '2 more passing' });
    expect(changeView(field({ a: 9, b: 7, delta: -2 }), CHANGE.toolCalls)).toMatchObject({ tone: 'info', text: '2 fewer calls' });
    expect(changeView(field({ a: 1000, b: 1500, delta: 500 }), CHANGE.tokens)).toMatchObject({ tone: 'warn', text: '500 more tokens' });
    expect(changeView(field({}), CHANGE.duration)).toMatchObject({ tone: 'muted', text: 'no change' });
  });

  it('keeps a caveat on a comparable change (executed vs traced)', () => {
    expect(changeView(field({ a: 9, b: 4, delta: -5, note: 'mode_differs' }), CHANGE.toolCalls).detail).toBe(noteText('mode_differs'));
  });

  it('outcomes: a traced session "ended" claims nothing; success ↔ failure is judged', () => {
    expect(outcomeText('stopped', true)).toBe('ended');
    expect(outcomeText('stopped', false)).toBe('stopped');
    expect(outcomeText(null, true)).toBe('still recording');
    const o = (a: 'succeeded' | 'failed' | 'stopped', b: 'succeeded' | 'failed' | 'stopped') => ({ a, b, delta: null, comparable: true, note: null, changed: a !== b });
    expect(outcomeChange(o('failed', 'succeeded'), [false, false])).toMatchObject({ tone: 'ok', text: 'now succeeds' });
    expect(outcomeChange(o('succeeded', 'failed'), [false, false])).toMatchObject({ tone: 'err', text: 'now fails' });
    expect(outcomeChange(o('succeeded', 'stopped'), [false, true])).toMatchObject({ tone: 'info', text: 'now ended' });
    expect(outcomeChange(o('succeeded', 'succeeded'), [false, false])).toMatchObject({ tone: 'muted', text: 'same outcome' });
    expect(outcomeChange({ a: 'stopped', b: null, delta: null, comparable: false, note: 'running_b', changed: false }, [true, true])).toMatchObject({
      text: 'not comparable',
      detail: 'the candidate is still recording',
    });
  });
});

describe('foldRaw (loading a run to compare)', () => {
  it('folds the API’s raw JSON to the same state as the events, incrementally', () => {
    const events = codingMissionFixture();
    const raws = JSON.parse(JSON.stringify(events)) as unknown[];
    const runId = events[0]!.runId;
    const whole = foldRaw(raws, runId, undefined, events.length);
    expect(whole.complete).toBe(true);
    expect(summarizeRun(whole.exec)).toEqual(summarizeRun(foldExecution(events)));
    const first = foldRaw(raws.slice(0, 20), runId, undefined, events.length);
    expect(first.complete).toBe(false);
    const rest = foldRaw(raws.slice(10), runId, first.exec, events.length); // overlap is skipped
    expect(rest.complete).toBe(true);
    expect(rest.exec.lastSequence).toBe(events.length);
  });

  it('stops at a missing sequence instead of folding past it', () => {
    const events = codingMissionFixture();
    const raws = JSON.parse(JSON.stringify(events.filter((e) => e.sequence !== 5))) as unknown[];
    const r = foldRaw(raws, events[0]!.runId, undefined, events.length);
    expect(r).toMatchObject({ complete: false });
    expect(r.exec.lastSequence).toBe(4);
  });

  it('folds an invalid envelope that names its sequence as an anomaly, and ignores other runs', () => {
    const events = tracedFixture();
    const runId = events[0]!.runId;
    const raws = JSON.parse(JSON.stringify(events)) as Record<string, unknown>[];
    raws[3] = { ...raws[3], visibility: 'nope' };
    raws.push({ ...raws[0], runId: 'other-run', sequence: events.length + 1 });
    const r = foldRaw(raws, runId, undefined, events.length);
    expect(r.complete).toBe(true);
    expect(r.exec.anomalies.some((a) => a.seq === 4 && a.code === 'unknown_event')).toBe(true);
  });

  it('diffs a traced fixture against the executed demo end to end', () => {
    const exec = summarizeRun(foldExecution(codingMissionFixture()));
    const traced = summarizeRun(foldExecution(tracedFixture()));
    const d = diffRuns(exec, traced);
    expect(d.sameMode).toBe(false);
    expect(d.tokens).toMatchObject({ a: null, comparable: false, note: 'not_reported_a' });
  });
});
