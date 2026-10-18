import { createHash } from 'node:crypto';
import type { RunEvent } from '@runloop-world/events';
import { RunBuilder, type RunBuilderOptions } from './builder';

/**
 * Canonical identifiers for the "coding-mission" demo. The runtime's scripted
 * adapter uses the same ids, and its integration test asserts that a real run
 * produces exactly the event-type sequence of {@link codingMissionFixture}.
 */
export const CODING_MISSION = {
  missionId: 'coding-mission',
  worldId: 'research-campus',
  seed: 42,
  title: 'Build a task store and make its test suite pass',
  adapter: {
    id: 'scripted-coding-mission',
    kind: 'scripted' as const,
    label: 'Scripted adapter — deterministic decisions, real tools',
  },
  agents: {
    coordinator: { agentId: 'coordinator', name: 'Coordinator', role: 'coordinator', preset: undefined },
    researcher: { agentId: 'researcher', name: 'Researcher', role: 'research', preset: 'researcher' },
    builder: { agentId: 'builder', name: 'Builder', role: 'build', preset: 'builder' },
    tester: { agentId: 'tester', name: 'Tester', role: 'test', preset: 'tester' },
  },
  tools: {
    researcher: ['list_files', 'read_file'],
    builder: ['read_file', 'write_file'],
    tester: ['run_command', 'read_file'],
  },
  tasks: {
    research: { taskId: 'T1', title: 'Survey the repository and the test suite', kind: 'research' as const, plannedSteps: 3 },
    code: { taskId: 'T2', title: 'Implement the task store', kind: 'code' as const, plannedSteps: 2 },
    test: { taskId: 'T3', title: 'Run the test suite', kind: 'test' as const, plannedSteps: 1 },
    fix: { taskId: 'T4', title: 'Fix the failing tests', kind: 'fix' as const, plannedSteps: 2 },
  },
  testCommand: 'node --test --test-reporter=tap',
  /** Test names in examples/coding-mission/repo that the planted bug breaks. */
  failingTests: ['listOpen returns only tasks that are not done', 'listOpen reflects complete()'],
  totalTests: 12,
} as const;

/** Rough pacing used by the scripted adapter at speed 1 (ms). */
export const CODING_MISSION_PACE = { working: 1500, step: 700 } as const;

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The canonical successful coding-mission run (58 events): research, a real
 * failing test run (10 passed, 2 failed), a fix, a passing rerun.
 */
export function codingMissionFixture(opts: RunBuilderOptions = {}): RunEvent[] {
  const M = CODING_MISSION;
  const b = new RunBuilder({ startIso: '2026-10-17T09:00:00.000Z', ...opts });
  const { coordinator, researcher, builder, tester } = M.agents;
  const T = M.tasks;
  let callN = 0;
  let artN = 0;
  let msgN = 0;

  const working = (agentId: string, reason?: string) => {
    b.wait(200).add('agent.state_changed', { agentId, state: 'working', ...(reason ? { reason } : {}) });
    b.wait(CODING_MISSION_PACE.working);
  };

  const tool = (
    agentId: string,
    taskId: string,
    toolName: string,
    inputSummary: string,
    result: {
      status: 'success' | 'error';
      outputSummary: string;
      durationMs: number;
      exitCode?: number;
      metrics?: { tests: number; passed: number; failed: number };
      failingTests?: string[];
      errorType?: string;
      artifact?: { kind: 'file' | 'test_report'; name: string; mediaType: string; content: string; path?: string; summary: string };
    },
  ) => {
    callN += 1;
    const callId = `call-${callN}`;
    const started = b.wait(CODING_MISSION_PACE.step).add('tool.call_started', {
      callId,
      agentId,
      taskId,
      tool: toolName,
      inputSummary,
      // Like the runtime's tool invoker: the path for file tools, the program for run_command.
      target: toolName === 'run_command' ? inputSummary.split(' ')[0]! : inputSummary,
    });
    b.wait(result.durationMs);
    const artifactIds: string[] = [];
    if (result.artifact) {
      artN += 1;
      const artifactId = `art-${artN}`;
      artifactIds.push(artifactId);
      const a = result.artifact;
      b.add(
        'artifact.created',
        {
          artifactId,
          kind: a.kind,
          name: a.name,
          mediaType: a.mediaType,
          bytes: Buffer.byteLength(a.content),
          sha256: sha(a.content),
          ...(a.path ? { path: a.path } : {}),
          producedByCallId: callId,
          summary: a.summary,
        },
        { actorId: agentId, taskId, parentEventId: started.eventId },
      );
    }
    b.add(
      'tool.call_completed',
      {
        callId,
        status: result.status,
        durationMs: result.durationMs,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        outputSummary: result.outputSummary,
        ...(result.metrics ? { metrics: result.metrics } : {}),
        ...(result.failingTests ? { failingTests: result.failingTests } : {}),
        ...(artifactIds.length ? { outputArtifactIds: artifactIds } : {}),
        ...(result.errorType ? { errorType: result.errorType } : {}),
      },
      { actorId: agentId, taskId, parentEventId: started.eventId },
    );
    return artifactIds;
  };

  const message = (fromAgentId: string, to: string, text: string) => {
    msgN += 1;
    b.wait(CODING_MISSION_PACE.step).add('agent.message_sent', { messageId: `msg-${msgN}`, fromAgentId, to, text });
  };

  // ── Setup ─────────────────────────────────────────────────────────
  b.add(
    'run.started',
    {
      title: M.title,
      missionId: M.missionId,
      worldId: M.worldId,
      seed: M.seed,
      adapter: { ...M.adapter },
      workspace: `workspaces/${b.runId}`,
      // Like the runtime's run manager: the fixture's timing is the adapter's pacing at speed 1.
      speed: 1,
    },
    { actorId: 'system' },
  );
  b.wait(100).add('agent.registered', {
    agentId: coordinator.agentId,
    name: coordinator.name,
    role: coordinator.role,
    model: null,
    tools: [],
    embodied: false,
  });
  for (const a of [researcher, builder, tester]) {
    b.wait(100).add('agent.registered', {
      agentId: a.agentId,
      name: a.name,
      role: a.role,
      model: null,
      tools: [...M.tools[a.agentId]],
      embodied: true,
      characterPreset: a.preset,
    });
  }
  const created = (t: { taskId: string; title: string; kind: (typeof T)[keyof typeof T]['kind']; plannedSteps: number }, dependsOn: string[]) =>
    b.wait(300).add(
      'task.created',
      { taskId: t.taskId, title: t.title, kind: t.kind, dependsOn, plannedSteps: t.plannedSteps },
      { actorId: coordinator.agentId },
    );
  created(T.research, []);
  created(T.code, [T.research.taskId]);
  created(T.test, [T.code.taskId]);

  const assignAndStart = (taskId: string, agentId: string) => {
    b.wait(CODING_MISSION_PACE.step).add('task.assigned', { taskId, agentId }, { actorId: coordinator.agentId });
    b.wait(100).add('task.started', { taskId, agentId });
  };

  // ── T1 research ───────────────────────────────────────────────────
  assignAndStart(T.research.taskId, researcher.agentId);
  working(researcher.agentId);
  tool(researcher.agentId, T.research.taskId, 'list_files', '.', {
    status: 'success',
    outputSummary: '6 entries',
    durationMs: 4,
  });
  tool(researcher.agentId, T.research.taskId, 'read_file', 'README.md', {
    status: 'success',
    outputSummary: 'read 640 bytes',
    durationMs: 2,
  });
  tool(researcher.agentId, T.research.taskId, 'read_file', 'test/task-store.test.js', {
    status: 'success',
    outputSummary: 'read 3120 bytes',
    durationMs: 2,
  });
  message(
    researcher.agentId,
    builder.agentId,
    'task-store needs add/get/all/complete/listOpen; 12 tests in test/task-store.test.js',
  );
  b.wait(CODING_MISSION_PACE.step).add('task.completed', {
    taskId: T.research.taskId,
    summary: 'Mapped the API surface and the 12 tests',
    artifactIds: [],
  });
  b.wait(100).add('agent.state_changed', { agentId: researcher.agentId, state: 'idle' });

  // ── T2 code ───────────────────────────────────────────────────────
  assignAndStart(T.code.taskId, builder.agentId);
  working(builder.agentId);
  tool(builder.agentId, T.code.taskId, 'read_file', 'src/task-store.js', {
    status: 'success',
    outputSummary: 'read 210 bytes',
    durationMs: 2,
  });
  const buggy = tool(builder.agentId, T.code.taskId, 'write_file', 'src/task-store.js', {
    status: 'success',
    outputSummary: 'wrote 900 bytes',
    durationMs: 3,
    artifact: {
      kind: 'file',
      name: 'task-store.js',
      mediaType: 'text/javascript',
      content: '// buggy implementation (fixture)\n',
      path: 'src/task-store.js',
      summary: 'Implementation of createStore()',
    },
  });
  b.wait(CODING_MISSION_PACE.step).add('task.completed', {
    taskId: T.code.taskId,
    summary: 'Implemented the task store',
    artifactIds: buggy,
  });
  b.wait(100).add('agent.state_changed', { agentId: builder.agentId, state: 'idle' });

  // ── T3 test: real failure ─────────────────────────────────────────
  assignAndStart(T.test.taskId, tester.agentId);
  working(tester.agentId);
  tool(tester.agentId, T.test.taskId, 'run_command', M.testCommand, {
    status: 'error',
    exitCode: 1,
    outputSummary: '12 tests: 10 passed, 2 failed',
    durationMs: 380,
    metrics: { tests: M.totalTests, passed: 10, failed: 2 },
    failingTests: [...M.failingTests],
    errorType: 'tests_failed',
    artifact: {
      kind: 'test_report',
      name: 'test-output.tap',
      mediaType: 'text/plain',
      content: 'TAP version 13\n# tests 12\n# pass 10\n# fail 2\n',
      summary: 'node --test output (exit 1)',
    },
  });
  created(T.fix, []);
  b.wait(100).add('task.blocked', {
    taskId: T.test.taskId,
    reason: '2 of 12 tests failing',
    blockedBy: [T.fix.taskId],
  });
  b.wait(100).add('agent.state_changed', {
    agentId: tester.agentId,
    state: 'waiting',
    reason: 'waiting for a fix',
  });
  message(tester.agentId, builder.agentId, `Failing: ${M.failingTests.join('; ')}`);

  // ── T4 fix ────────────────────────────────────────────────────────
  assignAndStart(T.fix.taskId, builder.agentId);
  working(builder.agentId);
  tool(builder.agentId, T.fix.taskId, 'read_file', 'src/task-store.js', {
    status: 'success',
    outputSummary: 'read 900 bytes',
    durationMs: 2,
  });
  const fixed = tool(builder.agentId, T.fix.taskId, 'write_file', 'src/task-store.js', {
    status: 'success',
    outputSummary: 'wrote 901 bytes',
    durationMs: 3,
    artifact: {
      kind: 'file',
      name: 'task-store.js',
      mediaType: 'text/javascript',
      content: '// fixed implementation (fixture)\n',
      path: 'src/task-store.js',
      summary: 'listOpen() now keeps tasks that are not done',
    },
  });
  b.wait(CODING_MISSION_PACE.step).add('task.completed', {
    taskId: T.fix.taskId,
    summary: 'Fixed listOpen() filter',
    artifactIds: fixed,
  });
  b.wait(100).add('agent.state_changed', { agentId: builder.agentId, state: 'idle' });

  // ── T3 retry: pass ────────────────────────────────────────────────
  b.wait(CODING_MISSION_PACE.step).add('task.started', { taskId: T.test.taskId, agentId: tester.agentId });
  working(tester.agentId, 'retrying after fix');
  const report = tool(tester.agentId, T.test.taskId, 'run_command', M.testCommand, {
    status: 'success',
    exitCode: 0,
    outputSummary: '12 tests: 12 passed, 0 failed',
    durationMs: 360,
    metrics: { tests: M.totalTests, passed: 12, failed: 0 },
    artifact: {
      kind: 'test_report',
      name: 'test-output.tap',
      mediaType: 'text/plain',
      content: 'TAP version 13\n# tests 12\n# pass 12\n# fail 0\n',
      summary: 'node --test output (exit 0)',
    },
  });
  b.wait(CODING_MISSION_PACE.step).add('task.completed', {
    taskId: T.test.taskId,
    summary: 'All 12 tests pass',
    artifactIds: report,
  });
  b.wait(100).add('agent.state_changed', { agentId: tester.agentId, state: 'idle' });
  b.wait(CODING_MISSION_PACE.step).add(
    'run.completed',
    { outcome: 'succeeded', summary: 'All tasks completed; 12/12 tests pass' },
    { actorId: 'system' },
  );
  return b.events;
}

/** Just the ordered event types of the canonical run (what the runtime must reproduce). */
export function codingMissionTypeSequence(): string[] {
  return codingMissionFixture().map((e) => e.type);
}
