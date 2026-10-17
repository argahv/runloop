// Test helpers (node only: reads the world from disk). Never import from browser code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunDetailResponse, RunEvent, RunSummary } from '@runloop-world/events';
import { codingMissionFixture, runBuilder } from '@runloop-world/testkit';
import { createStudioStore, type StudioStore } from './store';

const WORLD_FILE = path.join(import.meta.dirname, '../../../../worlds/research-campus/world.json');

export function worldJson(): unknown {
  return JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as unknown;
}

export function detailFor(events: readonly RunEvent[], status: RunSummary['status'] = 'running'): RunDetailResponse {
  const first = events[0]!;
  return {
    run: {
      runId: first.runId,
      title: 'Fixture run',
      missionId: 'coding-mission',
      worldId: 'research-campus',
      status,
      createdAt: first.timestamp,
      endedAt: null,
      lastSequence: events.length,
      adapterLabel: 'Scripted adapter',
      paused: false,
    },
    world: worldJson(),
  };
}

/**
 * A small traced Claude Code run for tests, hand-built in the shape of the
 * runtime's s1/s2 golden traces (packages/runtime/test/fixtures/claude-code):
 * a failing then passing test run, an Explore subagent with reported usage,
 * a denied permission Runloop inferred, and a compaction marker. Test data
 * only; it never reaches a runtime.
 */
export function tracedFixture(): RunEvent[] {
  const b = runBuilder({ namespace: 0x7c, startIso: '2026-10-17T10:00:00.000Z' });
  const rep = { provenance: 'reported' as const };
  b.add(
    'run.started',
    {
      title: 'Claude Code · demo',
      missionId: 'claude-code',
      worldId: 'research-campus',
      adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code (traced via hooks)' },
      mode: 'traced',
      source: { kind: 'claude-code', sessionId: '448e50c5-fddf-484e-a28a-4984322713a9', segment: 1, projectLabel: 'demo', model: null, permissionMode: 'default', pluginVersion: '0.1.0' },
    },
    rep,
  );
  b.add('agent.registered', { agentId: 'user', name: 'You', role: 'user', model: null, tools: [], embodied: false }, rep);
  b.add('agent.registered', { agentId: 'main', name: 'Claude', role: 'main agent', model: null, tools: [], embodied: true, characterPreset: 'claude' }, rep);
  b.add('task.created', { taskId: 'turn-1', title: 'Turn 1', kind: 'turn', dependsOn: [] }, { ...rep, actorId: 'user', taskId: 'turn-1' });
  b.add('task.started', { taskId: 'turn-1', agentId: 'main' }, { ...rep, actorId: 'main', taskId: 'turn-1' });
  b.add('agent.message_sent', { messageId: 'msg-1', fromAgentId: 'user', to: 'main', text: 'Fix the failing tests.' }, { ...rep, actorId: 'user', visibility: 'sensitive' });
  // A test run that fails (exit 1, counts as reported), behind a permission that is never answered.
  b.wait(1000);
  const perm = b.add('tool.call_started', { callId: 'c-perm', agentId: 'main', taskId: 'turn-1', tool: 'Bash', category: 'deploy', inputSummary: 'git push origin HEAD' }, { ...rep, actorId: 'main', taskId: 'turn-1' });
  b.add('tool.permission_requested', { permissionId: 'perm-1', agentId: 'main', callId: 'c-perm', action: 'Bash git push origin HEAD', scope: 'default' }, { ...rep, actorId: 'main' });
  b.wait(500);
  const t1 = b.add('tool.call_started', { callId: 'c-test1', agentId: 'main', taskId: 'turn-1', tool: 'Bash', category: 'test', inputSummary: 'node --test' }, { ...rep, actorId: 'main', taskId: 'turn-1' });
  b.wait(400);
  b.add(
    'tool.call_completed',
    { callId: 'c-test1', status: 'error', durationMs: 374, exitCode: 1, outputSummary: 'Exit code 1 · 12 tests: 10 passed, 2 failed', metrics: { tests: 12, passed: 10, failed: 2 }, failingTests: ['listOpen reflects complete()'], errorType: 'exit_nonzero' },
    { ...rep, actorId: 'main', taskId: 'turn-1', parentEventId: t1.eventId },
  );
  // Delegation: an Agent call starts an Explore subagent, which reads a file and reports usage.
  b.wait(300);
  const agentCall = b.add('tool.call_started', { callId: 'c-agent', agentId: 'main', taskId: 'turn-1', tool: 'Agent', category: 'delegate', inputSummary: '→ Explore: "Summarize task-store.js"' }, { ...rep, actorId: 'main', taskId: 'turn-1' });
  b.add('agent.registered', { agentId: 'sa-1', name: 'Explore #1', role: 'Explore', model: null, tools: [], embodied: true, characterPreset: 'subagent-1' }, rep);
  b.add('task.created', { taskId: 'delegate-1', title: 'Summarize task-store.js', kind: 'delegated', dependsOn: [] }, { ...rep, actorId: 'main', taskId: 'delegate-1', parentEventId: agentCall.eventId });
  b.add('task.assigned', { taskId: 'delegate-1', agentId: 'sa-1' }, { ...rep, actorId: 'main', taskId: 'delegate-1' });
  b.add('task.started', { taskId: 'delegate-1', agentId: 'sa-1' }, { ...rep, actorId: 'sa-1', taskId: 'delegate-1' });
  b.wait(200);
  const read = b.add('tool.call_started', { callId: 'c-read', agentId: 'sa-1', taskId: 'delegate-1', tool: 'Read', category: 'read', inputSummary: 'src/task-store.js' }, { ...rep, actorId: 'sa-1', taskId: 'delegate-1' });
  b.wait(11);
  b.add('tool.call_completed', { callId: 'c-read', status: 'success', durationMs: 11, outputSummary: 'Read 34 lines' }, { ...rep, actorId: 'sa-1', taskId: 'delegate-1', parentEventId: read.eventId });
  b.wait(4000);
  b.add('task.completed', { taskId: 'delegate-1', summary: 'An in-memory task store.', artifactIds: [] }, { ...rep, taskId: 'delegate-1' });
  b.add('tool.call_completed', { callId: 'c-agent', status: 'success', durationMs: 4799, outputSummary: 'Explore finished · 1 tool call · 20,520 tokens reported' }, { ...rep, actorId: 'main', taskId: 'turn-1', parentEventId: agentCall.eventId });
  b.add(
    'agent.usage_reported',
    { agentId: 'sa-1', model: 'claude-haiku-5-5', inputTokens: 2, outputTokens: 193, cacheReadTokens: 19620, cacheCreationTokens: 705, totalTokens: 20520, durationMs: 4795, toolUseCount: 1, callId: 'c-agent', source: 'claude-code.agent_result' },
    { ...rep, actorId: 'sa-1' },
  );
  b.add('run.marker', { kind: 'compaction', label: 'Compaction started (manual)', agentId: 'main' }, { ...rep, actorId: 'main' });
  // The fixed test run passes.
  b.wait(1000);
  const t2 = b.add('tool.call_started', { callId: 'c-test2', agentId: 'main', taskId: 'turn-1', tool: 'Bash', category: 'test', inputSummary: 'node --test' }, { ...rep, actorId: 'main', taskId: 'turn-1' });
  b.wait(268);
  b.add('tool.call_completed', { callId: 'c-test2', status: 'success', durationMs: 268, outputSummary: '12 tests: 12 passed, 0 failed', metrics: { tests: 12, passed: 12, failed: 0 } }, { ...rep, actorId: 'main', taskId: 'turn-1', parentEventId: t2.eventId });
  // Stop: the unanswered permission is closed as denied (inferred).
  b.wait(500);
  b.add('tool.permission_resolved', { permissionId: 'perm-1', decision: 'denied', by: 'unknown' }, { provenance: 'inferred' });
  b.add('tool.call_failed', { callId: 'c-perm', errorType: 'denied', message: 'No result was reported after the permission request; treated as denied (inferred)', durationMs: 7000 }, { provenance: 'inferred', actorId: 'main', taskId: 'turn-1', parentEventId: perm.eventId });
  b.add('task.completed', { taskId: 'turn-1', summary: 'All 12 tests pass.', artifactIds: [] }, { ...rep, taskId: 'turn-1', visibility: 'sensitive' });
  b.add('run.completed', { outcome: 'stopped', summary: 'Session ended (other)' }, rep);
  return b.events;
}

/** A mutable fake wall clock. */
export function fakeNow(startMs: number) {
  let t = startMs;
  return { now: () => t, set: (ms: number) => (t = ms), advance: (ms: number) => (t += ms) };
}

/** A store with the canonical fixture's run opened (world loaded, no events yet). */
export function openFixture(opts: { now?: () => number } = {}): { store: StudioStore; events: RunEvent[] } {
  const events = codingMissionFixture();
  const store = createStudioStore(opts.now ? { now: opts.now } : {});
  store.getState().openRun(events[0]!.runId);
  store.getState().loadRun(detailFor(events));
  return { store, events };
}

/** JSON round trip, like events arriving over HTTP. */
export const wire = <T>(v: T): unknown => JSON.parse(JSON.stringify(v)) as unknown;
