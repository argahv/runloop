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
  /** Start to end; null until the run has ended (or when a time is missing). */
  durationMs: number | null;
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

/** What compare needs from one run, from its folded execution state. */
export function summarizeRun(exec: ExecState): RunDigest {
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
    durationMs: ended && Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
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

export interface FieldDiff<T> {
  a: T | null;
  b: T | null;
  /** b − a for numbers when comparable; null otherwise. */
  delta: number | null;
  /** Both sides measured the value the same way, so the difference means something. */
  comparable: boolean;
  note: DiffNote | null;
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
 * (category, tool or target), the same call with a different result, or one
 * run making a call the other never made.
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
  /** null when both runs made the same calls with the same results. */
  firstDivergence: Divergence | null;
}

/** A numeric field: comparable when both are reported (and final, when `final` says so). */
function numberDiff(a: number | null, b: number | null, opts: { running?: [boolean, boolean]; modes?: boolean } = {}): FieldDiff<number> {
  const missing = missingNote(a, b);
  if (missing) return { a, b, delta: null, comparable: false, note: missing };
  const [ra, rb] = opts.running ?? [false, false];
  const running: DiffNote | null = ra && rb ? 'running' : ra ? 'running_a' : rb ? 'running_b' : null;
  return { a, b, delta: b! - a!, comparable: running === null, note: running ?? (opts.modes ? 'mode_differs' : null) };
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

function divergence(a: readonly DigestCall[], b: readonly DigestCall[]): Divergence | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!sameCall(x, y)) return { index: i, kind: 'call', a: x, b: y };
    if (x.status !== y.status || !sameMetrics(x.metrics, y.metrics)) return { index: i, kind: 'result', a: x, b: y };
  }
  if (a.length === b.length) return null;
  return { index: n, kind: 'extra', a: a[n] ?? null, b: b[n] ?? null };
}

function testDiff(a: RunDigest, b: RunDigest, running: [boolean, boolean]): RunDiff['tests'] {
  const ta = a.tests;
  const tb = b.tests;
  const field = (pick: (t: TestRunDigest) => number) => numberDiff(ta ? pick(ta.latest) : null, tb ? pick(tb.latest) : null, { running });
  const aSeq = ta?.latest.seq ?? null;
  const bSeq = tb?.latest.seq ?? null;
  const change = (name: string): TestChange => ({ name, aSeq, bSeq });
  const namesA = ta?.failingNow ?? null;
  const namesB = tb?.failingNow ?? null;
  const completeA = ta !== null && namesA !== null && ta.failingNowComplete;
  const completeB = tb !== null && namesB !== null && tb.failingNowComplete;
  const alongA = ta?.failedAlongTheWay ?? [];
  const alongB = tb?.failedAlongTheWay ?? [];
  // A side without test runs failed nothing, so its (empty) list is complete.
  const alongCompleteA = ta?.failedAlongTheWayComplete ?? true;
  const alongCompleteB = tb?.failedAlongTheWayComplete ?? true;
  const firstFailing = (t: RunDigest['tests'], name: string) => t?.runs.find((r) => r.failingTests.includes(name))?.seq ?? null;
  return {
    passed: field((t) => t.passed),
    failed: field((t) => t.failed),
    total: field((t) => t.tests),
    // Counts of recorded test runs: 0 is real on a side with no counts at all.
    runs: numberDiff(ta?.runs.length ?? 0, tb?.runs.length ?? 0, { running }),
    fixed: namesA && completeB ? namesA.filter((n) => !namesB!.includes(n)).map(change) : [],
    newlyFailing: namesB && completeA ? namesB.filter((n) => !namesA!.includes(n)).map(change) : [],
    stillFailing: namesA && namesB ? namesA.filter((n) => namesB.includes(n)).map(change) : [],
    failedAlongTheWay: {
      onlyA: alongCompleteB ? alongA.filter((n) => !alongB.includes(n)).map((name) => ({ name, aSeq: firstFailing(ta, name), bSeq: null })) : [],
      onlyB: alongCompleteA ? alongB.filter((n) => !alongA.includes(n)).map((name) => ({ name, aSeq: null, bSeq: firstFailing(tb, name) })) : [],
      complete: alongCompleteA && alongCompleteB,
      note: !alongCompleteA && !alongCompleteB ? 'not_reported' : !alongCompleteA ? 'not_reported_a' : !alongCompleteB ? 'not_reported_b' : null,
    },
    namesComparable: completeA && completeB,
    namesNote: !ta && !tb ? 'not_reported' : !completeA ? 'not_reported_a' : !completeB ? 'not_reported_b' : null,
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
    durationMs: durationDiff(a, b, running),
    events: numberDiff(a.events, b.events, counts),
    toolCalls: numberDiff(a.toolCalls.total, b.toolCalls.total, counts),
    failedCalls: numberDiff(a.toolCalls.failed, b.toolCalls.failed, counts),
    failures: numberDiff(a.failures.total, b.failures.total, counts),
    openFailures: numberDiff(a.failures.open, b.failures.open, counts),
    tests: testDiff(a, b, running),
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
    firstDivergence: divergence(a.calls, b.calls),
  };
}

/**
 * Duration, with the scripted demo's pacing: two executed runs at different
 * speeds are not comparable (their waits are scaled on purpose); when a speed
 * was not recorded the difference stands with a caveat.
 */
function durationDiff(a: RunDigest, b: RunDigest, running: [boolean, boolean]): FieldDiff<number> {
  const d = numberDiff(a.durationMs, b.durationMs, { running });
  if (!d.comparable || a.mode !== 'executed' || b.mode !== 'executed') return d;
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
