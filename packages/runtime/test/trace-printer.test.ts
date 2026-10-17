import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { TracePrinter } from '../src/trace-printer';

describe('TracePrinter', () => {
  it('prints one line per event from payload fields', () => {
    const p = new TracePrinter();
    const lines = codingMissionFixture().map((e) => p.format(e));
    expect(lines).toHaveLength(58);
    expect(lines[0]).toMatch(/^#001 00:00\.0 system {6}run\.started {10}Run started: Build a task store/);
    const failed = lines.find((l) => l.includes('run_command error'))!;
    expect(failed).toMatch(
      /^#036 \d\d:\d\d\.\d tester {6}tool\.call_completed  run_command error · 10 passed, 2 failed — 12 tests: 10 passed, 2 failed/,
    );
    expect(lines.find((l) => l.includes('task.started') && l.includes('Started T3 (attempt 2)'))).toBeDefined();
    expect(lines.at(-1)).toMatch(/run\.completed {8}Run succeeded/);
  });

  it('starts over for a different run', () => {
    const p = new TracePrinter();
    const a = codingMissionFixture();
    p.format(a[0]!);
    const b = codingMissionFixture({ runId: 'other-run' });
    expect(p.format(b[0]!)).toMatch(/^#001 00:00\.0 system/);
  });
});
