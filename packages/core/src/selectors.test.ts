import type { RunEvent } from '@runloop-world/events';
import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { foldExecution } from './reduce-execution';
import {
  selectAgentFlow,
  selectEmbodiedAgents,
  selectOpenIncidents,
  selectReadyTasks,
  selectRecentActions,
  selectTaskProgress,
} from './selectors';

const events = codingMissionFixture();
/** State right after the first event matching `pred`. */
function after(pred: (e: RunEvent) => boolean) {
  const e = events.find(pred);
  if (!e) throw new Error('no such event');
  return foldExecution(events.slice(0, e.sequence));
}
const completed = (taskId: string) => (e: RunEvent) => e.type === 'task.completed' && e.payload.taskId === taskId;

describe('selectors', () => {
  it('selectReadyTasks respects dependencies', () => {
    const created = after((e) => e.type === 'task.created' && e.payload.taskId === 'T3');
    expect(selectReadyTasks(created).map((t) => t.id)).toEqual(['T1']);
    expect(selectReadyTasks(after(completed('T1'))).map((t) => t.id)).toEqual(['T2']);
    expect(selectReadyTasks(after(completed('T2'))).map((t) => t.id)).toEqual(['T3']);
    expect(selectReadyTasks(foldExecution(events))).toEqual([]);
  });

  it('selectRecentActions lists an agent’s calls newest first', () => {
    const s = foldExecution(events);
    expect(selectRecentActions(s, 'builder').map((c) => c.id)).toEqual(['call-8', 'call-7', 'call-5', 'call-4']);
    expect(selectRecentActions(s, 'builder', 2).map((c) => c.id)).toEqual(['call-8', 'call-7']);
    expect(selectRecentActions(s, 'coordinator')).toEqual([]);
  });

  it('selectTaskProgress follows finished steps of the current attempt', () => {
    const firstCall = after((e) => e.type === 'tool.call_completed' && e.payload.callId === 'call-1');
    expect(selectTaskProgress(firstCall, 'T1')).toBeCloseTo(1 / 3);
    expect(selectTaskProgress(firstCall, 'T2')).toBe(0);
    expect(selectTaskProgress(after(completed('T1')), 'T1')).toBe(1);
    expect(selectTaskProgress(firstCall, 'missing')).toBeNull();

    // T3's retry starts again from zero.
    const retry = after((e) => e.type === 'task.started' && e.payload.taskId === 'T3' && e.sequence > 40);
    expect(selectTaskProgress(retry, 'T3')).toBe(0);
  });

  it('selectTaskProgress is null without plannedSteps', () => {
    const s = foldExecution(events.slice(0, 6));
    const t1 = s.tasks.T1!;
    const noPlan = { ...s, tasks: { ...s.tasks, T1: { ...t1, plannedSteps: null } } };
    expect(selectTaskProgress(noPlan, 'T1')).toBeNull();
  });

  it('selectAgentFlow has one chip per task kind with live status', () => {
    const kinds = (s: ReturnType<typeof foldExecution>) => selectAgentFlow(s).map((c) => `${c.kind}:${c.status}`);
    expect(kinds(after((e) => e.type === 'task.started'))).toEqual(['research:current', 'code:pending', 'test:pending']);
    expect(kinds(after((e) => e.type === 'task.blocked'))).toEqual([
      'research:done',
      'code:done',
      'test:blocked',
      'fix:pending',
    ]);
    expect(kinds(foldExecution(events))).toEqual(['research:done', 'code:done', 'test:done', 'fix:done']);
    expect(selectAgentFlow(foldExecution(events))[2]!.taskIds).toEqual(['T3']);
  });

  it('selectEmbodiedAgents skips the coordinator', () => {
    expect(selectEmbodiedAgents(foldExecution(events)).map((a) => a.id)).toEqual(['researcher', 'builder', 'tester']);
  });

  it('selectOpenIncidents drops incidents once their task completes', () => {
    const failing = after((e) => e.type === 'tool.call_completed' && e.payload.status === 'error');
    expect(selectOpenIncidents(failing).map((i) => i.refId)).toEqual(['call-6']);
    expect(selectOpenIncidents(foldExecution(events))).toEqual([]);
  });
});
