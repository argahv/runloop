import { parseKnownEvent } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { codingMissionFixture } from './coding-mission';
import { deliver } from './deliver';

describe('codingMissionFixture', () => {
  it('is a valid, contiguous event stream', () => {
    const events = codingMissionFixture();
    events.forEach((e, i) => {
      expect(e.sequence).toBe(i + 1);
      const r = parseKnownEvent(e);
      if (!r.ok) throw new Error(`#${e.sequence} ${e.type}: ${r.error}`);
    });
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    expect(events[0]!.type).toBe('run.started');
    expect(events.at(-1)!.type).toBe('run.completed');
  });

  it('contains a genuine-shaped failing test run followed by a passing one', () => {
    const completions = codingMissionFixture().filter(
      (e) => e.type === 'tool.call_completed' && e.payload.metrics,
    );
    expect(completions.map((e) => (e.type === 'tool.call_completed' ? e.payload.status : null))).toEqual([
      'error',
      'success',
    ]);
  });
});

describe('deliver', () => {
  it('delivers every event at least once', () => {
    const events = codingMissionFixture();
    const out = deliver(events, 7, { dupRate: 0.3, shuffleWindow: 6 });
    expect(new Set(out.map((e) => e.eventId)).size).toBe(events.length);
    expect(out.length).toBeGreaterThanOrEqual(events.length);
  });
});
