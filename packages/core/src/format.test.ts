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

  it('numbers retried task starts, with the state before or after the event', () => {
    const starts = events.filter((x) => x.type === 'task.started' && x.payload.taskId === 'T3');
    expect(starts).toHaveLength(2);
    const before = foldExecution(events.slice(0, starts[1]!.sequence - 1));
    const after = foldExecution(events.slice(0, starts[1]!.sequence));
    expect(formatEvent(starts[1]!, before).label).toBe('Started T3 (attempt 2)');
    expect(formatEvent(starts[1]!, after).label).toBe('Started T3 (attempt 2)');
    expect(formatEvent(starts[0]!, foldExecution(events.slice(0, starts[0]!.sequence))).label).toBe('Started T3');
    // Without the adjacent state the attempt is unknown, so it is left out.
    expect(formatEvent(starts[1]!, s).label).toBe('Started T3');
    expect(formatEvent(starts[1]!).label).toBe('Started T3');
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

describe('formatEvent — traced additions', () => {
  const env = { eventId: '00000001-0000-4000-8000-000000000001', runId: '00000001-0000-4000-8000-0000000000ff', timestamp: '2026-10-17T09:00:00.000Z', schemaVersion: 1, visibility: 'public' as const };

  it('labels markers, usage reports and categorised calls', () => {
    const marker = formatEvent({ ...env, sequence: 1, type: 'run.marker', payload: { kind: 'api_error', label: 'API error', detail: 'overloaded', agentId: 'main' } });
    expect(marker).toMatchObject({ label: 'API error', detail: 'overloaded', severity: 'error', actor: 'main' });
    const usage = formatEvent({
      ...env,
      sequence: 2,
      type: 'agent.usage_reported',
      actorId: 'sa-1',
      payload: { agentId: 'sa-1', model: 'claude-haiku-5-5', inputTokens: 2, outputTokens: 193, cacheReadTokens: 19620, cacheCreationTokens: 705, totalTokens: 20520, durationMs: 4795, source: 'claude-code.agent_result' },
    });
    expect(usage.label).toBe('Usage reported: 20,520 tokens (claude-haiku-5-5)');
    expect(usage.detail).toBe('in 2 · out 193 · cache read 19,620 · cache write 705 · 4.8 s');
    const call = formatEvent({ ...env, sequence: 3, type: 'tool.call_started', payload: { callId: 'c', agentId: 'main', tool: 'Bash', category: 'test', inputSummary: 'npm test' } });
    expect(call).toMatchObject({ label: 'Bash npm test', detail: 'test' });
  });
});
