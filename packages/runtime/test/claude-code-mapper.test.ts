/**
 * Golden tests: Claude Code hook fixtures (real probe sessions, sanitised, plus
 * synthetic edge cases) → TraceSessionManager → recorded runs → both layers.
 */
import path from 'node:path';
import { foldExecution, initialExecState, reduceExecution } from '@runloop-world/core';
import { parseKnownEvent, type RunEvent } from '@runloop-world/events';
import { initialWorldState, reduceWorld } from '@runloop-world/world-engine';
import { describe, expect, it } from 'vitest';
import { HANDLED_HOOKS } from '../src/tracers/claude-code/mapper';
import { ALL_FIXTURES, FIXTURE_DIR, readFixture, recordFixture, renderRun, world } from './claude-code-helpers';
import { tempDir } from './helpers';

const ofType = <T extends RunEvent['type']>(events: readonly RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

/** Absolute paths that must never reach an event (fixtures use /home/dev/demo, ~/.claude, /tmp/claude). */
const ABSOLUTE = /(?<![\w~.])\/(?:home|tmp|root|Users)\//;

describe.each(ALL_FIXTURES)('fixture %s', (name) => {
  const lines = readFixture(name);
  const { runs, outcomes } = recordFixture(name, tempDir(`golden-${name}`));

  it('matches the golden trace', async () => {
    const text = runs.map((r, i) => `# run ${i + 1}\n${renderRun(r)}`).join('\n\n');
    await expect(`${text}\n`).toMatchFileSnapshot(path.join(FIXTURE_DIR, `${name}.golden.txt`));
  });

  it('records exactly one traced run per session, closed, with every event valid and labelled', () => {
    expect(runs).toHaveLength(1);
    for (const events of runs) {
      expect(events[0]!.type).toBe('run.started');
      expect(events.at(-1)!.type).toBe('run.completed');
      for (const e of events) {
        expect(parseKnownEvent(JSON.parse(JSON.stringify(e))).ok, `#${e.sequence}`).toBe(true);
        expect(e.provenance, `#${e.sequence} ${e.type}`).toMatch(/^(reported|inferred)$/);
        expect(JSON.stringify(e), `#${e.sequence} has an absolute path`).not.toMatch(ABSOLUTE);
      }
    }
  });

  it('counts only unhandled hooks as ignored', () => {
    const unhandled = lines.filter((l) => !HANDLED_HOOKS.has(String(l.input.hook_event_name))).length;
    expect(outcomes.duplicates).toBe(0);
    expect(outcomes.ignored).toBeGreaterThanOrEqual(unhandled);
    expect(outcomes.accepted + outcomes.ignored).toBe(lines.length);
  });

  it('folds with no anomalies and gives every call exactly one terminal event', () => {
    for (const events of runs) {
      const exec = foldExecution(events);
      expect(exec.anomalies).toEqual([]);
      expect(exec.run.mode).toBe('traced');
      expect(['stopped', 'interrupted']).toContain(exec.run.status);
      for (const started of ofType(events, 'tool.call_started')) {
        const ends = events.filter(
          (e) => (e.type === 'tool.call_completed' || e.type === 'tool.call_failed') && e.payload.callId === started.payload.callId,
        );
        expect(ends, started.payload.callId).toHaveLength(1);
        expect(ends[0]!.parentEventId).toBe(started.eventId);
      }
      for (const t of Object.values(exec.tasks)) expect(['completed', 'failed'], t.id).toContain(t.status);
      for (const p of Object.values(exec.permissions)) expect(p.status).not.toBe('pending');
    }
  });

  it('places every character on a walkable cell at every step (world fold)', () => {
    for (const events of runs) {
      let exec = initialExecState();
      let w = initialWorldState();
      for (const e of events) {
        exec = reduceExecution(exec, e);
        w = reduceWorld(w, exec, e, world);
        for (const id of w.characterOrder) {
          const c = w.characters[id]!;
          for (const cell of c.motion.path) expect(world.isWalkable(...cell), `${id} at #${e.sequence}`).toBe(true);
          if (c.target.kind === 'slot') expect(world.stationsById[c.target.stationId]!.slots[c.target.index]).toBeDefined();
        }
      }
      const embodied = exec.agentOrder.filter((id) => exec.agents[id]!.embodied);
      expect(w.characterOrder).toEqual(embodied);
    }
  });
});

describe('real probe sessions', () => {
  const run = (name: string) => recordFixture(name, tempDir(`real-${name}`)).runs[0]!;

  it('s1: a failing test run is an error with parsed counts; a missing file is a tool error; a denial is inferred', () => {
    const events = run('s1-basic');
    const completed = ofType(events, 'tool.call_completed');
    const fail = completed.find((e) => e.payload.callId === 'toolu_01DUuvoTXKCZEH1W5pc3GVHm')!;
    expect(fail.payload).toMatchObject({
      status: 'error',
      exitCode: 1,
      errorType: 'exit_nonzero',
      metrics: { tests: 12, passed: 10, failed: 2 },
      failingTests: ['listOpen returns only tasks that are not done', 'listOpen reflects complete()'],
    });
    const rerun = completed.find((e) => e.payload.callId === 'toolu_01U4rr7o97pCnBGbgmFmSL8m')!;
    expect(rerun.payload).toMatchObject({ status: 'success', metrics: { tests: 12, passed: 12, failed: 0 } });
    const missing = completed.find((e) => e.payload.callId === 'toolu_01YTGUb7NtUK7Pfn5BVf3y4K')!;
    expect(missing.payload).toMatchObject({ status: 'error', errorType: 'tool_error' });
    const denied = ofType(events, 'tool.call_failed').find((e) => e.payload.callId === 'toolu_01BBLuKJFiZXPjb7SW2LP8Si')!;
    expect(denied).toMatchObject({ provenance: 'inferred', payload: { errorType: 'denied' } });
    expect(ofType(events, 'tool.permission_resolved')[0]).toMatchObject({ provenance: 'inferred', payload: { decision: 'denied' } });
    // The Stop hook's reply closes the turn as reported.
    expect(ofType(events, 'task.completed').find((e) => e.payload.taskId === 'turn-1')!.provenance).toBe('reported');
  });

  it('s2: subagent calls are attributed by agent_id, linked to the delegating call, and usage is reported for both', () => {
    const events = run('s2-subagents');
    const exec = foldExecution(events);
    expect(exec.toolCalls.get('toolu_01DkHhB5jEyt3L6pzpLvphKm')!.agentId).toBe('sa-acd4fbeb0fe6b7d3f');
    expect(exec.toolCalls.get('toolu_01QH5oRCdZQyepXJJ2WRraM2')!.agentId).toBe('sa-a6cda79f3c3f19501');
    expect(exec.agents['sa-acd4fbeb0fe6b7d3f']).toMatchObject({ name: 'Explore #1', embodied: true, characterPreset: 'subagent-1', state: 'done' });
    expect(exec.agents['sa-a6cda79f3c3f19501']).toMatchObject({ name: 'Explore #2', characterPreset: 'subagent-2' });
    // Each delegated task points at the Agent call that spawned it.
    const started = new Map(ofType(events, 'tool.call_started').map((e) => [e.eventId, e.payload.callId]));
    const delegated = ofType(events, 'task.created').filter((e) => e.payload.kind === 'delegated');
    expect(delegated.map((e) => [e.payload.title, started.get(e.parentEventId!)])).toEqual([
      ['Summarize task-store.js', 'toolu_011gyGESPeSfvQ6e7W7D5KTM'],
      ['Count tests in task-store.test.js', 'toolu_01HJYwZozKP5xfKQH45R5HJn'],
    ]);
    const usage = ofType(events, 'agent.usage_reported');
    expect(usage.map((e) => e.payload)).toEqual([
      expect.objectContaining({ agentId: 'sa-acd4fbeb0fe6b7d3f', model: 'claude-haiku-5-5', inputTokens: 2, outputTokens: 193, cacheReadTokens: 19620, cacheCreationTokens: 705, totalTokens: 20520, durationMs: 4795, source: 'claude-code.agent_result' }),
      expect.objectContaining({ agentId: 'sa-a6cda79f3c3f19501', inputTokens: 2, outputTokens: 577, cacheReadTokens: 19633, cacheCreationTokens: 1608, totalTokens: 21820 }),
    ]);
    for (const e of usage) expect(e.provenance).toBe('reported');
    // Main-agent usage is not reported by hooks: no event, so it reads as not reported (never zero).
    expect(exec.agents.main!.usage).toBeNull();
  });

  it('s3: async delivery without a Stop hook still closes the turn and the denied calls at SessionEnd', () => {
    const events = run('s3-async');
    const failed = ofType(events, 'tool.call_failed');
    expect(failed.map((e) => [e.payload.callId, e.payload.errorType, e.provenance])).toEqual([
      ['toolu_01JxFx5C6KoT3xBESpPe6Den', 'denied', 'inferred'],
      ['toolu_01MSafyDQmufQRzNkbfyHoqF', 'denied', 'inferred'],
    ]);
    expect(ofType(events, 'task.completed').at(-1)).toMatchObject({ provenance: 'inferred', payload: { taskId: 'turn-1' } });
    expect(ofType(events, 'run.completed')[0]!.payload).toEqual({ outcome: 'stopped', summary: 'Session ended (other)' });
  });
});

describe('synthetic edge cases', () => {
  const run = (name: string) => recordFixture(name, tempDir(`syn-${name}`)).runs[0]!;

  it('a result before its start synthesises the start (inferred) and ignores the late start', () => {
    const events = run('synthetic-post-before-pre');
    const starts = ofType(events, 'tool.call_started');
    expect(starts.filter((e) => e.payload.callId === 'toolu_syn_read1').map((e) => e.provenance)).toEqual(['inferred']);
    const vitest = ofType(events, 'tool.call_completed').find((e) => e.payload.callId === 'toolu_syn_bash1')!;
    expect(vitest.payload).toMatchObject({ status: 'error', exitCode: 1, metrics: { tests: 12, passed: 10, failed: 2 } });
  });

  it('out-of-order subagent and permission events still attribute, link and approve', () => {
    const events = run('synthetic-out-of-order');
    const exec = foldExecution(events);
    expect(exec.toolCalls.get('toolu_syn_glob1')!.agentId).toBe('sa-a0syntheticexplore1');
    expect(exec.permissions['perm-1']).toMatchObject({ callId: null, status: 'approved', resolvedProvenance: 'inferred' });
    expect(exec.toolCalls.get('toolu_syn_sleep1')).toMatchObject({ status: 'failed', errorType: 'aborted' });
    expect(exec.agents['sa-a0syntheticexplore1']!.usage).toMatchObject({ inputTokens: 3, outputTokens: 120, totalTokens: 15000 });
  });

  it('a permission with no result is denied (inferred) at Stop; markers are recorded', () => {
    const events = run('synthetic-permission-denied-then-stop');
    const exec = foldExecution(events);
    expect(exec.permissions['perm-1']).toMatchObject({ status: 'approved' });
    expect(exec.permissions['perm-2']).toMatchObject({ status: 'denied', resolvedProvenance: 'inferred' });
    expect(exec.toolCalls.get('toolu_syn_push1')).toMatchObject({ status: 'failed', errorType: 'denied', endProvenance: 'inferred', category: 'deploy' });
    expect(exec.markers.map((m) => m.label)).toEqual(['Compaction started (manual)', 'Compaction finished']);
  });

  it('without SessionEnd the idle sweep closes the run as interrupted, inferred; secrets in commands are masked', () => {
    const events = run('synthetic-no-session-end');
    const exec = foldExecution(events);
    expect(exec.run.status).toBe('interrupted');
    expect(ofType(events, 'run.completed')[0]!.provenance).toBe('inferred');
    expect(exec.toolCalls.get('toolu_syn_slow1')).toMatchObject({ status: 'failed', errorType: 'unobserved' });
    expect(exec.tasks['turn-1']).toMatchObject({ status: 'failed', failure: { errorType: 'api_error' } });
    expect(exec.markers.map((m) => m.kind)).toEqual(['api_error']);
    expect(exec.toolCalls.get('toolu_syn_slow1')!.inputSummary).toBe('API_TOKEN=[REDACTED] npm test -- --runInBand');
  });
});
