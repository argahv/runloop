/** Mapper cases the recorded fixtures do not cover, driven through mapHook directly. */
import { foldExecution, initialExecState, reduceExecution, type ExecState } from '@runloop-world/core';
import type { EventOf, RunEvent } from '@runloop-world/events';
import { initialWorldState, reduceWorld, type WorldState } from '@runloop-world/world-engine';
import { describe, expect, it } from 'vitest';
import type { HookEnvelope } from '../src/tracers/claude-code/hook-input';
import { initialSessionState, mapHook, sweep, DEFAULT_MAP_CONTEXT, type SessionState } from '../src/tracers/claude-code/mapper';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import { envelopeOf, readFixture, world } from './claude-code-helpers';
import { openRecorder, tempDir } from './helpers';

const T0 = Date.parse('2026-10-17T09:00:00.000Z');

/** A tiny session driver: hook payloads in, the recorded events out. */
function session(sessionId = 'case-1') {
  const { recorder, db } = openRecorder(tempDir('cases'), { now: () => new Date(T0 + 86_400_000) });
  const manager = new TraceSessionManager({ recorder, db, onError: (err) => { throw err; } });
  let n = 0;
  const send = (hook: Record<string, unknown>, opts: { ppid?: number } = {}) =>
    manager.ingest([
      {
        v: 1,
        deliveryId: `d-${++n}`,
        observedAt: new Date(T0 + n * 1000).toISOString(),
        ppid: opts.ppid ?? 100,
        plugin: { name: 'runloop-tracer', version: 'test' },
        hook: { session_id: sessionId, cwd: '/home/dev/demo', ...hook } as unknown as HookEnvelope['hook'],
      },
    ]);
  const runs = () =>
    recorder
      .listRuns()
      .filter((r) => r.mode === 'traced')
      .sort((a, b) => (a.source?.segment ?? 0) - (b.source?.segment ?? 0));
  const events = (i = 0): RunEvent[] => recorder.listAll(runs()[i]!.runId);
  return { send, runs, events, manager };
}

describe('mapper cases', () => {
  it('creates nothing until a prompt or tool event (opening and closing Claude Code is not a run)', () => {
    const s = session();
    s.send({ hook_event_name: 'SessionStart', source: 'startup' });
    s.send({ hook_event_name: 'Stop', last_assistant_message: 'x' });
    s.send({ hook_event_name: 'SessionEnd', reason: 'other' });
    expect(s.runs()).toEqual([]);
  });

  it('embodies at most 8 subagents, with stable presets by order of appearance', () => {
    const s = session();
    s.send({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: 'go' });
    for (let i = 1; i <= 10; i++) s.send({ hook_event_name: 'SubagentStart', agent_id: `agent${i}`, agent_type: i % 2 ? 'Explore' : 'Plan' });
    const exec = foldExecution(s.events());
    const subs = exec.agentOrder.filter((id) => id.startsWith('sa-')).map((id) => exec.agents[id]!);
    expect(subs.map((a) => [a.name, a.embodied, a.characterPreset])).toEqual([
      ['Explore #1', true, 'subagent-1'],
      ['Plan #1', true, 'subagent-2'],
      ['Explore #2', true, 'subagent-3'],
      ['Plan #2', true, 'subagent-4'],
      ['Explore #3', true, 'subagent-5'],
      ['Plan #3', true, 'subagent-6'],
      ['Explore #4', true, 'subagent-7'],
      ['Plan #4', true, 'subagent-8'],
      ['Explore #5', false, null],
      ['Plan #5', false, null],
    ]);
    // Traced, but without a robot: their tasks still exist.
    expect(Object.values(exec.tasks).filter((t) => t.kind === 'delegated')).toHaveLength(10);
  });

  it('records resume, a second process, and an auto-mode denial', () => {
    const s = session();
    s.send({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: 'go', permission_mode: 'auto' });
    s.send({ hook_event_name: 'SessionStart', source: 'resume' });
    s.send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 't1' }, { ppid: 200 });
    s.send({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 't1', reason: 'Blocked by auto mode classifier' });
    const exec = foldExecution(s.events());
    expect(exec.markers.map((m) => [m.kind, m.label])).toEqual([
      ['session_resumed', 'Session resumed'],
      ['other', 'Another Claude Code process is writing to this session'],
    ]);
    expect(exec.toolCalls.get('t1')).toMatchObject({ status: 'failed', errorType: 'denied', message: 'Blocked by auto mode classifier', endProvenance: 'reported' });
    expect(exec.run.source).toMatchObject({ permissionMode: 'auto' });
    expect(exec.anomalies).toEqual([]);
  });

  it('opens an implicit turn (inferred) for work without a prompt, and continues turn numbers in a new segment', () => {
    const s = session();
    s.send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/home/dev/demo/a.ts' }, tool_use_id: 't1' });
    s.send({ hook_event_name: 'SessionEnd', reason: 'clear' });
    s.send({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: 'next' });
    const [first, second] = [s.events(0), s.events(1)];
    const turn = first.find((e) => e.type === 'task.created')!;
    expect(turn).toMatchObject({ provenance: 'inferred', payload: { taskId: 'turn-1', title: 'Turn 1 (no prompt reported)' } });
    expect(second.find((e) => e.type === 'task.created')!.payload).toMatchObject({ taskId: 'turn-2' });
    expect(s.runs().map((r) => r.source?.segment).sort()).toEqual([1, 2]);
  });

  it('is pure: the previous state is not modified, and sweep only closes open sessions', () => {
    const prev: SessionState = initialSessionState('pure');
    const snapshot = JSON.stringify(prev);
    const env = {
      v: 1 as const,
      deliveryId: 'd',
      observedAt: new Date(T0).toISOString(),
      plugin: { name: 'p', version: '1' },
      hook: { session_id: 'pure', hook_event_name: 'UserPromptSubmit', prompt: 'hi' } as HookEnvelope['hook'],
    };
    const a = mapHook(prev, env, DEFAULT_MAP_CONTEXT);
    const b = mapHook(prev, env, DEFAULT_MAP_CONTEXT);
    expect(JSON.stringify(prev)).toBe(snapshot);
    expect(a).toEqual(b);
    expect(a.state.status).toBe('open');
    expect(sweep(prev, DEFAULT_MAP_CONTEXT, 'idle', env.observedAt).batch).toBeNull();
    const closed = sweep(a.state, DEFAULT_MAP_CONTEXT, 'idle', env.observedAt);
    expect(closed.state.status).toBe('closed');
    expect(closed.batch!.drafts.at(-1)).toMatchObject({ type: 'run.completed', provenance: 'inferred', payload: { outcome: 'interrupted' } });
  });
});

/** Record a fixture's lines in another arrival order (each keeps its own observedAt), like async hooks can. */
function recordInOrder(name: string, order: number[]): RunEvent[] {
  const lines = readFixture(name);
  const { recorder, db } = openRecorder(tempDir(`order-${name}`), { now: () => new Date(lines.at(-1)!.t + 86_400_000) });
  const manager = new TraceSessionManager({ recorder, db, onError: (err) => { throw err; } });
  for (const i of order) manager.ingest([envelopeOf(name, lines[i]!, i)]);
  const runs = recorder.listRuns().filter((r) => r.mode === 'traced');
  expect(runs).toHaveLength(1);
  return recorder.listAll(runs[0]!.runId);
}

const allBut = (n: number, ...moves: [from: number, to: number][]) => {
  const order = Array.from({ length: n }, (_, i) => i);
  for (const [a, b] of moves) [order[a], order[b]] = [order[b]!, order[a]!];
  return order;
};

describe('delegation links (which Agent call started a subagent)', () => {
  const delegated = (events: RunEvent[]) => {
    const started = new Map(events.filter((e) => e.type === 'tool.call_started').map((e) => [e.eventId, (e as EventOf<'tool.call_started'>).payload.callId]));
    return events
      .filter((e): e is EventOf<'task.created'> => e.type === 'task.created' && e.payload.kind === 'delegated')
      .map((e) => ({ title: e.payload.title, parent: started.get(e.parentEventId!) ?? null, provenance: e.provenance }));
  };

  it('labels the guessed link inferred', () => {
    const events = recordInOrder('s2-subagents', allBut(27));
    expect(delegated(events).map((d) => d.provenance)).toEqual(['inferred', 'inferred']);
    expect(events.filter((e) => e.type === 'task.assigned').map((e) => e.provenance)).toEqual(['inferred', 'inferred']);
    expect(foldExecution(events).markers).toEqual([]); // both guesses were right: nothing to correct
  });

  it('a SubagentStart delivered before its Agent call does not take the next call\'s title', () => {
    const events = recordInOrder('s2-subagents', allBut(27, [2, 3])); // SubagentStart(A) before PreToolUse(A)
    const exec = foldExecution(events);
    expect(delegated(events)).toEqual([
      { title: 'Explore subagent', parent: null, provenance: 'reported' },
      { title: 'Count tests in task-store.test.js', parent: 'toolu_01HJYwZozKP5xfKQH45R5HJn', provenance: 'inferred' },
    ]);
    expect(exec.tasks['delegate-2']!.ownerId).toBe('sa-a6cda79f3c3f19501');
    expect(exec.markers).toEqual([]);
    expect(exec.anomalies).toEqual([]);
  });

  it('a wrong guess is corrected by the Agent result, with a marker naming the real call', () => {
    // PreToolUse(A), PreToolUse(B), SubagentStart(B), SubagentStart(A): the guesses swap.
    const order = [0, 1, 2, 4, 5, 3, ...Array.from({ length: 21 }, (_, i) => i + 6)];
    const events = recordInOrder('s2-subagents', order);
    const exec = foldExecution(events);
    expect(delegated(events).every((d) => d.provenance === 'inferred')).toBe(true);
    expect(exec.markers.map((m) => [m.label, m.agentId, m.provenance])).toEqual([
      ['Delegation corrected: Explore #2 was started by "Summarize task-store.js"', 'sa-acd4fbeb0fe6b7d3f', 'reported'],
      ['Delegation corrected: Explore #1 was started by "Count tests in task-store.test.js"', 'sa-a6cda79f3c3f19501', 'reported'],
    ]);
    // Usage always follows the Agent result.
    expect(exec.usageReports.map((u) => [u.agentId, u.callId])).toEqual([
      ['sa-acd4fbeb0fe6b7d3f', 'toolu_011gyGESPeSfvQ6e7W7D5KTM'],
      ['sa-a6cda79f3c3f19501', 'toolu_01HJYwZozKP5xfKQH45R5HJn'],
    ]);
    expect(exec.anomalies).toEqual([]);
  });
});

describe('permission outcomes', () => {
  it('a denial with no hook ends when the batch that held the call ends, not at the end of the turn', () => {
    const events = recordInOrder('s1-basic', allBut(19));
    // Both layers after each event, as replay shows them.
    const states: { exec: ExecState; world: WorldState }[] = [];
    let exec = initialExecState();
    let w = initialWorldState();
    for (const e of events) {
      exec = reduceExecution(exec, e);
      w = reduceWorld(w, exec, e, world);
      states[e.sequence] = { exec, world: w };
    }
    const index = { stateAt: (seq: number) => states[seq]! };
    const failing = events.find((e) => e.type === 'tool.call_completed' && (e as EventOf<'tool.call_completed'>).payload.callId === 'toolu_01DUuvoTXKCZEH1W5pc3GVHm')!;
    const pendingAt = (seq: number) => index.stateAt(seq).exec.agents.main!.pendingPermissionId;
    const requested = events.find((e) => e.type === 'tool.permission_requested')!.sequence;
    expect(pendingAt(requested)).toBe('perm-1');
    // The failing test run happens in a later batch: Claude is no longer waiting at the gate.
    expect(pendingAt(failing.sequence)).toBeNull();
    expect(index.stateAt(failing.sequence).world.characters.main!.activity).not.toBe('awaiting_approval');
    expect(foldExecution(events).permissions['perm-1']).toMatchObject({ status: 'denied', resolvedProvenance: 'inferred' });
  });

  it('a permission_prompt notification delivered first is the same request, not a second one', () => {
    const events = recordInOrder('synthetic-permission-denied-then-stop', allBut(13, [3, 4]));
    const exec = foldExecution(events);
    expect(Object.values(exec.permissions).map((p) => [p.id, p.callId, p.status])).toEqual([
      ['perm-1', 'toolu_syn_write1', 'approved'],
      ['perm-2', 'toolu_syn_push1', 'denied'],
    ]);
    expect(exec.anomalies).toEqual([]);
  });

  it('a request delivered after its call already completed is approved (inferred), never denied', () => {
    // PostToolUse(Write) arrives before PermissionRequest(Write) and the notification.
    const events = recordInOrder('synthetic-permission-denied-then-stop', [0, 1, 2, 5, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
    const exec = foldExecution(events);
    expect(exec.toolCalls.get('toolu_syn_write1')).toMatchObject({ status: 'success' });
    expect(exec.permissions['perm-1']).toMatchObject({ callId: 'toolu_syn_write1', status: 'approved', resolvedProvenance: 'inferred' });
    expect(Object.values(exec.permissions).filter((p) => p.status === 'denied').map((p) => p.callId)).toEqual(['toolu_syn_push1']);
    expect(exec.anomalies).toEqual([]);
  });
});

describe('mapper cost', () => {
  it('keeps the cost per envelope roughly constant over a 20k-envelope session', () => {
    const N = 10_000; // calls: one PreToolUse and one PostToolUse each
    let state = initialSessionState('big');
    const env = (i: number, hook: Record<string, unknown>): HookEnvelope => ({
      v: 1,
      deliveryId: `d-${i}`,
      observedAt: new Date(T0 + i * 10).toISOString(),
      plugin: { name: 'p', version: '1' },
      hook: { session_id: 'big', cwd: '/home/dev/demo', ...hook } as unknown as HookEnvelope['hook'],
    });
    state = mapHook(state, env(0, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).state;
    const times: number[] = [];
    for (let i = 1; i <= N; i++) {
      const t = performance.now();
      const input = { file_path: `/home/dev/demo/f${i}.ts` };
      state = mapHook(state, env(2 * i, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: input, tool_use_id: `t${i}` })).state;
      state = mapHook(state, env(2 * i + 1, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: input, tool_use_id: `t${i}`, tool_result: { bytes: 1 } })).state;
      times.push(performance.now() - t);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = avg(times.slice(500, 2500));
    const last = avg(times.slice(-2000));
    expect(last).toBeLessThan(Math.max(first * 4, 0.05));
    // Late duplicates are still recognised long after the call closed.
    expect(mapHook(state, env(3 * N, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't5' })).ignored).toBe('late result for a closed call');
  });
});
