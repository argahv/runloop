import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture, runBuilder } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { flowChips, formatClockPair } from './view';

const events = codingMissionFixture();
const at = (pred: (e: (typeof events)[number]) => boolean) => foldExecution(events.slice(0, events.findIndex(pred) + 1));
const statuses = (exec: ReturnType<typeof foldExecution>) => Object.fromEntries(flowChips(exec).map((c) => [c.kind, c.view.text]));

describe('agent flow chips', () => {
  it('follow the mission: current, then done', () => {
    expect(statuses(at((e) => e.type === 'task.started'))).toEqual({
      research: 'in progress',
      code: 'pending',
      test: 'pending',
    });
    expect(statuses(at((e) => e.type === 'task.blocked'))).toEqual({
      research: 'done',
      code: 'done',
      test: 'blocked',
      fix: 'pending',
    });
    const final = flowChips(foldExecution(events));
    expect(final.map((c) => c.label)).toEqual(['Research', 'Code', 'Test', 'Fix']);
    expect(final.every((c) => c.status === 'done' && c.view.icon === '✓')).toBe(true);
  });

  it('shows open work of an ended run as unfinished, not in progress', () => {
    const toolStart = events.findIndex((e) => e.type === 'tool.call_started' && e.payload.tool === 'write_file');
    const b = runBuilder({ runId: events[0]!.runId });
    for (const e of events.slice(0, toolStart + 1)) b.add(e.type, e.payload as never);
    expect(statuses(foldExecution(b.events)).code).toBe('in progress');
    b.add('run.completed', { outcome: 'stopped', summary: 'Stopped by user' });
    const chips = flowChips(foldExecution(b.events));
    expect(Object.fromEntries(chips.map((c) => [c.kind, c.view.text]))).toEqual({
      research: 'done',
      code: 'unfinished',
      test: 'pending',
    });
    expect(chips[1]!.view.icon).toBe('■');
  });

  it('marks a failed task kind as failed with an icon and text', () => {
    const b = runBuilder();
    b.add('run.started', {
      title: 't',
      missionId: 'm',
      worldId: 'research-campus',
      seed: 1,
      adapter: { id: 'a', kind: 'scripted', label: 'A' },
      workspace: 'w',
    });
    b.add('agent.registered', { agentId: 'a1', name: 'A1', role: 'test', model: null, tools: [], embodied: true });
    b.add('task.created', { taskId: 'T1', title: 'Deploy', kind: 'deploy', dependsOn: [] });
    b.add('task.assigned', { taskId: 'T1', agentId: 'a1' });
    b.add('task.started', { taskId: 'T1', agentId: 'a1' });
    b.add('task.failed', { taskId: 'T1', reason: 'boom' });
    const [chip] = flowChips(foldExecution(b.events));
    expect(chip).toMatchObject({ kind: 'deploy', status: 'failed', label: 'Deploy' });
    expect(chip!.view).toEqual({ icon: '✗', text: 'failed', tone: 'err' });
  });
});

describe('formatClockPair', () => {
  it('formats "mm:ss / mm:ss"', () => {
    expect(formatClockPair(92_000, 195_000)).toBe('01:32 / 03:15');
    expect(formatClockPair(0, 0)).toBe('00:00 / 00:00');
    expect(formatClockPair(-5, 999)).toBe('00:00 / 00:00');
  });
});
