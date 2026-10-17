/**
 * Scripted adapter for examples/coding-mission.
 *
 * The *decisions* are scripted (which agent does what, and which source file
 * the Builder writes, taken from the mission's script/ directory). Every tool
 * result is real: files are listed, read and written in the run workspace and
 * the test suite really runs. Branches follow those real results:
 * - first test run passes → no fix task, run succeeds;
 * - it fails → T3 blocks, the coordinator creates T4 (fix), the Builder writes
 *   the fix, T3 is retried; the rerun's real result decides the outcome.
 *
 * Ids match @runloop-world/testkit CODING_MISSION, and a successful run with a
 * failing first test run produces exactly codingMissionTypeSequence().
 */
import { readFileSync } from 'node:fs';
import type { PayloadOf } from '@runloop-world/events';
import type { AdapterEventType, AdapterResult, AgentAdapter, RunContext, ToolCall, ToolResult } from '../adapter';
import type { Mission } from '../mission';
import { resolveInside } from '../sandbox/paths';

/** Rough pacing at speed 1 (ms); mirrors testkit CODING_MISSION_PACE. */
const PACE = { working: 1500, step: 700 } as const;

const AGENTS = {
  coordinator: { agentId: 'coordinator', name: 'Coordinator', role: 'coordinator', tools: [] as string[] },
  researcher: { agentId: 'researcher', name: 'Researcher', role: 'research', tools: ['list_files', 'read_file'], preset: 'researcher' },
  builder: { agentId: 'builder', name: 'Builder', role: 'build', tools: ['read_file', 'write_file'], preset: 'builder' },
  tester: { agentId: 'tester', name: 'Tester', role: 'test', tools: ['run_command', 'read_file'], preset: 'tester' },
} as const;

const TASKS = {
  research: { taskId: 'T1', title: 'Survey the repository and the test suite', kind: 'research', plannedSteps: 3 },
  code: { taskId: 'T2', title: 'Implement the task store', kind: 'code', plannedSteps: 2 },
  test: { taskId: 'T3', title: 'Run the test suite', kind: 'test', plannedSteps: 1 },
  fix: { taskId: 'T4', title: 'Fix the failing tests', kind: 'fix', plannedSteps: 2 },
} as const;

type TaskDef = (typeof TASKS)[keyof typeof TASKS];

interface ScriptConfig {
  /** Workspace file the Builder implements. */
  target: string;
  /** Mission-relative files holding the Builder's first implementation and its fix. */
  implementation: string;
  fix: string;
  testCommand: string[];
}

function readScriptConfig(mission: Mission): ScriptConfig {
  const s = mission.raw.script as Partial<ScriptConfig> | undefined;
  const ok =
    s &&
    typeof s.target === 'string' &&
    typeof s.implementation === 'string' &&
    typeof s.fix === 'string' &&
    Array.isArray(s.testCommand) &&
    s.testCommand.every((a) => typeof a === 'string');
  if (!ok) throw new Error('mission.json: "script" needs target, implementation, fix and testCommand');
  return s as ScriptConfig;
}

/** A step the mission cannot recover from: the task fails and the run ends as failed. */
class TaskFailure extends Error {
  constructor(
    readonly taskId: string,
    readonly agentId: string,
    readonly reason: string,
    readonly errorType?: string,
  ) {
    super(reason);
  }
}

export const scriptedCodingMission: AgentAdapter = {
  info: {
    id: 'scripted-coding-mission',
    kind: 'scripted',
    label: 'Scripted adapter — deterministic decisions, real tools',
  },

  async run(ctx: RunContext, mission: Mission): Promise<AdapterResult> {
    const cfg = readScriptConfig(mission);
    const source = (rel: string) => readFileSync(resolveInside(mission.dir, rel), 'utf8');
    const { coordinator, researcher, builder, tester } = AGENTS;
    let msgN = 0;

    const say = async <T extends AdapterEventType>(
      waitMs: number,
      type: T,
      payload: PayloadOf<T>,
      meta?: { actorId?: string },
    ) => {
      await ctx.pace(waitMs);
      return ctx.emit(type, payload, meta);
    };
    const working = async (agentId: string, reason?: string) => {
      await say(200, 'agent.state_changed', { agentId, state: 'working', ...(reason ? { reason } : {}) });
      await ctx.pace(PACE.working);
    };
    const idle = (agentId: string) => say(100, 'agent.state_changed', { agentId, state: 'idle' });
    const create = (t: TaskDef, dependsOn: string[]) =>
      say(
        300,
        'task.created',
        { taskId: t.taskId, title: t.title, kind: t.kind, dependsOn, plannedSteps: t.plannedSteps },
        { actorId: coordinator.agentId },
      );
    const assignAndStart = async (taskId: string, agentId: string) => {
      await say(PACE.step, 'task.assigned', { taskId, agentId }, { actorId: coordinator.agentId });
      await say(100, 'task.started', { taskId, agentId });
    };
    const message = (fromAgentId: string, to: string, text: string) =>
      say(PACE.step, 'agent.message_sent', { messageId: `msg-${++msgN}`, fromAgentId, to, text });
    const complete = (taskId: string, summary: string, artifactIds: string[]) =>
      say(PACE.step, 'task.completed', { taskId, summary, artifactIds });
    const tool = async (agentId: string, taskId: string, call: ToolCall): Promise<ToolResult> => {
      await ctx.pace(PACE.step);
      return ctx.tools.invoke(agentId, taskId, call);
    };
    /** A tool that must succeed for the task to continue. */
    const must = async (agentId: string, taskId: string, call: ToolCall): Promise<ToolResult> => {
      const r = await tool(agentId, taskId, call);
      if (r.status !== 'success') throw new TaskFailure(taskId, agentId, `${call.tool} failed: ${r.outputSummary}`, r.errorType);
      return r;
    };
    const testsPassed = async (run: ToolResult): Promise<AdapterResult> => {
      await complete(
        TASKS.test.taskId,
        run.metrics ? `All ${run.metrics.tests} tests pass` : 'The test command passed',
        run.artifactIds,
      );
      await idle(tester.agentId);
      await ctx.pace(PACE.step);
      const counts = run.metrics ? `; ${run.metrics.passed}/${run.metrics.tests} tests pass` : '';
      return { outcome: 'succeeded', summary: `All tasks completed${counts}` };
    };

    try {
      // ── Setup ───────────────────────────────────────────────────
      await say(100, 'agent.registered', {
        agentId: coordinator.agentId,
        name: coordinator.name,
        role: coordinator.role,
        model: null,
        tools: [],
        embodied: false,
      });
      for (const a of [researcher, builder, tester]) {
        await say(100, 'agent.registered', {
          agentId: a.agentId,
          name: a.name,
          role: a.role,
          model: null,
          tools: [...a.tools],
          embodied: true,
          characterPreset: a.preset,
        });
      }
      await create(TASKS.research, []);
      await create(TASKS.code, [TASKS.research.taskId]);
      await create(TASKS.test, [TASKS.code.taskId]);

      // ── T1 research: what does the test suite expect? ──────────
      const T1 = TASKS.research.taskId;
      await assignAndStart(T1, researcher.agentId);
      await working(researcher.agentId);
      const listing = await must(researcher.agentId, T1, { tool: 'list_files', path: '.' });
      await must(researcher.agentId, T1, { tool: 'read_file', path: 'README.md' });
      const testFile = (listing.output ?? '').split('\n').find((f) => /\.test\.[cm]?js$/.test(f));
      if (!testFile) throw new TaskFailure(T1, researcher.agentId, 'No test file found in the repository');
      const suite = (await must(researcher.agentId, T1, { tool: 'read_file', path: testFile })).output ?? '';
      const testCount = suite.match(/^\s*test\(/gm)?.length ?? 0;
      const methods = [...new Set([...suite.matchAll(/store\.(\w+)\(/g)].map((m) => m[1]!))];
      await message(
        researcher.agentId,
        builder.agentId,
        `${cfg.target} needs ${methods.join('/') || 'an implementation'}; ${testCount} tests in ${testFile}`,
      );
      await complete(T1, `Mapped the API surface and the ${testCount} tests`, []);
      await idle(researcher.agentId);

      // ── T2 code ────────────────────────────────────────────────
      const T2 = TASKS.code.taskId;
      await assignAndStart(T2, builder.agentId);
      await working(builder.agentId);
      await must(builder.agentId, T2, { tool: 'read_file', path: cfg.target });
      const written = await must(builder.agentId, T2, {
        tool: 'write_file',
        path: cfg.target,
        content: source(cfg.implementation),
        summary: `First implementation of ${cfg.target}`,
      });
      await complete(T2, `Implemented ${cfg.target}`, written.artifactIds);
      await idle(builder.agentId);

      // ── T3 test (attempt 1) ─────────────────────────────────────
      const T3 = TASKS.test.taskId;
      await assignAndStart(T3, tester.agentId);
      await working(tester.agentId);
      const first = await tool(tester.agentId, T3, { tool: 'run_command', argv: cfg.testCommand });
      if (first.status === 'failed') {
        throw new TaskFailure(T3, tester.agentId, `The test command could not run: ${first.outputSummary}`, first.errorType);
      }
      if (first.status === 'success') return await testsPassed(first);

      // Real failure → block T3 on a new fix task.
      const failing = first.failingTests ?? [];
      const T4 = TASKS.fix.taskId;
      await create(TASKS.fix, []);
      await say(100, 'task.blocked', {
        taskId: T3,
        reason: first.metrics ? `${first.metrics.failed} of ${first.metrics.tests} tests failing` : `Tests failed (${first.outputSummary})`,
        blockedBy: [T4],
      });
      await say(100, 'agent.state_changed', { agentId: tester.agentId, state: 'waiting', reason: 'waiting for a fix' });
      await message(
        tester.agentId,
        builder.agentId,
        failing.length ? `Failing: ${failing.join('; ')}` : `Tests failed: ${first.outputSummary}`,
      );

      // ── T4 fix ─────────────────────────────────────────────────
      await assignAndStart(T4, builder.agentId);
      await working(builder.agentId);
      await must(builder.agentId, T4, { tool: 'read_file', path: cfg.target });
      const fixed = await must(builder.agentId, T4, {
        tool: 'write_file',
        path: cfg.target,
        content: source(cfg.fix),
        summary: failing.length ? `Fix for: ${failing.join('; ')}` : `Fix for the failing tests`,
      });
      await complete(T4, `Patched ${cfg.target} for ${failing.length || 'the'} failing test${failing.length === 1 ? '' : 's'}`, fixed.artifactIds);
      await idle(builder.agentId);

      // ── T3 retry (attempt 2) ────────────────────────────────────
      await say(PACE.step, 'task.started', { taskId: T3, agentId: tester.agentId });
      await working(tester.agentId, 'retrying after fix');
      const rerun = await tool(tester.agentId, T3, { tool: 'run_command', argv: cfg.testCommand });
      if (rerun.status === 'success') return await testsPassed(rerun);
      throw new TaskFailure(
        T3,
        tester.agentId,
        rerun.status === 'failed'
          ? `The test command could not run: ${rerun.outputSummary}`
          : `Tests still failing after the fix: ${rerun.outputSummary}`,
        rerun.errorType,
      );
    } catch (err) {
      if (!(err instanceof TaskFailure)) throw err;
      await say(PACE.step, 'task.failed', {
        taskId: err.taskId,
        reason: err.reason,
        ...(err.errorType ? { errorType: err.errorType } : {}),
      });
      await say(100, 'agent.state_changed', { agentId: err.agentId, state: 'failed', reason: err.reason });
      await ctx.pace(PACE.step);
      return { outcome: 'failed', summary: err.reason };
    }
  },
};
