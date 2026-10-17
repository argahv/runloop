import type { AnyEvent, RunEvent, UnknownEvent } from '@runloop-world/events';
import { CODING_MISSION, codingMissionFixture, runBuilder, type RunBuilder } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { SequenceGapError } from './errors';
import { IdMap } from './id-map';
import { foldExecution, initialExecState, reduceExecution, transient } from './reduce-execution';

/** run.started + one embodied agent "a1" + task "T1" (code). */
function base(): RunBuilder {
  const b = runBuilder();
  b.add('run.started', {
    title: 't',
    missionId: 'm',
    worldId: 'research-campus',
    seed: 1,
    adapter: { id: 'x', kind: 'scripted', label: 'X' },
    workspace: 'workspaces/x',
  });
  b.add('agent.registered', { agentId: 'a1', name: 'A1', role: 'build', model: null, tools: [], embodied: true });
  b.add('task.created', { taskId: 'T1', title: 'do', kind: 'code', dependsOn: [] });
  return b;
}

function unknownEvent(seq: number, runId: string): UnknownEvent {
  return {
    eventId: `00000001-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
    runId,
    sequence: seq,
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'world.teleported',
    schemaVersion: 1,
    visibility: 'public',
    payload: {},
    unknown: true,
    reason: 'unknown_type',
  };
}

describe('reduceExecution — coding mission fixture', () => {
  const events = codingMissionFixture();
  const s = foldExecution(events);
  const M = CODING_MISSION;

  it('ends with the run succeeded and every task completed', () => {
    expect(s.lastSequence).toBe(events.length);
    expect(s.run.status).toBe('succeeded');
    expect(s.run.title).toBe(M.title);
    expect(s.run.adapter?.label).toBe(M.adapter.label);
    expect(s.runStartMs).toBe(Date.parse(events[0]!.timestamp));
    expect(s.taskOrder).toEqual(['T1', 'T2', 'T3', 'T4']);
    for (const id of s.taskOrder) expect(s.tasks[id]!.status).toBe('completed');
    expect(s.anomalies).toEqual([]);
  });

  it('counts the test task retry as a second attempt', () => {
    expect(s.tasks.T3!.attempts).toBe(2);
    expect(s.tasks.T1!.attempts).toBe(1);
    expect(s.tasks.T3!.callIds).toEqual(['call-6', 'call-9']);
  });

  it('records exactly one tool_error incident (the real failing test run), resolved when T3 completed', () => {
    expect(s.incidents).toHaveLength(1);
    const inc = s.incidents[0]!;
    expect(inc).toMatchObject({ kind: 'tool_error', refId: 'call-6', agentId: 'tester', taskId: 'T3' });
    expect(inc.message).toBe('12 tests: 10 passed, 2 failed');
    const t3Done = events.find((e) => e.type === 'task.completed' && e.payload.taskId === 'T3')!;
    expect(inc.resolvedSeq).toBe(t3Done.sequence);
    expect(s.toolCalls.get('call-6')!.metrics).toEqual({ tests: 12, passed: 10, failed: 2 });
    expect(s.toolCalls.get('call-6')!.status).toBe('error');
    expect(s.toolCalls.get('call-9')!.status).toBe('success');
  });

  it('leaves agents without current work and remembers their last outcome', () => {
    expect(s.agentOrder).toEqual(['coordinator', 'researcher', 'builder', 'tester']);
    expect(s.agents.coordinator!.embodied).toBe(false);
    for (const id of s.agentOrder) {
      expect(s.agents[id]!.currentTaskId).toBeNull();
      expect(s.agents[id]!.activeCallId).toBeNull();
    }
    expect(s.agents.tester!.lastTaskOutcome).toMatchObject({ taskId: 'T3', status: 'completed' });
    expect(s.agents.builder!.lastTaskOutcome).toMatchObject({ taskId: 'T4', status: 'completed' });
  });

  it('keeps artifacts, messages and creators', () => {
    expect(s.artifactOrder).toEqual(['art-1', 'art-2', 'art-3', 'art-4']);
    expect(s.artifacts['art-2']).toMatchObject({ agentId: 'tester', taskId: 'T3', producedByCallId: 'call-6' });
    expect(s.messages.map((m) => m.messageId)).toEqual(['msg-1', 'msg-2']);
    expect(s.tasks.T4!.createdBy).toBe('coordinator');
  });

  it('marks the test task blocked (owner keeps it) while the fix is pending', () => {
    const blocked = events.find((e) => e.type === 'task.blocked')!;
    const mid = foldExecution(events.slice(0, blocked.sequence));
    expect(mid.tasks.T3!.status).toBe('blocked');
    expect(mid.tasks.T3!.blockedBy).toEqual(['T4']);
    expect(mid.agents.tester!.currentTaskId).toBe('T3');
    const waiting = events.find((e) => e.type === 'agent.state_changed' && e.payload.state === 'waiting')!;
    expect(foldExecution(events.slice(0, waiting.sequence)).agents.tester).toMatchObject({
      state: 'waiting',
      stateReason: 'waiting for a fix',
      currentTaskId: 'T3',
    });
  });
});

describe('reduceExecution — ordering rules', () => {
  const events = codingMissionFixture();

  it('returns the same reference for an already-folded sequence', () => {
    const s = foldExecution(events.slice(0, 10));
    expect(reduceExecution(s, events[9]!)).toBe(s);
    expect(reduceExecution(s, events[0]!)).toBe(s);
  });

  it('throws SequenceGapError on a gap', () => {
    const s = foldExecution(events.slice(0, 3));
    let err: unknown;
    try {
      reduceExecution(s, events[4]!);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SequenceGapError);
    expect(err).toMatchObject({ expected: 4, got: 5 });
  });

  it('is pure and structurally shared', () => {
    const s = foldExecution(events.slice(0, 20));
    const snapshot = JSON.stringify(s);
    const next = reduceExecution(s, events[20]!); // task.assigned T2 → builder
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(next).not.toBe(s);
    expect(next.agents.researcher).toBe(s.agents.researcher);
    expect(next.toolCalls).toBe(s.toolCalls);
    expect(next.tasks.T1).toBe(s.tasks.T1);
    expect(next.tasks.T2).not.toBe(s.tasks.T2);
  });

  it('records unknown events as anomalies and still advances', () => {
    const s = foldExecution(events.slice(0, 2));
    const next = reduceExecution(s, unknownEvent(3, s.runId!));
    expect(next.lastSequence).toBe(3);
    expect(next.anomalies).toEqual([{ seq: 3, code: 'unknown_event', detail: 'world.teleported: unknown_type' }]);
    // …and the next real event folds normally after it.
    const shifted = { ...events[2]!, sequence: 4 } as AnyEvent;
    expect(reduceExecution(next, shifted).lastSequence).toBe(4);
  });
});

describe('reduceExecution — semantics', () => {
  it('turns contradictions into anomalies instead of throwing', () => {
    const b = base();
    b.add('tool.call_completed', { callId: 'nope', status: 'success', durationMs: 1, outputSummary: '' });
    b.add('task.assigned', { taskId: 'T9', agentId: 'a1' });
    b.add('agent.registered', { agentId: 'a1', name: 'A1', role: 'build', model: null, tools: [], embodied: true });
    b.add('task.created', { taskId: 'T2', title: 'x', kind: 'test', dependsOn: ['T7'] });
    b.add('task.created', { taskId: 'T3', title: 'loop', kind: 'test', dependsOn: ['T3'] });
    b.add('agent.state_changed', { agentId: 'ghost', state: 'working' });
    b.add('tool.permission_resolved', { permissionId: 'p0', decision: 'approved', by: 'user' });
    const s = foldExecution(b.events);
    expect(s.anomalies.map((a) => a.code)).toEqual([
      'unknown_call',
      'unknown_task',
      'duplicate_id',
      'unknown_dependency',
      'dependency_cycle',
      'unknown_agent',
      'unknown_permission',
    ]);
    expect(s.lastSequence).toBe(b.events.length);
  });

  it('increments attempts on every task.started and resets per-attempt steps', () => {
    const b = base();
    b.add('task.assigned', { taskId: 'T1', agentId: 'a1' });
    b.add('task.started', { taskId: 'T1', agentId: 'a1' });
    b.add('tool.call_started', { callId: 'c1', agentId: 'a1', taskId: 'T1', tool: 'write_file', inputSummary: 'x' });
    b.add('tool.call_failed', { callId: 'c1', errorType: 'timeout', message: 'took too long', durationMs: 30000 });
    b.add('task.failed', { taskId: 'T1', reason: 'tool timed out', errorType: 'timeout' });
    let s = foldExecution(b.events);
    expect(s.tasks.T1).toMatchObject({ status: 'failed', attempts: 1, stepsDoneThisAttempt: 1 });
    expect(s.tasks.T1!.failure).toEqual({ reason: 'tool timed out', errorType: 'timeout' });
    expect(s.agents.a1!.currentTaskId).toBeNull();
    expect(s.agents.a1!.lastTaskOutcome).toMatchObject({ taskId: 'T1', status: 'failed' });
    expect(s.incidents.map((i) => i.kind)).toEqual(['tool_failed', 'task_failed']);
    expect(s.incidents[0]!.message).toBe('timeout: took too long');

    b.add('task.started', { taskId: 'T1', agentId: 'a1' });
    s = foldExecution(b.events);
    expect(s.tasks.T1).toMatchObject({ status: 'in_progress', attempts: 2, stepsDoneThisAttempt: 0 });
    expect(s.agents.a1!.currentTaskId).toBe('T1');

    b.add('task.completed', { taskId: 'T1', summary: 'ok', artifactIds: [] });
    s = foldExecution(b.events);
    expect(s.incidents.every((i) => i.resolvedSeq === b.events.length)).toBe(true);
  });

  it('tracks tool calls, the active call and per-attempt steps', () => {
    const b = base();
    b.add('task.started', { taskId: 'T1', agentId: 'a1' });
    b.add('tool.call_started', { callId: 'c1', agentId: 'a1', taskId: 'T1', tool: 'read_file', inputSummary: 'a.js' });
    let s = foldExecution(b.events);
    expect(s.agents.a1!.activeCallId).toBe('c1');
    expect(s.toolCalls.get('c1')!.status).toBe('running');
    b.add('tool.call_completed', { callId: 'c1', status: 'success', durationMs: 3, outputSummary: 'read 3 bytes' });
    b.add('tool.call_completed', { callId: 'c1', status: 'success', durationMs: 3, outputSummary: 'again' });
    s = foldExecution(b.events);
    expect(s.agents.a1!.activeCallId).toBeNull();
    expect(s.toolCalls.get('c1')).toMatchObject({ status: 'success', durationMs: 3, outputSummary: 'read 3 bytes' });
    expect(s.tasks.T1!.stepsDoneThisAttempt).toBe(1);
    expect(s.anomalies.map((a) => a.code)).toEqual(['invalid_transition']);
  });

  it('handles pause / resume and a failed run', () => {
    const b = base();
    b.add('run.paused', { reason: 'user' });
    expect(foldExecution(b.events).run.status).toBe('paused');
    b.add('run.resumed', {});
    expect(foldExecution(b.events).run.status).toBe('running');
    b.add('run.completed', { outcome: 'failed', summary: 'tests still failing' });
    const s = foldExecution(b.events);
    expect(s.run).toMatchObject({ status: 'failed', summary: 'tests still failing' });
    expect(s.incidents).toMatchObject([{ kind: 'run_failed', refId: b.runId, message: 'tests still failing' }]);
    b.add('run.resumed', {});
    expect(foldExecution(b.events).anomalies.map((a) => a.code)).toEqual(['invalid_transition']);
  });

  it('tracks permission requests on the agent', () => {
    const b = base();
    b.add('tool.permission_requested', { permissionId: 'p1', agentId: 'a1', action: 'deploy', scope: 'prod' });
    let s = foldExecution(b.events);
    expect(s.agents.a1!.pendingPermissionId).toBe('p1');
    expect(s.permissions.p1!.status).toBe('pending');
    b.add('tool.permission_resolved', { permissionId: 'p1', decision: 'denied', by: 'user' });
    s = foldExecution(b.events);
    expect(s.agents.a1!.pendingPermissionId).toBeNull();
    expect(s.permissions.p1).toMatchObject({ status: 'denied', resolvedBy: 'user', resolvedSeq: b.events.length });
  });

  it('moves a task to its new owner on reassignment', () => {
    const b = base();
    b.add('agent.registered', { agentId: 'a2', name: 'A2', role: 'build', model: null, tools: [], embodied: true });
    b.add('task.assigned', { taskId: 'T1', agentId: 'a1' });
    b.add('task.assigned', { taskId: 'T1', agentId: 'a2' });
    const s = foldExecution(b.events);
    expect(s.tasks.T1).toMatchObject({ ownerId: 'a2', status: 'assigned' });
    expect(s.agents.a1!.currentTaskId).toBeNull();
    expect(s.agents.a2!.currentTaskId).toBe('T1');
  });

  it('folds from a given state', () => {
    const events: RunEvent[] = codingMissionFixture();
    const half = foldExecution(events.slice(0, 30));
    expect(foldExecution(events.slice(30), half)).toEqual(foldExecution(events));
    expect(foldExecution([], initialExecState())).toEqual(initialExecState());
  });
});

describe('reduceExecution — traced runs', () => {
  /** A traced run.started (no seed or workspace) with main embodied and a turn task. */
  function traced(): RunBuilder {
    const b = runBuilder();
    b.add(
      'run.started',
      {
        title: 'Claude Code · demo',
        missionId: 'claude-code',
        worldId: 'research-campus',
        adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code' },
        mode: 'traced',
        source: { kind: 'claude-code', sessionId: 's1', segment: 1, projectLabel: 'demo', model: null },
      },
      { provenance: 'reported' },
    );
    b.add('agent.registered', { agentId: 'main', name: 'Claude', role: 'main', model: null, tools: [], embodied: true });
    b.add('task.created', { taskId: 'turn-1', title: 'Turn 1', kind: 'turn', dependsOn: [] });
    b.add('task.started', { taskId: 'turn-1', agentId: 'main' });
    return b;
  }

  it('stores the mode and source; traced runs have no seed or workspace', () => {
    const s = foldExecution(traced().events);
    expect(s.run).toMatchObject({ mode: 'traced', seed: null, workspace: null, status: 'running' });
    expect(s.run.source).toMatchObject({ kind: 'claude-code', sessionId: 's1', segment: 1 });
    expect(s.anomalies).toEqual([]);
    const executed = foldExecution(codingMissionFixture());
    expect(executed.run).toMatchObject({ mode: 'executed', source: null, seed: CODING_MISSION.seed });
  });

  it('remembers the category of the last call per agent, and its task', () => {
    const b = traced();
    b.add('tool.call_started', { callId: 'c1', agentId: 'main', taskId: 'turn-1', tool: 'Read', category: 'read', inputSummary: 'a.ts' }, { provenance: 'reported' });
    b.add('tool.call_completed', { callId: 'c1', status: 'success', durationMs: 5, outputSummary: '3 lines' }, { provenance: 'inferred' });
    let s = foldExecution(b.events);
    expect(s.agents.main!.activeCallId).toBeNull();
    expect(s.agents.main!.lastCategory).toEqual({ category: 'read', taskId: 'turn-1' });
    expect(s.toolCalls.get('c1')).toMatchObject({ category: 'read', startProvenance: 'reported', endProvenance: 'inferred' });
    // A call without a category (an executed run's) leaves it alone.
    b.add('tool.call_started', { callId: 'c2', agentId: 'main', taskId: 'turn-1', tool: 'x', inputSummary: '' });
    s = foldExecution(b.events);
    expect(s.agents.main!.lastCategory).toEqual({ category: 'read', taskId: 'turn-1' });
    expect(s.toolCalls.get('c2')!.category).toBeNull();
  });

  it('records markers and usage reports (never inventing usage for silent agents)', () => {
    const b = traced();
    b.add('agent.registered', { agentId: 'sa-1', name: 'Explore #1', role: 'Explore', model: null, tools: [], embodied: true });
    b.add('run.marker', { kind: 'compaction', label: 'Compaction started', agentId: 'main' }, { provenance: 'reported' });
    b.add('agent.usage_reported', {
      agentId: 'sa-1',
      model: 'claude-haiku-5-5',
      inputTokens: 2,
      outputTokens: 193,
      cacheReadTokens: 19620,
      cacheCreationTokens: 705,
      totalTokens: 20520,
      source: 'claude-code.agent_result',
    });
    b.add('run.marker', { kind: 'other', label: 'x', agentId: 'ghost' });
    const s = foldExecution(b.events);
    expect(s.markers.map((m) => [m.kind, m.label, m.agentId, m.provenance])).toEqual([
      ['compaction', 'Compaction started', 'main', 'reported'],
      ['other', 'x', 'ghost', null],
    ]);
    expect(s.usageReports).toHaveLength(1);
    expect(s.agents['sa-1']!.usage).toMatchObject({ inputTokens: 2, outputTokens: 193, totalTokens: 20520 });
    expect(s.agents.main!.usage).toBeNull();
    expect(s.anomalies.map((a) => a.code)).toEqual(['unknown_agent']);
  });

  it('records the provenance of a permission resolution', () => {
    const b = traced();
    b.add('tool.permission_requested', { permissionId: 'perm-1', agentId: 'main', action: 'Bash', scope: 'default' }, { provenance: 'reported' });
    b.add('tool.permission_resolved', { permissionId: 'perm-1', decision: 'denied', by: 'user' }, { provenance: 'inferred' });
    expect(foldExecution(b.events).permissions['perm-1']).toMatchObject({ status: 'denied', resolvedProvenance: 'inferred' });
  });

  /** A traced failing test run, the end of its turn, then (optionally) a passing rerun. */
  function failingTurn(b: RunBuilder, opts: { endProvenance?: 'reported' | 'inferred' } = {}) {
    const meta = { provenance: 'reported' as const };
    b.add('tool.call_started', { callId: 't1', agentId: 'main', taskId: 'turn-1', tool: 'Bash', category: 'test', inputSummary: 'node --test' }, meta);
    b.add('tool.call_completed', { callId: 't1', status: 'error', durationMs: 300, exitCode: 1, outputSummary: 'Exit code 1', metrics: { tests: 12, passed: 10, failed: 2 } }, meta);
    b.add('task.completed', { taskId: 'turn-1', summary: 'Done', artifactIds: [] }, { provenance: opts.endProvenance ?? 'reported' });
    return b;
  }

  it('a traced failure stays open when the turn ends (Claude stopping fixes nothing)', () => {
    for (const endProvenance of ['reported', 'inferred'] as const) {
      const s = foldExecution(failingTurn(traced(), { endProvenance }).events);
      expect(s.incidents).toHaveLength(1);
      expect(s.incidents[0]).toMatchObject({ kind: 'tool_error', resolvedSeq: null, resolution: null });
    }
  });

  it('a later passing run of the same kind resolves a traced failure (inferred: later_success)', () => {
    const b = failingTurn(traced());
    b.add('task.created', { taskId: 'turn-2', title: 'Turn 2', kind: 'turn', dependsOn: [] });
    b.add('task.started', { taskId: 'turn-2', agentId: 'main' });
    const meta = { provenance: 'reported' as const };
    // A piped run that exits 0 but still reports failures does not resolve it.
    b.add('tool.call_started', { callId: 't2', agentId: 'main', taskId: 'turn-2', tool: 'Bash', category: 'test', inputSummary: 'node --test | tail' }, meta);
    b.add('tool.call_completed', { callId: 't2', status: 'success', durationMs: 300, outputSummary: '10/12', metrics: { tests: 12, passed: 10, failed: 2 } }, meta);
    expect(foldExecution(b.events).incidents[0]!.resolvedSeq).toBeNull();
    b.add('tool.call_started', { callId: 't3', agentId: 'main', taskId: 'turn-2', tool: 'Bash', category: 'test', inputSummary: 'npm test' }, meta);
    const passed = b.add('tool.call_completed', { callId: 't3', status: 'success', durationMs: 300, outputSummary: '12/12', metrics: { tests: 12, passed: 12, failed: 0 } }, meta);
    const s = foldExecution(b.events);
    expect(s.incidents[0]).toMatchObject({ resolvedSeq: passed.sequence, resolution: 'later_success' });
    expect(s.anomalies).toEqual([]);
  });

  it('other traced failures resolve only when the same input later succeeds', () => {
    const b = traced();
    const meta = { provenance: 'reported' as const };
    b.add('tool.call_started', { callId: 'r1', agentId: 'main', taskId: 'turn-1', tool: 'Read', category: 'read', inputSummary: 'NOTES.md' }, meta);
    b.add('tool.call_completed', { callId: 'r1', status: 'error', durationMs: 3, outputSummary: 'File does not exist' }, meta);
    b.add('tool.call_started', { callId: 'r2', agentId: 'main', taskId: 'turn-1', tool: 'Read', category: 'read', inputSummary: 'src/a.ts' }, meta);
    b.add('tool.call_completed', { callId: 'r2', status: 'success', durationMs: 3, outputSummary: 'Read 3 lines' }, meta);
    expect(foldExecution(b.events).incidents[0]!.resolvedSeq).toBeNull();
    b.add('tool.call_started', { callId: 'r3', agentId: 'main', taskId: 'turn-1', tool: 'Read', category: 'read', inputSummary: 'NOTES.md' }, meta);
    b.add('tool.call_completed', { callId: 'r3', status: 'success', durationMs: 3, outputSummary: 'Read 1 line' }, meta);
    expect(foldExecution(b.events).incidents[0]).toMatchObject({ resolution: 'later_success' });
  });
});

describe('batch folds (transient)', () => {
  it('equal the event-by-event fold and never change the state they start from', () => {
    const events = codingMissionFixture();
    let plain = initialExecState();
    for (const e of events) plain = reduceExecution(plain, e);
    const half = foldExecution(events.slice(0, 30));
    const snapshot = JSON.stringify(half);
    const rest = foldExecution(events.slice(30), half);
    expect(rest).toEqual(plain);
    expect(JSON.stringify(half)).toBe(snapshot);
    expect(transient(() => foldExecution(events))).toEqual(plain);
  });
});

describe('IdMap', () => {
  it('is immutable outside a batch, counts entries and serialises as a sorted object', () => {
    const a = IdMap.from<number>([['b', 2], ['a', 1]]);
    const b = a.set('c', 3).set('a', 10);
    expect([a.get('a'), a.has('c'), a.size]).toEqual([1, false, 2]);
    expect([b.get('a'), b.get('c'), b.size]).toEqual([10, 3, 3]);
    expect(JSON.stringify(b)).toBe('{"a":10,"b":2,"c":3}');
    expect(b.values().sort((x, y) => x - y)).toEqual([2, 3, 10]);
    expect(IdMap.from([['a', 1], ['b', 2]])).toEqual(IdMap.from([['b', 2], ['a', 1]]));
  });
});
