import type { UnknownEvent } from '@runloop-world/events';
import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { formatClock, formatEvent } from './format';
import { foldExecution, initialExecState } from './reduce-execution';

describe('formatClock', () => {
  it('formats mm:ss', () => {
    expect(formatClock(92000)).toBe('01:32');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(999)).toBe('00:00');
    expect(formatClock(-5000)).toBe('00:00');
    expect(formatClock(195_000)).toBe('03:15');
    expect(formatClock(100 * 60_000)).toBe('100:00');
  });
});

describe('formatEvent', () => {
  const events = codingMissionFixture();
  const s = foldExecution(events);

  it('labels the failing test run from its payload metrics', () => {
    const e = events.find((x) => x.type === 'tool.call_completed' && x.payload.status === 'error')!;
    const f = formatEvent(e, s);
    expect(f.label).toBe('run_command error · 10 passed, 2 failed');
    expect(f.detail).toBe('12 tests: 10 passed, 2 failed (380 ms)');
    expect(f.severity).toBe('error');
    expect(f.actor).toBe('tester');
    expect(f.seq).toBe(e.sequence);
    expect(f.type).toBe('tool.call_completed');
    expect(f.clock).toMatch(/^\d\d:\d\d\.\d$/);
  });

  it('computes the clock from the run start', () => {
    const last = events.at(-1)!;
    const ms = Date.parse(last.timestamp) - Date.parse(events[0]!.timestamp);
    const f = formatEvent(last, s);
    expect(f.clock).toBe(`${formatClock(ms)}.${Math.floor(ms / 100) % 10}`);
    expect(formatEvent(events[0]!, s).clock).toBe('00:00.0');
    expect(formatEvent(events[0]!).clock).toBe('--:--.-');
    expect(formatEvent(events[0]!, initialExecState()).clock).toBe('00:00.0');
  });

  it('formats every fixture event without state, using only the payload', () => {
    for (const e of events) {
      const f = formatEvent(e);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.label).not.toContain('undefined');
    }
    const completed = events.find((x) => x.type === 'tool.call_completed' && x.payload.status === 'error')!;
    expect(formatEvent(completed).label).toBe('call-6 error · 10 passed, 2 failed');
  });

  it('attributes task events to the task owner and system events to "system"', () => {
    const done = events.find((x) => x.type === 'task.completed')!;
    expect(formatEvent(done, s).actor).toBe('researcher');
    expect(formatEvent(events[0]!, s).actor).toBe('system');
    expect(formatEvent(events.at(-1)!, s)).toMatchObject({ label: 'Run succeeded', severity: 'ok' });
  });

  it('shows unknown events as warnings', () => {
    const u: UnknownEvent = {
      ...events[1]!,
      type: 'world.custom',
      payload: { x: 1 },
      unknown: true,
      reason: 'unknown_type',
    };
    expect(formatEvent(u, s)).toMatchObject({ type: 'world.custom', severity: 'warn', label: 'Unrecognised event (unknown type)' });
  });
});
