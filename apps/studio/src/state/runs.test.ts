import type { RunSummary } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { activityText, formatAgo, groupRuns, idleMs, isTracedRun, lastTracedEventAt, pickRunToOpen, runSourceLabel, runSubtitle } from './runs';
import { runStatusView } from './view';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: id,
    title: `Run ${id}`,
    missionId: 'coding-mission',
    worldId: 'research-campus',
    status: 'succeeded',
    createdAt: '2026-10-17T11:00:00.000Z',
    endedAt: '2026-10-17T11:05:00.000Z',
    lastSequence: 10,
    adapterLabel: 'Scripted adapter',
    paused: false,
    ...over,
  };
}

const traced = (id: string, over: Partial<RunSummary> = {}) =>
  run(id, {
    title: 'Claude Code · demo',
    missionId: 'claude-code',
    mode: 'traced',
    source: { kind: 'claude-code', sessionId: `${id}-0000-session`, segment: 1, projectLabel: 'demo' },
    ...over,
  });

describe('run kinds and labels', () => {
  it('tells traced runs from executed ones, also without the newer fields', () => {
    expect(isTracedRun(traced('a'))).toBe(true);
    expect(isTracedRun(run('b'))).toBe(false);
    expect(isTracedRun(run('c', { mode: 'executed', source: null }))).toBe(false);
    expect(runSourceLabel(traced('a'))).toBe('Traced · Claude Code');
    expect(runSourceLabel(run('b'))).toBe('Executed');
  });

  it('subtitles traced runs with project, short session id and segment', () => {
    expect(runSubtitle(traced('abcdef12'))).toBe('demo · session abcdef12');
    expect(runSubtitle(traced('abcdef12', { source: { kind: 'claude-code', sessionId: 'abcdef1234', segment: 2, projectLabel: 'web' } }))).toBe(
      'web · session abcdef12 · part 2',
    );
    expect(runSubtitle(run('b'))).toBeNull();
  });

  it('shows an ended traced session as "ended", not "stopped"', () => {
    expect(runStatusView('stopped', false, true)).toMatchObject({ text: 'ended', icon: '■' });
    expect(runStatusView('stopped')).toMatchObject({ text: 'stopped' });
    expect(runStatusView('interrupted', false, true).text).toBe('interrupted');
  });
});

describe('idle time', () => {
  it('is measured from the last recorded event', () => {
    const r = traced('a', { status: 'running', lastEventAt: '2026-10-17T11:55:00.000Z' });
    expect(idleMs(r, NOW)).toBe(5 * 60_000);
    expect(activityText(r, NOW)).toBe('idle 5m');
    expect(activityText({ ...r, lastEventAt: '2026-10-17T11:59:30.000Z' }, NOW)).toBe('active');
  });

  it('is unknown (null), not zero, when the runtime does not report it', () => {
    expect(idleMs(traced('a', { lastEventAt: null }), NOW)).toBeNull();
    expect(activityText(run('b'), NOW)).toBeNull();
  });

  it('formats', () => {
    expect(formatAgo(42_000)).toBe('<1m');
    expect(formatAgo(5 * 60_000)).toBe('5m');
    expect(formatAgo(125 * 60_000)).toBe('2h 05m');
    expect(formatAgo(50 * 3600_000)).toBe('2d');
  });
});

describe('grouping and following', () => {
  const runs = [
    traced('t3', { status: 'running', lastEventAt: '2026-10-17T11:58:00.000Z' }),
    run('d2', { status: 'running', endedAt: null }),
    traced('t2', { status: 'stopped', lastEventAt: '2026-10-17T11:50:00.000Z' }),
    run('d1'),
    traced('t1', { status: 'interrupted', lastEventAt: '2026-10-17T10:00:00.000Z' }),
  ];

  it('groups into live sessions (traced first), traced history and demo history', () => {
    const g = groupRuns(runs);
    expect(g.live.map((r) => r.runId)).toEqual(['t3', 'd2']);
    expect(g.traced.map((r) => r.runId)).toEqual(['t2', 't1']);
    expect(g.demo.map((r) => r.runId)).toEqual(['d1']);
  });

  it('opens the active demo, else the newest live traced session, else the newest run', () => {
    expect(pickRunToOpen('d2', ['t3'], runs)).toBe('d2');
    expect(pickRunToOpen(null, ['t3'], runs)).toBe('t3');
    expect(pickRunToOpen(null, [], runs)).toBe('t3');
    expect(pickRunToOpen(null, [], [])).toBeNull();
  });

  it('finds when Claude Code last sent anything', () => {
    expect(lastTracedEventAt(runs)).toBe('2026-10-17T11:58:00.000Z');
    expect(lastTracedEventAt([run('d1')])).toBeNull();
  });
});
