import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseKnownEvent, type EventOf, type RunEvent } from '@runloop-world/events';
import { CODING_MISSION, codingMissionFixture, codingMissionTypeSequence } from '@runloop-world/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime, type RuntimeOptions } from '../src/runtime';
import { EXAMPLE_DIR, REPO_ROOT, hashTree, tempDir } from './helpers';

const M = CODING_MISSION;
const BUGGY = readFileSync(path.join(EXAMPLE_DIR, 'script', 'implement.buggy.js'), 'utf8');
const FIXED = readFileSync(path.join(EXAMPLE_DIR, 'script', 'implement.fixed.js'), 'utf8');

let rt: Runtime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

function runtime(opts: Partial<RuntimeOptions> = {}): Runtime {
  rt = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('int'), env: {}, ...opts });
  return rt;
}

/** A copy of examples/ with the coding mission's script files replaced. */
function missionsWith(files: Record<string, string>): string {
  const dir = tempDir('missions');
  cpSync(EXAMPLE_DIR, path.join(dir, 'coding-mission'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) writeFileSync(path.join(dir, 'coding-mission', rel), content);
  return dir;
}

async function runMission(r: Runtime, speed = 0): Promise<{ runId: string; events: RunEvent[] }> {
  const { runId } = r.manager.start({ missionId: 'coding-mission', speed });
  await r.manager.whenDone(runId);
  return { runId, events: r.recorder.listAll(runId) };
}

const ofType = <T extends RunEvent['type']>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

function completionsOf(events: RunEvent[], tool: string) {
  const callIds = new Set(ofType(events, 'tool.call_started').filter((e) => e.payload.tool === tool).map((e) => e.payload.callId));
  return ofType(events, 'tool.call_completed').filter((e) => callIds.has(e.payload.callId));
}

describe('coding mission (real tools, speed 0)', () => {
  it('reproduces the canonical event sequence with a genuine failure, a fix and a passing rerun', { timeout: 60_000 }, async () => {
    const examplesBefore = hashTree(EXAMPLE_DIR);
    const r = runtime();
    const { runId, events } = await runMission(r);

    // Shape: exactly the canonical type sequence, contiguous, unique, valid.
    expect(events.map((e) => e.type)).toEqual(codingMissionTypeSequence());
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    for (const e of events) expect(parseKnownEvent(e).ok).toBe(true);
    // Same envelope refs (actor, task, parent link) and payload fields as the canonical fixture.
    const shape = (e: RunEvent, all: RunEvent[]) => [
      e.type,
      e.actorId ?? null,
      e.taskId ?? null,
      all.find((x) => x.eventId === e.parentEventId)?.sequence ?? null,
      e.visibility,
      Object.keys(e.payload).sort(),
    ];
    const fixture = codingMissionFixture();
    expect(events.map((e) => shape(e, events))).toEqual(fixture.map((e) => shape(e, fixture)));

    // Identity matches the testkit constants.
    const started = events[0] as EventOf<'run.started'>;
    expect(started.payload).toEqual({
      title: M.title,
      missionId: M.missionId,
      worldId: M.worldId,
      seed: M.seed,
      adapter: { ...M.adapter },
      workspace: `workspaces/${runId}`,
      speed: 0,
    });
    const agents = ofType(events, 'agent.registered').map((e) => e.payload);
    expect(agents.map((a) => [a.agentId, a.name, a.role, a.embodied, a.characterPreset])).toEqual(
      Object.values(M.agents).map((a) => [a.agentId, a.name, a.role, a.agentId !== 'coordinator', a.preset]),
    );
    for (const a of agents.slice(1)) expect(a.tools).toEqual(M.tools[a.agentId as keyof typeof M.tools]);
    expect(ofType(events, 'task.created').map((e) => [e.payload.taskId, e.payload.kind, e.payload.plannedSteps])).toEqual(
      Object.values(M.tasks).map((t) => [t.taskId, t.kind, t.plannedSteps]),
    );

    // Every call has exactly one terminal event, linked to its start; artifacts are linked too.
    const startedCalls = ofType(events, 'tool.call_started');
    expect(startedCalls.map((e) => e.payload.callId)).toEqual(startedCalls.map((_, i) => `call-${i + 1}`));
    for (const s of startedCalls) {
      const terminal = events.filter(
        (e) => (e.type === 'tool.call_completed' || e.type === 'tool.call_failed') && e.payload.callId === s.payload.callId,
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.parentEventId).toBe(s.eventId);
      expect(terminal[0]!.actorId).toBe(s.payload.agentId);
    }
    const artifacts = ofType(events, 'artifact.created');
    expect(artifacts.map((a) => a.payload.artifactId)).toEqual(['art-1', 'art-2', 'art-3', 'art-4']);
    for (const a of artifacts) {
      const s = startedCalls.find((c) => c.payload.callId === a.payload.producedByCallId)!;
      expect(a.parentEventId).toBe(s.eventId);
      const stored = r.recorder.getArtifact(runId, a.payload.artifactId)!;
      expect(stored.content.byteLength).toBe(a.payload.bytes);
      expect(createHash('sha256').update(stored.content).digest('hex')).toBe(a.payload.sha256);
    }

    // The first test run genuinely fails, 10 passed / 2 failed, with the real names.
    const [first, rerun] = completionsOf(events, 'run_command');
    expect(first!.payload).toMatchObject({
      status: 'error',
      exitCode: 1,
      errorType: 'tests_failed',
      outputSummary: '12 tests: 10 passed, 2 failed',
      metrics: { tests: M.totalTests, passed: 10, failed: 2 },
      failingTests: [...M.failingTests],
    });
    const firstReport = r.recorder.getArtifact(runId, first!.payload.outputArtifactIds![0]!)!.content.toString();
    expect(firstReport).toContain('# fail 2');
    for (const name of M.failingTests) expect(firstReport).toContain(` - ${name}\n`);
    expect(firstReport).not.toContain(r.dataDir); // absolute host paths are scrubbed

    // The rerun passes.
    expect(rerun!.payload).toMatchObject({
      status: 'success',
      exitCode: 0,
      outputSummary: '12 tests: 12 passed, 0 failed',
      metrics: { tests: 12, passed: 12, failed: 0 },
    });
    expect(rerun!.payload.failingTests).toBeUndefined();
    expect(r.recorder.getArtifact(runId, rerun!.payload.outputArtifactIds![0]!)!.content.toString()).toContain('# fail 0');

    // Messages carry real results.
    const tellBuilder = ofType(events, 'agent.message_sent').find((e) => e.payload.fromAgentId === 'tester')!;
    expect(tellBuilder.payload.text).toBe(`Failing: ${M.failingTests.join('; ')}`);
    expect(ofType(events, 'task.blocked')[0]!.payload).toMatchObject({ taskId: 'T3', reason: '2 of 12 tests failing', blockedBy: ['T4'] });

    // Outcome and side effects.
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', payload: { outcome: 'succeeded' } });
    expect(r.recorder.getRun(runId)).toMatchObject({ status: 'succeeded', lastSequence: events.length });
    const ws = path.join(r.dataDir, 'workspaces', runId);
    expect(readFileSync(path.join(ws, 'src', 'task-store.js'), 'utf8')).toBe(FIXED);
    expect(existsSync(path.join(ws, 'script'))).toBe(false);
    expect(hashTree(EXAMPLE_DIR)).toBe(examplesBefore);
  });

  it('keeps every event after a restart and continues from it', { timeout: 60_000 }, async () => {
    const r = runtime();
    const { runId, events } = await runMission(r);
    const dataDir = r.dataDir;
    await r.close();
    rt = createRuntime({ repoRoot: REPO_ROOT, dataDir, env: {} });
    expect(rt.recovered).toEqual([]);
    expect(rt.recorder.listAll(runId)).toEqual(events);
    expect(rt.recorder.listRuns()).toEqual([expect.objectContaining({ runId, status: 'succeeded' })]);
  });

  it('skips the fix when the first test run really passes', { timeout: 60_000 }, async () => {
    const r = runtime({ missionsDir: missionsWith({ 'script/implement.buggy.js': FIXED }) });
    const { events } = await runMission(r);
    const runs = completionsOf(events, 'run_command');
    expect(runs.map((e) => e.payload.status)).toEqual(['success']);
    expect(ofType(events, 'task.created').map((e) => e.payload.taskId)).toEqual(['T1', 'T2', 'T3']);
    expect(ofType(events, 'task.blocked')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', payload: { outcome: 'succeeded' } });
  });

  it('fails the run when the rerun still fails', { timeout: 60_000 }, async () => {
    const r = runtime({ missionsDir: missionsWith({ 'script/implement.fixed.js': BUGGY }) });
    const { runId, events } = await runMission(r);
    expect(completionsOf(events, 'run_command').map((e) => e.payload.status)).toEqual(['error', 'error']);
    expect(ofType(events, 'task.failed')[0]!.payload).toMatchObject({ taskId: 'T3', errorType: 'tests_failed' });
    expect(ofType(events, 'agent.state_changed').at(-1)!.payload).toMatchObject({ agentId: 'tester', state: 'failed' });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', payload: { outcome: 'failed' } });
    expect(r.recorder.getRun(runId)?.status).toBe('failed');
  });

  it('stop kills a running test command: tool.call_failed{aborted}, then run.completed{stopped}', { timeout: 60_000 }, async () => {
    const missionsDir = missionsWith({
      'repo/test/slow.test.js': `import { test } from 'node:test';\ntest('slow', () => new Promise((r) => setTimeout(r, 20000)));\n`,
    });
    const r = runtime({ missionsDir });
    const { runId } = r.manager.start({ missionId: 'coding-mission', speed: 0 });
    r.recorder.subscribe(runId, (e) => {
      if (e.type === 'tool.call_started' && e.payload.tool === 'run_command') setTimeout(() => r.manager.stop(runId), 300);
    });
    const t0 = Date.now();
    await r.manager.whenDone(runId);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const events = r.recorder.listAll(runId);
    const startedCmd = ofType(events, 'tool.call_started').find((e) => e.payload.tool === 'run_command')!;
    const failed = ofType(events, 'tool.call_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ callId: startedCmd.payload.callId, errorType: 'aborted' });
    expect(failed[0]!.parentEventId).toBe(startedCmd.eventId);
    expect(events.slice(-2).map((e) => e.type)).toEqual(['tool.call_failed', 'run.completed']);
    expect(events.at(-1)).toMatchObject({ payload: { outcome: 'stopped' } });
    expect(r.recorder.getRun(runId)?.status).toBe('stopped');
    expect(r.manager.activeRunId).toBeNull();
  });

  it('pause holds the run at the next step; resume continues it to the same sequence', { timeout: 60_000 }, async () => {
    const r = runtime();
    const { runId } = r.manager.start({ missionId: 'coding-mission', speed: 0 });
    let pausedAt = 0;
    r.recorder.subscribe(runId, (e) => {
      if (!pausedAt && e.type === 'agent.state_changed' && e.payload.state === 'working') {
        pausedAt = e.sequence;
        r.manager.pause(runId);
      }
    });
    await new Promise((res) => setTimeout(res, 400));
    expect(pausedAt).toBeGreaterThan(0);
    const held = r.recorder.listAll(runId);
    expect(held.at(-1)).toMatchObject({ type: 'run.paused', sequence: pausedAt + 1 });
    expect(r.recorder.getRun(runId)).toMatchObject({ status: 'running', paused: true });

    r.manager.resume(runId);
    await r.manager.whenDone(runId);
    const events = r.recorder.listAll(runId);
    expect(events[pausedAt + 1]).toMatchObject({ type: 'run.resumed' });
    expect(events.map((e) => e.type).filter((t) => t !== 'run.paused' && t !== 'run.resumed')).toEqual(codingMissionTypeSequence());
    expect(r.recorder.getRun(runId)).toMatchObject({ status: 'succeeded', paused: false });
  });

  it('stop while paused ends the run as stopped', { timeout: 60_000 }, async () => {
    const r = runtime();
    const { runId } = r.manager.start({ missionId: 'coding-mission', speed: 0 });
    r.manager.pause(runId);
    await new Promise((res) => setTimeout(res, 100));
    r.manager.stop(runId);
    const summary = await r.manager.whenDone(runId);
    expect(summary).toMatchObject({ status: 'stopped', paused: false });
    const types = r.recorder.listAll(runId).map((e) => e.type);
    expect(types).toEqual(['run.started', 'run.paused', 'run.completed']);
  });

  it('redacts an env secret from every recorded event and artifact', { timeout: 60_000 }, async () => {
    // The secret's value shows up in real tool output (a failing test name).
    const secret = 'listOpen reflects complete()';
    const r = runtime({ env: { DEMO_API_TOKEN: secret } });
    const { runId, events } = await runMission(r);
    expect(events.map((e) => e.type)).toEqual(codingMissionTypeSequence());
    expect(JSON.stringify(events)).not.toContain(secret);
    const first = completionsOf(events, 'run_command')[0]!;
    expect(first.visibility).toBe('redacted');
    expect(first.payload.failingTests).toEqual([M.failingTests[0], '[REDACTED]']);
    for (const a of ofType(events, 'artifact.created')) {
      expect(r.recorder.getArtifact(runId, a.payload.artifactId)!.content.toString()).not.toContain(secret);
    }
  });
});
