import { CODING_MISSION, codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { buildTimelineRows, formatDuration, rowStatusAt } from './timeline';

const events = codingMissionFixture();
const t0 = Date.parse(events[0]!.timestamp);
const timeOfSeq = (seq: number) => Date.parse(events[seq - 1]!.timestamp) - t0;
const rows = buildTimelineRows(events, timeOfSeq);

describe('timeline rows', () => {
  it('merges each tool start and its completion into one row', () => {
    const starts = events.filter((e) => e.type === 'tool.call_started');
    const toolRows = rows.filter((r) => r.callId !== null);
    expect(toolRows.map((r) => r.callId)).toEqual(starts.map((e) => (e.payload as { callId: string }).callId));
    for (const r of toolRows) {
      expect(r.endSeq).not.toBeNull();
      expect(r.endSeq!).toBeGreaterThan(r.seq);
      expect(r.durationMs).not.toBeNull();
    }
    // No separate rows for completions, nor for artifacts produced by a call.
    expect(rows.some((r) => r.type === 'tool.call_completed' || r.type === 'artifact.created')).toBe(false);
  });

  it('shows the failing test run with the payload counts verbatim', () => {
    const runs = rows.filter((r) => r.title.startsWith('run_command'));
    expect(runs).toHaveLength(2);
    const [failed, passed] = runs as [(typeof runs)[0], (typeof runs)[0]];
    const done = events.find((e) => e.sequence === failed.endSeq)!;
    expect(done.type).toBe('tool.call_completed');

    expect(failed.status).toBe('error');
    expect(failed.title).toBe(`run_command ${CODING_MISSION.testCommand}`);
    expect(failed.detail).toBe('12 tests: 10 passed, 2 failed');
    expect(failed.metrics).toEqual({ tests: 12, passed: 10, failed: 2 });
    expect(failed.failingTests).toEqual([...CODING_MISSION.failingTests]);
    expect(failed.durationMs).toBe(380);
    expect(failed.artifactIds).toEqual(['art-2']);
    expect(failed.actorId).toBe('tester');

    expect(passed.status).toBe('ok');
    expect(passed.metrics).toEqual({ tests: 12, passed: 12, failed: 0 });
    expect(passed.seq).toBeGreaterThan(failed.seq);
  });

  it('shows a tool as running while the playhead is between start and end', () => {
    const r = rows.find((x) => x.title.startsWith('run_command'))!;
    expect(rowStatusAt(r, r.seq)).toBe('running');
    expect(rowStatusAt(r, r.endSeq! - 1)).toBe('running');
    expect(rowStatusAt(r, r.endSeq!)).toBe('error');
    expect(rowStatusAt(r, r.seq - 1)).toBe('error'); // not started yet: final status (dimmed in the UI)
    const info = rows.find((x) => x.type === 'task.created')!;
    expect(rowStatusAt(info, 0)).toBe('info');
  });

  it('attributes task events to their owner and run events to the system', () => {
    const blocked = rows.find((r) => r.type === 'task.blocked')!;
    expect(blocked.actorId).toBe('tester');
    expect(blocked.status).toBe('warn');
    expect(rows[0]!.type).toBe('run.started');
    expect(rows[0]!.actorId).toBe('system');
    expect(rows.at(-1)!.type).toBe('run.completed');
    expect(rows.at(-1)!.status).toBe('ok');
  });

  it('keeps rows in sequence order with times from the index', () => {
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (const r of rows) expect(r.tMs).toBe(timeOfSeq(r.seq));
  });

  it('formats durations', () => {
    expect(formatDuration(380)).toBe('380 ms');
    expect(formatDuration(1450)).toBe('1.4 s');
    expect(formatDuration(125_000)).toBe('2 m 05 s');
  });
});
