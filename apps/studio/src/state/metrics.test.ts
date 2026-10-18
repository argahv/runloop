import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture, runBuilder } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { computeRunMetrics, toolsInCategory } from './metrics';
import { tracedFixture } from './test-utils';

const metricsOf = (events: ReturnType<typeof tracedFixture>) => computeRunMetrics(foldExecution(events), events);

describe('run metrics: traced run', () => {
  const events = tracedFixture();
  const m = metricsOf(events);

  it('measures duration from run start to run end', () => {
    const start = Date.parse(events[0]!.timestamp);
    const end = Date.parse(events.at(-1)!.timestamp);
    expect(m.duration).toEqual({ ms: end - start, running: false });
    expect(m.events).toBe(events.length);
  });

  it('counts tool calls by status, category and tool', () => {
    expect(m.calls).toMatchObject({ total: 5, success: 3, error: 1, couldNotRun: 1, running: 0, inferred: 1, categorised: 5 });
    expect(m.calls.byCategory).toEqual([
      { key: 'test', count: 2, errors: 1 },
      { key: 'delegate', count: 1, errors: 0 },
      { key: 'deploy', count: 1, errors: 1 },
      { key: 'read', count: 1, errors: 0 },
    ]);
    expect(m.calls.byTool[0]).toEqual({ key: 'Bash', count: 3, errors: 2 });
  });

  it('reports tests exactly as the runner reported them, latest run last', () => {
    expect(m.tests).toMatchObject({ runs: 2, failingRuns: 1, latest: { tests: 12, passed: 12, failed: 0, callId: 'c-test2' } });
  });

  it('keeps usage per agent as reported and never turns "not reported" into zero', () => {
    const byId = Object.fromEntries(m.usage.agents.map((a) => [a.agentId, a]));
    expect(Object.keys(byId)).toEqual(['main', 'sa-1']); // the user is not an agent that spends tokens
    expect(byId.main).toMatchObject({ usage: null, totalTokens: null, model: null, reportedBy: null });
    expect(byId['sa-1']).toMatchObject({ totalTokens: 20520, model: 'claude-haiku-5-5', reportedBy: 'reported by Claude Code (Agent tool result)' });
    expect(m.usage).toMatchObject({ reportedAgents: 1, reportedTotal: 20520 });
    expect(m.cost).toBeNull();
  });

  it('counts permissions and leaves out wait times Runloop only inferred', () => {
    expect(m.permissions).toEqual({ requested: 1, approved: 0, denied: 1, pending: 0, inferred: 1, waits: null });
  });

  it('counts failures, turns and delegations', () => {
    expect(m.failures.total).toBe(2);
    expect(m.failures.byKind).toEqual({ tool_error: 1, tool_failed: 1 });
    expect(m.failures.firstSeq).toBe(events.find((e) => e.type === 'tool.call_completed' && e.payload.status === 'error')!.sequence);
    expect(m.turns).toBe(1);
    expect(m.delegations).toBe(1);
    expect(m.traced).toBe(true);
  });

  it('reports a run in progress as running, measured to its last event', () => {
    const cut = events.findIndex((e) => e.type === 'agent.usage_reported') + 1;
    const partial = computeRunMetrics(foldExecution(events.slice(0, cut)), events.slice(0, cut));
    expect(partial.duration).toEqual({ ms: Date.parse(events[cut - 1]!.timestamp) - Date.parse(events[0]!.timestamp), running: true });
    expect(partial.calls.running).toBe(1); // the permission-gated call is still open
    expect(partial.permissions.pending).toBe(1);
    expect(partial.tests!.latest.failed).toBe(2);
  });
});

describe('run metrics: executed demo', () => {
  const events = codingMissionFixture();
  const m = computeRunMetrics(foldExecution(events), events);

  it('categories come from Runloop’s own tools (as in compare); tokens and turns stay unreported, not zero', () => {
    expect(m.traced).toBe(false);
    expect(m.calls.categorised).toBe(m.calls.total);
    expect(m.calls.byCategory.map((r) => [r.key, r.count, r.errors])).toEqual([
      ['read', 4, 0],
      ['edit', 2, 0],
      ['test', 2, 1],
      ['search', 1, 0],
    ]);
    expect(toolsInCategory(foldExecution(events), 'test')).toEqual(['run_command']);
    expect(m.calls.byTool.length).toBeGreaterThan(0);
    expect(m.usage.reportedTotal).toBeNull();
    expect(m.usage.agents.every((a) => a.totalTokens === null)).toBe(true);
    expect(m.turns).toBeNull();
  });

  it('reads the failing then passing test runs from the payload metrics', () => {
    expect(m.tests).toMatchObject({ runs: 2, failingRuns: 1, latest: { tests: 12, passed: 12, failed: 0 } });
  });

  it('records no permission requests (none happened), as zero counts and no waits', () => {
    expect(m.permissions).toEqual({ requested: 0, approved: 0, denied: 0, pending: 0, inferred: 0, waits: null });
  });
});

describe('run metrics: permission waits', () => {
  it('times answers that were recorded, from request to answer', () => {
    const b = runBuilder();
    b.add('run.started', { title: 't', missionId: 'm', worldId: 'w', seed: 1, adapter: { id: 'a', kind: 'scripted', label: 'A' }, workspace: 'w' });
    b.add('agent.registered', { agentId: 'a1', name: 'A1', role: 'x', model: null, tools: [], embodied: true });
    b.add('tool.permission_requested', { permissionId: 'p1', agentId: 'a1', action: 'deploy', scope: 'prod' });
    b.wait(2500);
    b.add('tool.permission_resolved', { permissionId: 'p1', decision: 'approved', by: 'user' });
    b.add('tool.permission_requested', { permissionId: 'p2', agentId: 'a1', action: 'push', scope: 'repo' });
    b.wait(500);
    b.add('tool.permission_resolved', { permissionId: 'p2', decision: 'denied', by: 'user' });
    b.add('tool.permission_requested', { permissionId: 'p3', agentId: 'a1', action: 'rm', scope: 'repo' });
    const m = computeRunMetrics(foldExecution(b.events), b.events);
    expect(m.permissions).toEqual({ requested: 3, approved: 1, denied: 1, pending: 1, inferred: 0, waits: { count: 2, totalMs: 3000, longestMs: 2500 } });
  });
});

describe('run metrics: empty and partial runs', () => {
  it('has no duration before run.started and nothing reported', () => {
    const m = computeRunMetrics(foldExecution([]), []);
    expect(m.duration).toBeNull();
    expect(m.tests).toBeNull();
    expect(m.usage.reportedTotal).toBeNull();
    expect(m.calls.total).toBe(0);
  });

  it('sums the reported parts when the source gave no total', () => {
    const b = runBuilder();
    b.add('run.started', { title: 't', missionId: 'm', worldId: 'w', seed: 1, adapter: { id: 'a', kind: 'scripted', label: 'A' }, workspace: 'w' });
    b.add('agent.registered', { agentId: 'a1', name: 'A1', role: 'x', model: null, tools: [], embodied: true });
    b.add('agent.usage_reported', { agentId: 'a1', model: null, inputTokens: 10, outputTokens: 5, source: 'test' });
    const m = computeRunMetrics(foldExecution(b.events), b.events);
    expect(m.usage.agents[0]).toMatchObject({ totalTokens: 15, model: null, reportedBy: 'reported by test' });
  });
});
