import type { ExecState, IncidentKind, TaskExec, ToolCallExec, UsageExec } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import { isTracedExec, usageSourceText, usageTotal } from './labels';

/**
 * Run metrics (D8), computed from the folded execution state and the event
 * log only. Missing data stays missing: a value the source never reported is
 * null (shown as "not reported"), never zero. Counts are of recorded events,
 * so a count of 0 means "recorded none", which is a real value.
 */

export interface CountRow {
  key: string;
  count: number;
  /** Calls that ended in an error or could not run. */
  errors: number;
}

export interface AgentUsageRow {
  agentId: string;
  name: string;
  /** Model as the source reported it (usage report, else registration); null = not reported. */
  model: string | null;
  /** The agent's latest usage report; null = not reported. */
  usage: UsageExec | null;
  /** Total tokens of that report; null = not reported. */
  totalTokens: number | null;
  /** "reported by Claude Code (Agent tool result)"; null when nothing was reported. */
  reportedBy: string | null;
}

export interface RunMetrics {
  traced: boolean;
  events: number;
  /** Run start to its end (or to the last event while running); null before run.started. */
  duration: { ms: number; running: boolean } | null;
  calls: {
    total: number;
    success: number;
    /** The tool ran and reported an error (e.g. a failing test run). */
    error: number;
    /** The call never ran or its result never arrived (denied, interrupted, unobserved, ...). */
    couldNotRun: number;
    running: number;
    /** Calls whose start or end Runloop reconstructed (inferred) instead of the source reporting it. */
    inferred: number;
    /** Calls with a category (traced runs); the rest are not categorised by their source. */
    categorised: number;
    byCategory: CountRow[];
    byTool: CountRow[];
  };
  failures: {
    total: number;
    /** Not resolved yet: executed runs, its task has not finished since; traced runs, no later call of the same kind succeeded. */
    open: number;
    /** Resolved because a later call of the same kind succeeded (traced runs; inferred by Runloop). */
    resolvedByLaterSuccess: number;
    byKind: Partial<Record<IncidentKind, number>>;
    /** Sequence of the first failure, to jump to it. */
    firstSeq: number | null;
  };
  /** null = no call reported test counts. */
  tests: {
    /** Calls that reported test counts. */
    runs: number;
    /** Of those, runs with at least one failing test. */
    failingRuns: number;
    latest: { tests: number; passed: number; failed: number; seq: number; callId: string };
  } | null;
  usage: {
    agents: AgentUsageRow[];
    /** Agents with a usage report. */
    reportedAgents: number;
    /** Sum of the reported totals; null when no agent reported usage (never 0 for "none"). */
    reportedTotal: number | null;
  };
  permissions: {
    requested: number;
    approved: number;
    denied: number;
    pending: number;
    /** Answers Runloop reconstructed (e.g. a denial no hook reported). */
    inferred: number;
    /** Waits with a recorded answer time; null when none (inferred answers have no real time). */
    waits: { count: number; totalMs: number; longestMs: number } | null;
  };
  /** Prompts / turns (traced runs); null for executed runs. */
  turns: number | null;
  /** Work handed to subagents. */
  delegations: number;
  /** No source reports cost today. */
  cost: null;
}

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN);

function countBy(calls: readonly ToolCallExec[], keyOf: (c: ToolCallExec) => string | null): CountRow[] {
  const rows = new Map<string, CountRow>();
  for (const c of calls) {
    const key = keyOf(c);
    if (key === null) continue;
    const row = rows.get(key) ?? { key, count: 0, errors: 0 };
    row.count += 1;
    if (c.status === 'error' || c.status === 'failed') row.errors += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Metrics for a run from its latest folded state and its events (in sequence order). */
export function computeRunMetrics(exec: ExecState, events: readonly AnyEvent[]): RunMetrics {
  const calls = exec.callOrder.map((id) => exec.toolCalls.get(id)!).filter(Boolean);
  const tasks = exec.taskOrder.map((id) => exec.tasks[id]!).filter(Boolean);
  const timeOf = (seq: number | null) => (seq !== null ? ms(events[seq - 1]?.timestamp) : NaN);

  // Duration: run start → run end, or → the last event while the run is still going.
  const start = ms(exec.run.startedAt);
  const ended = exec.run.endedAt !== null;
  const end = ended ? ms(exec.run.endedAt) : ms(events.at(-1)?.timestamp);
  const duration = Number.isFinite(start) && Number.isFinite(end) ? { ms: Math.max(0, end - start), running: !ended } : null;

  // Tests: only counts the test runner reported (tool.call_completed metrics).
  const testCalls = calls.filter((c) => c.metrics !== null && c.endedSeq !== null);
  const latestTest = testCalls.reduce<ToolCallExec | null>((a, c) => (a === null || c.endedSeq! > a.endedSeq! ? c : a), null);

  // Usage: per agent, the latest report exactly as reported.
  const agents: AgentUsageRow[] = exec.agentOrder
    .map((id) => exec.agents[id]!)
    .filter((a) => a && a.role !== 'user')
    .map((a) => ({
      agentId: a.id,
      name: a.name,
      model: a.usage?.model ?? a.model,
      usage: a.usage,
      totalTokens: a.usage ? usageTotal(a.usage) : null,
      reportedBy: a.usage ? usageSourceText(a.usage.source) : null,
    }));
  const reported = agents.filter((a) => a.totalTokens !== null);

  // Permissions: waits only where the answer time was recorded, not inferred.
  const perms = Object.values(exec.permissions);
  const timed = perms
    .filter((p) => p.status !== 'pending' && p.resolvedProvenance !== 'inferred')
    .map((p) => timeOf(p.resolvedSeq) - timeOf(p.requestedSeq))
    .filter((d) => Number.isFinite(d) && d >= 0);

  const byKind: Partial<Record<IncidentKind, number>> = {};
  for (const i of exec.incidents) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  const ofKind = (k: TaskExec['kind']) => tasks.filter((t) => t.kind === k).length;
  const traced = isTracedExec(exec);

  return {
    traced,
    events: exec.lastSequence,
    duration,
    calls: {
      total: calls.length,
      success: calls.filter((c) => c.status === 'success').length,
      error: calls.filter((c) => c.status === 'error').length,
      couldNotRun: calls.filter((c) => c.status === 'failed').length,
      running: calls.filter((c) => c.status === 'running').length,
      inferred: calls.filter((c) => c.startProvenance === 'inferred' || c.endProvenance === 'inferred').length,
      categorised: calls.filter((c) => c.category !== null).length,
      byCategory: countBy(calls, (c) => c.category),
      byTool: countBy(calls, (c) => c.tool),
    },
    failures: {
      total: exec.incidents.length,
      open: exec.incidents.filter((i) => i.resolvedSeq === null).length,
      resolvedByLaterSuccess: exec.incidents.filter((i) => i.resolution === 'later_success').length,
      byKind,
      firstSeq: exec.incidents[0]?.seq ?? null,
    },
    tests: latestTest
      ? {
          runs: testCalls.length,
          failingRuns: testCalls.filter((c) => c.metrics!.failed > 0).length,
          latest: { ...latestTest.metrics!, seq: latestTest.endedSeq!, callId: latestTest.id },
        }
      : null,
    usage: {
      agents,
      reportedAgents: reported.length,
      reportedTotal: reported.length ? reported.reduce((sum, a) => sum + a.totalTokens!, 0) : null,
    },
    permissions: {
      requested: perms.length,
      approved: perms.filter((p) => p.status === 'approved').length,
      denied: perms.filter((p) => p.status === 'denied').length,
      pending: perms.filter((p) => p.status === 'pending').length,
      inferred: perms.filter((p) => p.resolvedProvenance === 'inferred').length,
      waits: timed.length ? { count: timed.length, totalMs: timed.reduce((a, b) => a + b, 0), longestMs: Math.max(...timed) } : null,
    },
    turns: traced ? ofKind('turn') : null,
    delegations: ofKind('delegated'),
    cost: null,
  };
}
