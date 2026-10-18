import type { RunMode, RunOutcome, TestMetrics, ToolCategory, TraceSource } from '@runloop-world/events';
import type { ExecState, IncidentKind, RunExecStatus, ToolCallExec, ToolCallStatus, UsageExec } from './types';

/**
 * Run compare (Milestone C, DL-008): a digest of one run's folded state, and
 * a diff of two digests. Pure functions of Layer 1.
 *
 * Honesty rules:
 * - A value the source never reported is null, never 0. A count of recorded
 *   events (tool calls, failures) is a real value, so 0 is allowed there.
 * - A difference is only `comparable` when both sides measured the same thing
 *   the same way; otherwise the diff carries a {@link DiffNote} saying why.
 * - Executed runs (Runloop ran the tools) and traced runs (a source reported
 *   them) can be compared, but the diff flags it (`mode_differs`).
 * - No verdict is drawn from what is not final or not like for like: a run
 *   still recording, a run that did not run to completion (stopped or
 *   interrupted), runs that ended differently, test runs of a different
 *   scope ({@link DiffCaveat}). Time spent paused is not duration.
 */

// ── digest ─────────────────────────────────────────────────────────────

/** A call's category; `uncategorised` when the source gave none. */
export type CallCategory = ToolCategory | 'uncategorised';

/**
 * Categories of the runtime's own sandbox tools (executed runs carry no
 * category on the wire: these are their definitions, not a guess).
 * `run_command` counts as a test run when it reported test counts.
 */
const RUNTIME_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  list_files: 'search',
  read_file: 'read',
  write_file: 'edit',
  run_command: 'execute',
};

export interface DigestCall {
  /** Position in the run's call order (0-based). */
  index: number;
  callId: string;
  /** Sequence of its tool.call_started. */
  seq: number;
  /** Sequence of its terminal event (null while running). */
  endSeq: number | null;
  agentId: string;
  tool: string;
  category: CallCategory;
  /** reported: on the event; runtime_tool: Runloop's own tool (executed runs); null: uncategorised. */
  categorySource: 'reported' | 'runtime_tool' | null;
  /** File/directory path or command head; null = not reported. */
  target: string | null;
  status: ToolCallStatus;
  metrics: TestMetrics | null;
  /** Failing test names the call reported (may be fewer than metrics.failed, or none). */
  failingTests: string[];
}

export interface CountEntry {
  key: string;
  count: number;
  /** Calls that ended in an error or could not run. */
  failed: number;
  /** Start sequence of the first call (to open it). */
  firstSeq: number;
}

export interface FileTouch {
  path: string;
  reads: number;
  writes: number;
  /** Start sequence of the first call that touched it. */
  firstSeq: number;
  /** Start sequence of the first write (null when only read). */
  firstWriteSeq: number | null;
  /** Of those calls, how many ended in an error or could not run (e.g. reading a missing file). */
  failed: number;
}

export interface TestRunDigest {
  callId: string;
  /** Sequence of the result that reported the counts. */
  seq: number;
  tests: number;
  passed: number;
  failed: number;
  /** Failing test names as reported (may be fewer than `failed`, or none). */
  failingTests: string[];
}

export interface FailureDigest {
  seq: number;
  kind: IncidentKind;
  message: string;
  agentId: string | null;
  resolved: boolean;
}

export interface AgentDigest {
  /** Stable key for matching agents across runs: the name (made unique within the run). */
  key: string;
  agentId: string;
  name: string;
  role: string;
  /** Model as reported (usage report, else registration); null = not reported. */
  model: string | null;
  /** Total tokens of its latest usage report; null = not reported. */
  tokens: number | null;
  /** Sequence of that report (null = none). */
  usageSeq: number | null;
}

export interface PermissionDigest {
  seq: number;
  action: string;
  status: 'pending' | 'approved' | 'denied';
  /** The answer was reconstructed by Runloop (e.g. a denial no hook reported). */
  inferred: boolean;
}

export interface RunDigest {
  runId: string | null;
  title: string;
  mode: RunMode;
  sourceKind: TraceSource['kind'] | null;
  status: RunExecStatus;
  /** Terminal outcome; null while the run is pending or running. */
  outcome: RunOutcome | null;
  ended: boolean;
  startedAt: string | null;
  endedAt: string | null;
  /** Start to end, less the recorded pauses; null until the run has ended (or when a time is missing). */
  durationMs: number | null;
  /** Time spent paused (run.paused → run.resumed), left out of durationMs. */
  pausedMs: number;
  /** Executed runs: the scripted adapter's pacing multiplier (null = not recorded, or a traced run). */
  speed: number | null;
  events: number;
  calls: DigestCall[];
  toolCalls: {
    total: number;
    /** Ended in an error or could not run. */
    failed: number;
    byCategory: CountEntry[];
    byTool: CountEntry[];
  };
  failures: { total: number; open: number; items: FailureDigest[] };
  files: {
    /** Files read or written, by path (from call targets), sorted by path. */
    touched: FileTouch[];
    /** Read/edit calls that did not name their file (older logs): the file list is incomplete. */
    untargeted: number;
  };
  /** null = no call reported test counts. */
  tests: {
    runs: TestRunDigest[];
    first: TestRunDigest;
    latest: TestRunDigest;
    /** Names failing in the latest run: [] when it passed; null when it failed without names. */
    failingNow: string[] | null;
    /** Whether `failingNow` names every failing test (not cut short or missing). */
    failingNowComplete: boolean;
    /** Names that failed in any test run, in first-seen order. */
    failedAlongTheWay: string[];
    /** Every test run that failed named all its failing tests, so `failedAlongTheWay` is complete. */
    failedAlongTheWayComplete: boolean;
  } | null;
  agents: AgentDigest[];
  /** Sum of the reported totals; null when no agent reported usage. */
  tokens: number | null;
  permissions: {
    requested: number;
    approved: number;
    denied: number;
    pending: number;
    inferred: number;
    /** Total wait of answers with a recorded time (not inferred); null when none. */
    waitMs: number | null;
    items: PermissionDigest[];
  };
  /** Work handed to subagents (traced runs); null for executed runs (fixed agents, not delegation). */
  subagents: number | null;
  /** User turns (traced runs); null for executed runs. */
  turns: number | null;
  /** Cost in USD as the source reported it for this run (Claude Code's final result of a dispatched task); null = not reported. */
  costUsd: number | null;
}

/** What a run's events do not carry but a source reported about the run (e.g. a dispatch's final result). */
export interface RunReports {
  /** Claude Code's reported total_cost_usd for the session (a dispatched run); null or absent = not reported. */
  costUsd?: number | null;
}

const TERMINAL: ReadonlySet<RunExecStatus> = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);

/** The reported total, or the sum of the reported parts when the source gave no total. */
export function reportedTokens(u: UsageExec): number {
  return u.totalTokens ?? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}

/** A call's category as reported, else (executed runs) the category of Runloop's own tool. */
export function callCategory(exec: ExecState, c: ToolCallExec): { category: CallCategory; source: DigestCall['categorySource'] } {
  if (c.category) return { category: c.category, source: 'reported' };
  const own = exec.run.mode === 'executed' ? RUNTIME_TOOL_CATEGORY[c.tool] : undefined;
  if (!own) return { category: 'uncategorised', source: null };
  return { category: own === 'execute' && c.metrics ? 'test' : own, source: 'runtime_tool' };
}

const isFailed = (s: ToolCallStatus) => s === 'error' || s === 'failed';
/** Code-unit order: the same on every machine (localeCompare is not). */
const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

function countBy(calls: readonly DigestCall[], keyOf: (c: DigestCall) => string): CountEntry[] {
  const rows = new Map<string, CountEntry>();
  for (const c of calls) {
    const key = keyOf(c);
    const row = rows.get(key) ?? { key, count: 0, failed: 0, firstSeq: c.seq };
    row.count += 1;
    if (isFailed(c.status)) row.failed += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || byText(a.key, b.key));
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/** What compare needs from one run, from its folded execution state (and what a source reported about it). */
export function summarizeRun(exec: ExecState, reports: RunReports = {}): RunDigest {
  const run = exec.run;
  const ended = TERMINAL.has(run.status);
  const start = ms(run.startedAt);
  const end = ms(run.endedAt);
  const traced = run.mode === 'traced';

  const calls: DigestCall[] = [];
  for (const id of exec.callOrder) {
    const c = exec.toolCalls.get(id);
    if (!c) continue;
    const { category, source } = callCategory(exec, c);
    calls.push({
      index: calls.length,
      callId: c.id,
      seq: c.startedSeq,
      endSeq: c.endedSeq,
      agentId: c.agentId,
      tool: c.tool,
      category,
      categorySource: source,
      target: c.target,
      status: c.status,
      metrics: c.metrics,
      failingTests: c.failingTests,
    });
  }

  // Files: read and edit calls name their file in `target`.
  const files = new Map<string, FileTouch>();
  let untargeted = 0;
  for (const c of calls) {
    if (c.category !== 'read' && c.category !== 'edit') continue;
    if (!c.target) {
      untargeted += 1;
      continue;
    }
    const f = files.get(c.target) ?? { path: c.target, reads: 0, writes: 0, firstSeq: c.seq, firstWriteSeq: null, failed: 0 };
    if (isFailed(c.status)) f.failed += 1;
    if (c.category === 'read') f.reads += 1;
    else {
      f.writes += 1;
      f.firstWriteSeq ??= c.seq;
    }
    files.set(c.target, f);
  }

  // Tests: every completed call that reported counts, in result order.
  const testRuns: TestRunDigest[] = calls
    .map((d) => exec.toolCalls.get(d.callId)!)
    .filter((c) => c.metrics !== null && c.endedSeq !== null)
    .sort((a, b) => a.endedSeq! - b.endedSeq!)
    .map((c) => ({ callId: c.id, seq: c.endedSeq!, ...c.metrics!, failingTests: c.failingTests }));
  let tests: RunDigest['tests'] = null;
  if (testRuns.length > 0) {
    const latest = testRuns.at(-1)!;
    const along: string[] = [];
    for (const t of testRuns) for (const name of t.failingTests) if (!along.includes(name)) along.push(name);
    const failingNow = latest.failed === 0 ? [] : latest.failingTests.length > 0 ? latest.failingTests : null;
    tests = {
      runs: testRuns,
      first: testRuns[0]!,
      latest,
      failingNow,
      failingNowComplete: latest.failed === 0 || latest.failingTests.length >= latest.failed,
      failedAlongTheWay: along,
      failedAlongTheWayComplete: testRuns.every((t) => t.failed === 0 || t.failingTests.length >= t.failed),
    };
  }

  // Agents (not the user), keyed by name for matching across runs.
  const seen = new Map<string, number>();
  const agents: AgentDigest[] = exec.agentOrder
    .map((id) => exec.agents[id])
    .filter((a) => a !== undefined && a.role !== 'user')
    .map((a) => {
      const n = (seen.get(a!.name) ?? 0) + 1;
      seen.set(a!.name, n);
      return {
        key: n === 1 ? a!.name : `${a!.name} (${n})`,
        agentId: a!.id,
        name: a!.name,
        role: a!.role,
        model: a!.usage?.model ?? a!.model,
        tokens: a!.usage ? reportedTokens(a!.usage) : null,
        usageSeq: a!.usage?.seq ?? null,
      };
    });
  const reported = agents.filter((a) => a.tokens !== null);

  const perms = Object.values(exec.permissions).sort((a, b) => a.requestedSeq - b.requestedSeq);
  const waits = perms
    .filter((p) => p.status !== 'pending' && p.resolvedProvenance !== 'inferred' && p.resolvedAt !== null)
    .map((p) => ms(p.resolvedAt) - ms(p.requestedAt))
    .filter((d) => Number.isFinite(d) && d >= 0);

  const tasks = exec.taskOrder.map((id) => exec.tasks[id]).filter((t) => t !== undefined);

  return {
    runId: exec.runId,
    title: run.title,
    mode: run.mode,
    sourceKind: run.source?.kind ?? null,
    status: run.status,
    outcome: ended ? (run.status as RunOutcome) : null,
    ended,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: ended && Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start - run.pausedMs) : null,
    pausedMs: run.pausedMs,
    speed: run.mode === 'executed' ? run.speed : null,
    events: exec.lastSequence,
    calls,
    toolCalls: {
      total: calls.length,
      failed: calls.filter((c) => isFailed(c.status)).length,
      byCategory: countBy(calls, (c) => c.category),
      byTool: countBy(calls, (c) => c.tool),
    },
    failures: {
      total: exec.incidents.length,
      open: exec.incidents.filter((i) => i.resolvedSeq === null).length,
      items: exec.incidents.map((i) => ({ seq: i.seq, kind: i.kind, message: i.message, agentId: i.agentId, resolved: i.resolvedSeq !== null })),
    },
    files: { touched: [...files.values()].sort((a, b) => byText(a.path, b.path)), untargeted },
    tests,
    agents,
    tokens: reported.length ? reported.reduce((sum, a) => sum + a.tokens!, 0) : null,
    permissions: {
      requested: perms.length,
      approved: perms.filter((p) => p.status === 'approved').length,
      denied: perms.filter((p) => p.status === 'denied').length,
      pending: perms.filter((p) => p.status === 'pending').length,
      inferred: perms.filter((p) => p.resolvedProvenance === 'inferred').length,
      waitMs: waits.length ? waits.reduce((x, y) => x + y, 0) : null,
      items: perms.map((p) => ({ seq: p.requestedSeq, action: p.action, status: p.status, inferred: p.resolvedProvenance === 'inferred' })),
    },
    subagents: traced ? tasks.filter((t) => t.kind === 'delegated').length : null,
    turns: traced ? tasks.filter((t) => t.kind === 'turn').length : null,
    costUsd: typeof reports.costUsd === 'number' && Number.isFinite(reports.costUsd) && reports.costUsd >= 0 ? reports.costUsd : null,
  };
}

// ── diff ───────────────────────────────────────────────────────────────

/**
 * Why a difference is not comparable, or a caveat on it. Side-neutral codes
 * (`_a` = the first run passed to diffRuns, `_b` = the second); the UI words them.
 */
export type DiffNote =
  /** Neither side reported the value. */
  | 'not_reported'
  | 'not_reported_a'
  | 'not_reported_b'
  /** Still recording: the value is not final. */
  | 'running'
  | 'running_a'
  | 'running_b'
  /** Tokens: the two sides reported usage for different agents, so the totals cover different work. */
  | 'coverage_differs'
  /** One run was executed by Runloop, the other traced from a source: counts come from different instruments. */
  | 'mode_differs'
  /** Duration: the scripted demo ran at a different pace (speed) in each run, so its waits differ by design. */
  | 'pace_differs'
  /** Duration: the scripted demo's pace was not recorded for a run (older logs), so it may differ. */
  | 'pace_unknown';

/**
 * Why two reported, final values still support no verdict (a judgement
 * caveat; kept apart from DiffNote so consumers that word every DiffNote keep
 * working). A field with a caveat is not comparable.
 */
export type DiffCaveat =
  /** A run did not run to completion (stopped by the user, or interrupted by a restart): its time and counts cover less work. */
  | 'incomplete'
  | 'incomplete_a'
  | 'incomplete_b'
  /** One run failed and the other did not: time and counts are no verdict on either. */
  | 'outcome_differs'
  /** Tests: the latest test runs covered different numbers of tests, so their pass/fail counts and names do not line up. */
  | 'scope_differs';

export interface FieldDiff<T> {
  a: T | null;
  b: T | null;
  /** b − a for numbers when comparable; null otherwise. */
  delta: number | null;
  /** Both sides measured the value the same way, so the difference means something. */
  comparable: boolean;
  note: DiffNote | null;
  /** Set when both sides reported a final value that still supports no verdict (then not comparable). */
  caveat?: DiffCaveat;
}

export interface KeyedCountDiff {
  key: string;
  a: CountEntry | null;
  b: CountEntry | null;
  count: FieldDiff<number>;
}

export interface FileDiff {
  path: string;
  a: FileTouch | null;
  b: FileTouch | null;
}

/** A test name that changed state, with the test runs that show it on each side. */
export interface TestChange {
  name: string;
  /** Result sequence of the side's latest test run (null when that side had none). */
  aSeq: number | null;
  bSeq: number | null;
}

export interface AgentDiff {
  key: string;
  a: AgentDigest | null;
  b: AgentDigest | null;
  tokens: FieldDiff<number>;
  /** Both sides reported a model and it differs. */
  modelChanged: boolean;
}

/**
 * The first point where the two call sequences part: a different call
 * (category, tool or target), the same call with a different result (status,
 * test counts, or the failing test names when both named them all), or one
 * run making a call the other never made. A call still running in a run still
 * recording has no result yet, and a live run may still make more calls:
 * neither is a divergence (RunDiff.divergenceNote says the comparison is not final).
 */
export interface Divergence {
  index: number;
  kind: 'call' | 'result' | 'extra';
  a: DigestCall | null;
  b: DigestCall | null;
}

export interface RunDiff {
  a: RunDigest;
  b: RunDigest;
  sameRun: boolean;
  sameMode: boolean;
  outcome: FieldDiff<RunOutcome> & { changed: boolean };
  durationMs: FieldDiff<number>;
  events: FieldDiff<number>;
  toolCalls: FieldDiff<number>;
  failedCalls: FieldDiff<number>;
  failures: FieldDiff<number>;
  openFailures: FieldDiff<number>;
  tests: {
    passed: FieldDiff<number>;
    failed: FieldDiff<number>;
    total: FieldDiff<number>;
    runs: FieldDiff<number>;
    /** Failing in a's latest test run, not failing in b's (needs b's failing names in full). */
    fixed: TestChange[];
    /** Failing in b's latest test run, not in a's (needs a's names in full). */
    newlyFailing: TestChange[];
    stillFailing: TestChange[];
    /**
     * Names that failed in some test run of one side only (even if fixed later
     * in that run). Each links to the first test run where it failed. A name is
     * only claimed for one side when the other side named every failing test of
     * every test run (otherwise it may have failed there unnamed): `note` says
     * which side's names were incomplete.
     */
    failedAlongTheWay: { onlyA: TestChange[]; onlyB: TestChange[]; complete: boolean; note: DiffNote | null };
    /** Names are known in full on both sides, so fixed/newly failing are complete. */
    namesComparable: boolean;
    namesNote: DiffNote | null;
    /** The latest test runs covered a different number of tests: fixed/newly failing are not claimed (`scope_differs`). */
    namesCaveat: DiffCaveat | null;
    /**
     * A side is still recording: its latest test run may not be its last, so
     * the name lists are as of now; "failed along the way, one side only" is
     * not claimed for the other side until it ends.
     */
    pending: DiffNote | null;
  };
  tokens: FieldDiff<number>;
  agents: AgentDiff[];
  permissions: {
    requested: FieldDiff<number>;
    approved: FieldDiff<number>;
    denied: FieldDiff<number>;
    waitMs: FieldDiff<number>;
  };
  subagents: FieldDiff<number>;
  turns: FieldDiff<number>;
  categories: KeyedCountDiff[];
  tools: KeyedCountDiff[];
  files: {
    onlyA: FileTouch[];
    onlyB: FileTouch[];
    both: FileDiff[];
    /** Both sides named the file of every read/edit call. */
    comparable: boolean;
    note: DiffNote | null;
  };
  /** null when both runs made the same calls with the same results (so far: see divergenceNote). */
  firstDivergence: Divergence | null;
  /** A side is still recording, so the first divergence (or its absence) is not final yet. */
  divergenceNote: DiffNote | null;
  /** Cost as reported per run (Claude Code's result for dispatched runs); not reported is null, never 0. */
  costUsd: FieldDiff<number>;
}

const runningNote = ([ra, rb]: readonly [boolean, boolean]): DiffNote | null => (ra && rb ? 'running' : ra ? 'running_a' : rb ? 'running_b' : null);

/**
 * A numeric field: comparable when both are reported and final. A value a
 * run still recording has not reported yet is pending (`running_*`), not
 * missing: it may still come.
 */
function numberDiff(a: number | null, b: number | null, opts: { running?: [boolean, boolean]; modes?: boolean } = {}): FieldDiff<number> {
  const [ra, rb] = opts.running ?? [false, false];
  const running = runningNote([ra, rb]);
  const missing = missingNote(a, b);
  if (missing) {
    const pending = (a === null && ra) || (b === null && rb);
    return { a, b, delta: null, comparable: false, note: pending ? running : missing };
  }
  return { a, b, delta: b! - a!, comparable: running === null, note: running ?? (opts.modes ? 'mode_differs' : null) };
}

/** Withhold the verdict of a final, comparable field (the reason goes in `caveat`). */
function withCaveat(f: FieldDiff<number>, caveat: DiffCaveat | null): FieldDiff<number> {
  return caveat && f.comparable ? { ...f, delta: null, comparable: false, caveat } : f;
}

/** Did not run to completion: an executed run stopped by the user, or any run interrupted (a traced session's normal end is `stopped`). */
const incomplete = (d: RunDigest) => d.outcome === 'interrupted' || (d.mode === 'executed' && d.outcome === 'stopped');

/** Why time and counts of two ended runs support no verdict: one did not finish, or one failed and the other did not. */
function runCaveat(a: RunDigest, b: RunDigest): DiffCaveat | null {
  if (!a.ended || !b.ended) return null;
  const ia = incomplete(a);
  const ib = incomplete(b);
  if (ia || ib) return ia && ib ? 'incomplete' : ia ? 'incomplete_a' : 'incomplete_b';
  return (a.outcome === 'failed') !== (b.outcome === 'failed') ? 'outcome_differs' : null;
}

function missingNote(a: unknown, b: unknown): DiffNote | null {
  if (a === null && b === null) return 'not_reported';
  if (a === null) return 'not_reported_a';
  if (b === null) return 'not_reported_b';
  return null;
}

function keyedDiff(a: readonly CountEntry[], b: readonly CountEntry[], opts: { running: [boolean, boolean]; modes: boolean }): KeyedCountDiff[] {
  const keys = [...new Set([...a.map((r) => r.key), ...b.map((r) => r.key)])];
  const rows = keys.map((key) => {
    const x = a.find((r) => r.key === key) ?? null;
    const y = b.find((r) => r.key === key) ?? null;
    // A key missing on one side is a recorded count of 0 there, not a missing value.
    return { key, a: x, b: y, count: numberDiff(x?.count ?? 0, y?.count ?? 0, opts) };
  });
  return rows.sort((r, s) => Math.max(s.count.a!, s.count.b!) - Math.max(r.count.a!, r.count.b!) || byText(r.key, s.key));
}

/** Same category and tool, and the same target where both sides reported one (a missing target is unknown, not different). */
const sameCall = (x: DigestCall, y: DigestCall) =>
  x.category === y.category && x.tool === y.tool && (x.target === null || y.target === null || x.target === y.target);
const sameMetrics = (x: TestMetrics | null, y: TestMetrics | null) =>
  x === y || (x !== null && y !== null && x.tests === y.tests && x.passed === y.passed && x.failed === y.failed);
/** Names count only when both calls named every failure; then a different set is a different result. */
const namedAll = (c: DigestCall) => c.metrics !== null && c.failingTests.length >= c.metrics.failed;
const sameFailing = (x: DigestCall, y: DigestCall) =>
  !namedAll(x) || !namedAll(y) || (x.failingTests.length === y.failingTests.length && x.failingTests.every((n) => y.failingTests.includes(n)));

function divergence(a: readonly DigestCall[], b: readonly DigestCall[], running: [boolean, boolean]): { first: Divergence | null; note: DiffNote | null } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!sameCall(x, y)) return { first: { index: i, kind: 'call', a: x, b: y }, note: null };
    // A call of a live run with no result yet: nothing can be said about it, or past it.
    const pending: [boolean, boolean] = [running[0] && x.status === 'running', running[1] && y.status === 'running'];
    if (pending[0] || pending[1]) return { first: null, note: runningNote(pending) };
    if (x.status !== y.status || !sameMetrics(x.metrics, y.metrics) || !sameFailing(x, y)) return { first: { index: i, kind: 'result', a: x, b: y }, note: null };
  }
  // Same so far. One side making more calls is a divergence only once the shorter side has ended.
  if (a.length === b.length) return { first: null, note: runningNote(running) };
  const shorterIsA = a.length < b.length;
  if (shorterIsA ? running[0] : running[1]) return { first: null, note: shorterIsA ? 'running_a' : 'running_b' };
  return { first: { index: n, kind: 'extra', a: a[n] ?? null, b: b[n] ?? null }, note: null };
}

function testDiff(a: RunDigest, b: RunDigest, running: [boolean, boolean], runCaveat: DiffCaveat | null): RunDiff['tests'] {
  const ta = a.tests;
  const tb = b.tests;
  // A run that did not finish may not have reached its last test run; a failed run's tests still say what they say.
  const caveat = runCaveat === 'outcome_differs' ? null : runCaveat;
  // Pass/fail counts and names line up only when both latest test runs covered as many tests.
  const scope: DiffCaveat | null = ta && tb && ta.latest.tests !== tb.latest.tests ? 'scope_differs' : null;
  const field = (pick: (t: TestRunDigest) => number, c: DiffCaveat | null) => withCaveat(numberDiff(ta ? pick(ta.latest) : null, tb ? pick(tb.latest) : null, { running }), c);
  const aSeq = ta?.latest.seq ?? null;
  const bSeq = tb?.latest.seq ?? null;
  const change = (name: string): TestChange => ({ name, aSeq, bSeq });
  const namesA = ta?.failingNow ?? null;
  const namesB = tb?.failingNow ?? null;
  const completeA = ta !== null && namesA !== null && ta.failingNowComplete;
  const completeB = tb !== null && namesB !== null && tb.failingNowComplete;
  const alongA = ta?.failedAlongTheWay ?? [];
  const alongB = tb?.failedAlongTheWay ?? [];
  // A side without test runs failed nothing, so its (empty) list is complete; a side still recording may fail more.
  const alongCompleteA = (ta?.failedAlongTheWayComplete ?? true) && !running[0];
  const alongCompleteB = (tb?.failedAlongTheWayComplete ?? true) && !running[1];
  const firstFailing = (t: RunDigest['tests'], name: string) => t?.runs.find((r) => r.failingTests.includes(name))?.seq ?? null;
  // A side whose test runs left a failure unnamed (a live side is `pending`, not "not reported").
  const unnamedA = !(ta?.failedAlongTheWayComplete ?? true) && !running[0];
  const unnamedB = !(tb?.failedAlongTheWayComplete ?? true) && !running[1];
  return {
    passed: field((t) => t.passed, scope ?? caveat),
    failed: field((t) => t.failed, scope ?? caveat),
    total: field((t) => t.tests, caveat),
    // Counts of recorded test runs: 0 is real on a side with no counts at all.
    runs: withCaveat(numberDiff(ta?.runs.length ?? 0, tb?.runs.length ?? 0, { running }), caveat),
    fixed: namesA && completeB && !scope ? namesA.filter((n) => !namesB!.includes(n)).map(change) : [],
    newlyFailing: namesB && completeA && !scope ? namesB.filter((n) => !namesA!.includes(n)).map(change) : [],
    stillFailing: namesA && namesB ? namesA.filter((n) => namesB.includes(n)).map(change) : [],
    failedAlongTheWay: {
      onlyA: alongCompleteB ? alongA.filter((n) => !alongB.includes(n)).map((name) => ({ name, aSeq: firstFailing(ta, name), bSeq: null })) : [],
      onlyB: alongCompleteA ? alongB.filter((n) => !alongA.includes(n)).map((name) => ({ name, aSeq: null, bSeq: firstFailing(tb, name) })) : [],
      complete: alongCompleteA && alongCompleteB,
      note: unnamedA && unnamedB ? 'not_reported' : unnamedA ? 'not_reported_a' : unnamedB ? 'not_reported_b' : null,
    },
    namesComparable: completeA && completeB && !scope,
    namesNote: !ta && !tb ? 'not_reported' : !completeA ? 'not_reported_a' : !completeB ? 'not_reported_b' : null,
    namesCaveat: scope,
    pending: runningNote(running),
  };
}

function agentDiffs(a: RunDigest, b: RunDigest): AgentDiff[] {
  const keys = [...new Set([...a.agents.map((x) => x.key), ...b.agents.map((x) => x.key)])];
  return keys.map((key) => {
    const x = a.agents.find((g) => g.key === key) ?? null;
    const y = b.agents.find((g) => g.key === key) ?? null;
    return {
      key,
      a: x,
      b: y,
      tokens: numberDiff(x?.tokens ?? null, y?.tokens ?? null),
      modelChanged: x?.model != null && y?.model != null && x.model !== y.model,
    };
  });
}

/** Everything that differs between run `a` (e.g. the baseline) and run `b` (the candidate). */
export function diffRuns(a: RunDigest, b: RunDigest): RunDiff {
  const running: [boolean, boolean] = [!a.ended, !b.ended];
  const modes = a.mode !== b.mode;
  const counts = { running, modes };

  // Outcome: only final outcomes compare.
  const outcomeMissing: DiffNote | null =
    !a.ended && !b.ended ? 'running' : !a.ended ? 'running_a' : !b.ended ? 'running_b' : modes ? 'mode_differs' : null;

  // Tokens: totals only compare when the same agents reported usage on both sides.
  const reportedA = a.agents.filter((g) => g.tokens !== null).map((g) => g.key).sort();
  const reportedB = b.agents.filter((g) => g.tokens !== null).map((g) => g.key).sort();
  const sameCoverage = reportedA.length === reportedB.length && reportedA.every((k, i) => k === reportedB[i]);
  const tokenDiff = numberDiff(a.tokens, b.tokens, { running });
  const tokens: FieldDiff<number> = tokenDiff.comparable && !sameCoverage ? { ...tokenDiff, delta: null, comparable: false, note: 'coverage_differs' } : tokenDiff;

  // Files: by path; incomplete when a read/edit call did not name its file.
  const pathsB = new Map(b.files.touched.map((f) => [f.path, f]));
  const pathsA = new Map(a.files.touched.map((f) => [f.path, f]));
  const filesNote = missingFiles(a, b);
  // Time and counts of a run that did not finish, or of a failed run against one that did not fail, are no verdict.
  const caveat = runCaveat(a, b);
  const judged = (x: number | null, y: number | null) => withCaveat(numberDiff(x, y, counts), caveat);
  const div = divergence(a.calls, b.calls, running);

  return {
    a,
    b,
    sameRun: a.runId !== null && a.runId === b.runId,
    sameMode: !modes,
    outcome: {
      a: a.outcome,
      b: b.outcome,
      delta: null,
      comparable: a.ended && b.ended,
      note: outcomeMissing,
      changed: a.ended && b.ended && a.outcome !== b.outcome,
    },
    durationMs: withCaveat(durationDiff(a, b, running), caveat),
    events: judged(a.events, b.events),
    toolCalls: judged(a.toolCalls.total, b.toolCalls.total),
    failedCalls: judged(a.toolCalls.failed, b.toolCalls.failed),
    failures: judged(a.failures.total, b.failures.total),
    openFailures: judged(a.failures.open, b.failures.open),
    tests: testDiff(a, b, running, caveat),
    tokens,
    agents: agentDiffs(a, b),
    permissions: {
      requested: numberDiff(a.permissions.requested, b.permissions.requested, counts),
      approved: numberDiff(a.permissions.approved, b.permissions.approved, counts),
      denied: numberDiff(a.permissions.denied, b.permissions.denied, counts),
      waitMs: numberDiff(a.permissions.waitMs, b.permissions.waitMs, { running }),
    },
    subagents: numberDiff(a.subagents, b.subagents, { running }),
    turns: numberDiff(a.turns, b.turns, { running }),
    categories: keyedDiff(a.toolCalls.byCategory, b.toolCalls.byCategory, counts),
    tools: keyedDiff(a.toolCalls.byTool, b.toolCalls.byTool, counts),
    files: {
      onlyA: a.files.touched.filter((f) => !pathsB.has(f.path)),
      onlyB: b.files.touched.filter((f) => !pathsA.has(f.path)),
      both: a.files.touched.filter((f) => pathsB.has(f.path)).map((f) => ({ path: f.path, a: f, b: pathsB.get(f.path)! })),
      comparable: filesNote === null,
      note: filesNote,
    },
    firstDivergence: div.first,
    divergenceNote: div.note,
    costUsd: withCaveat(numberDiff(a.costUsd, b.costUsd, { running }), caveat),
  };
}

/**
 * Duration (recorded pauses left out), with the scripted demo's pacing: two
 * executed runs at different speeds are not comparable (their waits are
 * scaled on purpose); when a speed was not recorded the difference stands
 * with a caveat. An executed run against a traced one is not comparable
 * either: the demo's time is paced by design (or not real time at speed 0),
 * a traced session's is real.
 */
function durationDiff(a: RunDigest, b: RunDigest, running: [boolean, boolean]): FieldDiff<number> {
  const d = numberDiff(a.durationMs, b.durationMs, { running });
  if (!d.comparable) return d;
  if (a.mode !== b.mode) return { ...d, delta: null, comparable: false, note: 'mode_differs' };
  if (a.mode !== 'executed') return d;
  if (a.speed !== null && b.speed !== null) return a.speed === b.speed ? d : { ...d, delta: null, comparable: false, note: 'pace_differs' };
  return { ...d, note: 'pace_unknown' };
}

function missingFiles(a: RunDigest, b: RunDigest): DiffNote | null {
  const ua = a.files.untargeted > 0;
  const ub = b.files.untargeted > 0;
  if (ua && ub) return 'not_reported';
  if (ua) return 'not_reported_a';
  if (ub) return 'not_reported_b';
  if (!a.ended || !b.ended) return !a.ended && !b.ended ? 'running' : !a.ended ? 'running_a' : 'running_b';
  return null;
}
