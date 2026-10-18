import type { TestMetrics, ToolCategory } from '@runloop-world/events';
import { CODING_MISSION, codingMissionFixture, runBuilder } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { diffRuns, summarizeRun, type RunDigest } from './compare';
import { foldExecution } from './reduce-execution';

// ── a small traced-run builder ─────────────────────────────────────────

interface CallSpec {
  tool: string;
  category?: ToolCategory;
  target?: string;
  status?: 'success' | 'error' | 'denied';
  metrics?: TestMetrics;
  failingTests?: string[];
  agentId?: string;
}

interface TracedSpec {
  calls?: CallSpec[];
  /** Subagents (name, model, tokens) registered with a usage report; tokens null = no report. */
  subagents?: { name: string; model?: string | null; tokens: number | null }[];
  mainModel?: string | null;
  /** Permission waits: ms until the answer, or 'inferred' for a denial Runloop reconstructed. */
  permissions?: (number | 'inferred')[];
  ended?: boolean;
  ns?: number;
}

function traced(spec: TracedSpec = {}): RunDigest {
  const b = runBuilder({ namespace: spec.ns ?? 0xc1, startIso: '2026-10-18T10:00:00.000Z' });
  const rep = { provenance: 'reported' as const };
  b.add(
    'run.started',
    {
      title: 'Claude Code · demo',
      missionId: 'claude-code',
      worldId: 'research-campus',
      adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code' },
      mode: 'traced',
      source: { kind: 'claude-code', sessionId: `s-${spec.ns ?? 0xc1}`, segment: 1, projectLabel: 'demo' },
    },
    rep,
  );
  b.add('agent.registered', { agentId: 'user', name: 'You', role: 'user', model: null, tools: [], embodied: false }, rep);
  b.add('agent.registered', { agentId: 'main', name: 'Claude', role: 'main agent', model: spec.mainModel ?? null, tools: [], embodied: true }, rep);
  b.add('task.created', { taskId: 'turn-1', title: 'Turn 1', kind: 'turn', dependsOn: [] }, rep);
  b.add('task.started', { taskId: 'turn-1', agentId: 'main' }, rep);
  (spec.subagents ?? []).forEach((s, i) => {
    const id = `sa-${i + 1}`;
    b.wait(100).add('agent.registered', { agentId: id, name: s.name, role: 'Explore', model: null, tools: [], embodied: true }, rep);
    b.add('task.created', { taskId: `delegate-${i + 1}`, title: s.name, kind: 'delegated', dependsOn: [] }, rep);
    if (s.tokens !== null) {
      b.add('agent.usage_reported', { agentId: id, model: s.model ?? null, inputTokens: s.tokens, outputTokens: 0, totalTokens: s.tokens, source: 'claude-code.agent_result' }, rep);
    }
  });
  (spec.calls ?? []).forEach((c, i) => {
    const callId = `call-${i + 1}`;
    const started = b.wait(1000).add(
      'tool.call_started',
      {
        callId,
        agentId: c.agentId ?? 'main',
        taskId: 'turn-1',
        tool: c.tool,
        ...(c.category ? { category: c.category } : {}),
        inputSummary: c.target ?? '',
        ...(c.target ? { target: c.target } : {}),
      },
      rep,
    );
    if (c.status === 'denied') {
      b.wait(500).add('tool.call_failed', { callId, errorType: 'denied', message: 'denied', durationMs: 500 }, { ...rep, parentEventId: started.eventId });
      return;
    }
    b.wait(500).add(
      'tool.call_completed',
      {
        callId,
        status: c.status ?? 'success',
        durationMs: 500,
        outputSummary: '',
        ...(c.metrics ? { metrics: c.metrics } : {}),
        ...(c.failingTests ? { failingTests: c.failingTests } : {}),
      },
      { ...rep, parentEventId: started.eventId },
    );
  });
  (spec.permissions ?? []).forEach((wait, i) => {
    const permissionId = `perm-${i + 1}`;
    b.wait(100).add('tool.permission_requested', { permissionId, agentId: 'main', action: 'Bash git push', scope: 'default' }, rep);
    if (wait === 'inferred') b.wait(9000).add('tool.permission_resolved', { permissionId, decision: 'denied', by: 'unknown' }, { provenance: 'inferred' });
    else b.wait(wait).add('tool.permission_resolved', { permissionId, decision: 'approved', by: 'user' }, rep);
  });
  if (spec.ended !== false) b.wait(1000).add('run.completed', { outcome: 'stopped', summary: 'Session ended' }, rep);
  return summarizeRun(foldExecution(b.events));
}

const T12 = (failed: number): TestMetrics => ({ tests: 12, passed: 12 - failed, failed });

// ── summarizeRun ───────────────────────────────────────────────────────

describe('summarizeRun — the executed coding mission', () => {
  const events = codingMissionFixture();
  const d = summarizeRun(foldExecution(events));

  it('reads the outcome, duration and call counts from the log', () => {
    expect(d).toMatchObject({ mode: 'executed', sourceKind: null, status: 'succeeded', outcome: 'succeeded', ended: true, events: events.length });
    expect(d.durationMs).toBe(Date.parse(events.at(-1)!.timestamp) - Date.parse(events[0]!.timestamp));
    expect(d.toolCalls).toMatchObject({ total: 9, failed: 1 });
  });

  it("categorises Runloop's own tools (a run_command with test counts is a test run)", () => {
    expect(d.calls.map((c) => [c.tool, c.category, c.categorySource])).toEqual([
      ['list_files', 'search', 'runtime_tool'],
      ['read_file', 'read', 'runtime_tool'],
      ['read_file', 'read', 'runtime_tool'],
      ['read_file', 'read', 'runtime_tool'],
      ['write_file', 'edit', 'runtime_tool'],
      ['run_command', 'test', 'runtime_tool'],
      ['read_file', 'read', 'runtime_tool'],
      ['write_file', 'edit', 'runtime_tool'],
      ['run_command', 'test', 'runtime_tool'],
    ]);
    expect(d.toolCalls.byCategory.map((r) => [r.key, r.count, r.failed])).toEqual([
      ['read', 4, 0],
      ['edit', 2, 0],
      ['test', 2, 1],
      ['search', 1, 0],
    ]);
  });

  it('lists the files read and written from call targets', () => {
    expect(d.files.untargeted).toBe(0);
    expect(d.files.touched.map((f) => [f.path, f.reads, f.writes])).toEqual([
      ['README.md', 1, 0],
      ['src/task-store.js', 2, 2],
      ['test/task-store.test.js', 1, 0],
    ]);
    const store = d.files.touched.find((f) => f.path === 'src/task-store.js')!;
    expect(events[store.firstWriteSeq! - 1]).toMatchObject({ type: 'tool.call_started', payload: { tool: 'write_file' } });
  });

  it('keeps every test run: first failing, latest passing, and the names that failed along the way', () => {
    expect(d.tests).toMatchObject({ first: T12(2), latest: T12(0), failingNow: [], failingNowComplete: true });
    expect(d.tests!.runs).toHaveLength(2);
    expect(d.tests!.failedAlongTheWay).toEqual([...CODING_MISSION.failingTests]);
    expect(events[d.tests!.latest.seq - 1]).toMatchObject({ type: 'tool.call_completed', payload: { metrics: T12(0) } });
  });

  it('reports no tokens, no turns and no subagents rather than zero', () => {
    expect(d.tokens).toBeNull();
    expect(d.agents.map((a) => [a.key, a.tokens, a.model])).toEqual([
      ['Coordinator', null, null],
      ['Researcher', null, null],
      ['Builder', null, null],
      ['Tester', null, null],
    ]);
    expect(d.turns).toBeNull();
    expect(d.subagents).toBeNull();
    expect(d.permissions).toMatchObject({ requested: 0, waitMs: null });
    expect(d.failures).toMatchObject({ total: 1, open: 0 });
  });
});

describe('summarizeRun — traced runs', () => {
  it('counts turns and subagents and sums only the usage that was reported', () => {
    const d = traced({ subagents: [{ name: 'Explore #1', model: 'claude-haiku', tokens: 1200 }, { name: 'Plan #1', tokens: null }] });
    expect(d).toMatchObject({ mode: 'traced', sourceKind: 'claude-code', outcome: 'stopped', turns: 1, subagents: 2, tokens: 1200 });
    expect(d.agents.map((a) => [a.key, a.tokens, a.model])).toEqual([
      ['Claude', null, null],
      ['Explore #1', 1200, 'claude-haiku'],
      ['Plan #1', null, null],
    ]);
    expect(d.agents.find((a) => a.key === 'Explore #1')!.usageSeq).toEqual(expect.any(Number));
  });

  it('a run with no usage reports has tokens null, not 0', () => {
    expect(traced().tokens).toBeNull();
  });

  it('makes agent keys unique when names repeat', () => {
    const d = traced({ subagents: [{ name: 'Explore', tokens: 10 }, { name: 'Explore', tokens: 20 }] });
    expect(d.agents.map((a) => a.key)).toEqual(['Claude', 'Explore', 'Explore (2)']);
  });

  it('counts read/edit calls without a target (older logs) instead of inventing files', () => {
    const d = traced({
      calls: [
        { tool: 'Read', category: 'read', target: 'src/a.ts' },
        { tool: 'Read', category: 'read' },
        { tool: 'Edit', category: 'edit', target: 'src/a.ts' },
        { tool: 'Grep', category: 'search', target: 'src' },
        { tool: 'Bash', category: 'execute', target: 'ls' },
      ],
    });
    expect(d.files).toEqual({ touched: [expect.objectContaining({ path: 'src/a.ts', reads: 1, writes: 1, failed: 0 })], untargeted: 1 });
  });

  it('keeps a file whose read failed, and says so (the agent tried to touch it)', () => {
    const d = traced({ calls: [{ tool: 'Read', category: 'read', target: 'NOTES.md', status: 'error' }, { tool: 'Edit', category: 'edit', target: 'a.js', status: 'denied' }] });
    expect(d.files.touched.map((f) => [f.path, f.reads, f.writes, f.failed])).toEqual([
      ['NOTES.md', 1, 0, 1],
      ['a.js', 0, 1, 1],
    ]);
  });

  it('failing test names: null when the runner gave counts without names, incomplete when cut short', () => {
    const noNames = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(2) }] });
    expect(noNames.tests).toMatchObject({ failingNow: null, failingNowComplete: false });
    const partial = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(3), failingTests: ['a', 'b'] }] });
    expect(partial.tests).toMatchObject({ failingNow: ['a', 'b'], failingNowComplete: false });
    expect(traced({ calls: [{ tool: 'Bash', category: 'execute' }] }).tests).toBeNull();
  });

  it('times only permission answers with a recorded time (inferred denials have none)', () => {
    const d = traced({ permissions: [3000, 'inferred', 1500] });
    expect(d.permissions).toMatchObject({ requested: 3, approved: 2, denied: 1, pending: 0, inferred: 1, waitMs: 4500 });
    expect(d.permissions.items.map((p) => [p.status, p.inferred])).toEqual([
      ['approved', false],
      ['denied', true],
      ['approved', false],
    ]);
    expect(traced({ permissions: ['inferred'] }).permissions.waitMs).toBeNull();
  });

  it('a run still recording has no outcome and no duration yet', () => {
    const d = traced({ ended: false, calls: [{ tool: 'Read', category: 'read', target: 'a' }] });
    expect(d).toMatchObject({ ended: false, outcome: null, durationMs: null, status: 'running' });
  });

  it('a traced call without a category stays uncategorised (no tool table for external sources)', () => {
    const d = traced({ calls: [{ tool: 'read_file', target: 'x' }] });
    expect(d.calls[0]).toMatchObject({ category: 'uncategorised', categorySource: null });
  });
});

// ── diffRuns ───────────────────────────────────────────────────────────

const basic: CallSpec[] = [
  { tool: 'Bash', category: 'test', target: 'node', status: 'error', metrics: T12(2), failingTests: ['x', 'y'] },
  { tool: 'Read', category: 'read', target: 'src/store.js' },
  { tool: 'Edit', category: 'edit', target: 'src/store.js' },
  { tool: 'Bash', category: 'test', target: 'node', metrics: T12(0) },
];

describe('diffRuns', () => {
  it('two identical runs: no divergence, every count comparable with a zero delta', () => {
    const a = traced({ calls: basic, ns: 0xa1 });
    const b = traced({ calls: basic, ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.firstDivergence).toBeNull();
    expect(d).toMatchObject({ sameMode: true, sameRun: false, outcome: { a: 'stopped', b: 'stopped', changed: false, comparable: true, note: null } });
    for (const f of [d.durationMs, d.toolCalls, d.failedCalls, d.failures, d.events, d.tests.passed, d.tests.runs]) {
      expect(f).toMatchObject({ delta: 0, comparable: true, note: null });
    }
    expect(d.files).toMatchObject({ onlyA: [], onlyB: [], comparable: true, note: null });
    expect(d.files.both.map((f) => f.path)).toEqual(['src/store.js']);
    expect(d.categories.map((r) => [r.key, r.count.a, r.count.b, r.count.delta])).toEqual([
      ['test', 2, 2, 0],
      ['edit', 1, 1, 0],
      ['read', 1, 1, 0],
    ]);
  });

  it('the same run on both sides is flagged', () => {
    const a = traced();
    expect(diffRuns(a, a).sameRun).toBe(true);
  });

  it('first divergence: the same call with a different result', () => {
    const a = traced({ calls: basic, ns: 0xa1 });
    const b = traced({ calls: [{ ...basic[0]!, status: 'success', metrics: T12(0), failingTests: [] }, ...basic.slice(1)], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.firstDivergence).toMatchObject({ index: 0, kind: 'result', a: { tool: 'Bash', status: 'error' }, b: { tool: 'Bash', status: 'success' } });
    expect(d.firstDivergence!.a!.seq).toBe(a.calls[0]!.seq);
  });

  it('first divergence: a different call (a different file is a different call)', () => {
    const a = traced({ calls: basic, ns: 0xa1 });
    const b = traced({ calls: [basic[0]!, { tool: 'Read', category: 'read', target: 'README.md' }, ...basic.slice(2)], ns: 0xb1 });
    expect(diffRuns(a, b).firstDivergence).toMatchObject({ index: 1, kind: 'call', a: { target: 'src/store.js' }, b: { target: 'README.md' } });
  });

  it('first divergence: a target one side did not report is unknown, not different', () => {
    // A log recorded before targets existed against a newer one of the same work.
    const old = traced({ calls: basic.map(({ target: _target, ...c }) => c), ns: 0xa1 });
    const now = traced({ calls: basic, ns: 0xb1 });
    expect(old.calls.every((c) => c.target === null)).toBe(true);
    expect(diffRuns(old, now).firstDivergence).toBeNull();
    expect(diffRuns(now, old).firstDivergence).toBeNull();
    // The files are still flagged as incomplete for the old side.
    expect(diffRuns(old, now).files).toMatchObject({ comparable: false, note: 'not_reported_a' });
  });

  it('first divergence: one run makes a call the other never made', () => {
    const a = traced({ calls: basic.slice(0, 2), ns: 0xa1 });
    const b = traced({ calls: basic, ns: 0xb1 });
    expect(diffRuns(a, b).firstDivergence).toMatchObject({ index: 2, kind: 'extra', a: null, b: { tool: 'Edit' } });
    expect(diffRuns(b, a).firstDivergence).toMatchObject({ index: 2, kind: 'extra', a: { tool: 'Edit' }, b: null });
  });

  it('files only in A, only in B and in both', () => {
    const a = traced({ calls: [{ tool: 'Read', category: 'read', target: 'a.js' }, { tool: 'Edit', category: 'edit', target: 'shared.js' }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Read', category: 'read', target: 'shared.js' }, { tool: 'Write', category: 'edit', target: 'b.js' }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.files.onlyA.map((f) => f.path)).toEqual(['a.js']);
    expect(d.files.onlyB.map((f) => [f.path, f.writes])).toEqual([['b.js', 1]]);
    expect(d.files.both).toEqual([{ path: 'shared.js', a: expect.objectContaining({ writes: 1, reads: 0 }), b: expect.objectContaining({ writes: 0, reads: 1 }) }]);
  });

  it('files are not comparable when a side has read/edit calls without targets', () => {
    const a = traced({ calls: [{ tool: 'Read', category: 'read' }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Read', category: 'read', target: 'x' }], ns: 0xb1 });
    expect(diffRuns(a, b).files).toMatchObject({ comparable: false, note: 'not_reported_a' });
    expect(diffRuns(b, a).files).toMatchObject({ comparable: false, note: 'not_reported_b' });
    expect(diffRuns(a, a).files).toMatchObject({ comparable: false, note: 'not_reported' });
  });

  it('tests: fixed, newly failing and still failing from the latest runs', () => {
    const a = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(2), failingTests: ['x', 'y'] }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(2), failingTests: ['y', 'z'] }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.tests.fixed.map((t) => t.name)).toEqual(['x']);
    expect(d.tests.newlyFailing.map((t) => t.name)).toEqual(['z']);
    expect(d.tests.stillFailing.map((t) => t.name)).toEqual(['y']);
    expect(d.tests.fixed[0]).toEqual({ name: 'x', aSeq: a.tests!.latest.seq, bSeq: b.tests!.latest.seq });
    expect(d.tests).toMatchObject({ namesComparable: true, namesNote: null, failed: { a: 2, b: 2, delta: 0 } });
  });

  it('tests: names that failed along the way on one side only, linked to their first failing run', () => {
    const exec = summarizeRun(foldExecution(codingMissionFixture()));
    const firstPass = traced({ calls: [{ tool: 'Bash', category: 'test', metrics: T12(0) }], ns: 0xb1 });
    const d = diffRuns(exec, firstPass);
    expect(d.tests.failedAlongTheWay.onlyA).toEqual(CODING_MISSION.failingTests.map((name) => ({ name, aSeq: exec.tests!.first.seq, bSeq: null })));
    expect(d.tests.failedAlongTheWay.onlyB).toEqual([]);
    expect(diffRuns(exec, exec).tests.failedAlongTheWay).toEqual({ onlyA: [], onlyB: [], complete: true, note: null });
    // Both final runs pass, so nothing is fixed or newly failing at the end.
    expect(d.tests).toMatchObject({ fixed: [], newlyFailing: [], stillFailing: [], namesComparable: true });
  });

  it('tests: never claims "failed only in one run" when the other run left a failure unnamed', () => {
    // Like the real B6 sessions: the baseline piped `node --test | tail`, so its
    // first run named 1 of its 2 failures; the candidate named both.
    const a = traced({
      calls: [
        { tool: 'Bash', category: 'test', metrics: T12(2), failingTests: ['y'] },
        { tool: 'Bash', category: 'test', metrics: T12(0) },
      ],
      ns: 0xa1,
    });
    const b = traced({
      calls: [
        { tool: 'Bash', category: 'test', status: 'error', metrics: T12(2), failingTests: ['x', 'y'] },
        { tool: 'Bash', category: 'test', metrics: T12(0) },
      ],
      ns: 0xb1,
    });
    expect(a.tests).toMatchObject({ failedAlongTheWay: ['y'], failedAlongTheWayComplete: false });
    expect(b.tests).toMatchObject({ failedAlongTheWay: ['x', 'y'], failedAlongTheWayComplete: true });
    const d = diffRuns(a, b);
    // 'x' may be the baseline's unnamed failure, so it is not "candidate only".
    expect(d.tests.failedAlongTheWay).toEqual({ onlyA: [], onlyB: [], complete: false, note: 'not_reported_a' });
    // Swapped, the same: 'x' is not claimed as baseline-only either.
    expect(diffRuns(b, a).tests.failedAlongTheWay).toEqual({ onlyA: [], onlyB: [], complete: false, note: 'not_reported_b' });
    // With the baseline's names complete, the claim is made.
    const aFull = traced({ calls: [{ tool: 'Bash', category: 'test', metrics: T12(1), failingTests: ['y'] }, { tool: 'Bash', category: 'test', metrics: T12(0) }], ns: 0xa2 });
    expect(diffRuns(aFull, b).tests.failedAlongTheWay).toMatchObject({ onlyB: [{ name: 'x', aSeq: null, bSeq: b.tests!.first.seq }], complete: true, note: null });
  });

  it('tests: a passing latest run fixes every failing name', () => {
    const a = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(2), failingTests: ['x', 'y'] }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Bash', category: 'test', metrics: T12(0) }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.tests.fixed.map((t) => t.name)).toEqual(['x', 'y']);
    expect(d.tests.newlyFailing).toEqual([]);
    expect(d.tests.passed).toMatchObject({ a: 10, b: 12, delta: 2, comparable: true });
  });

  it('tests: never claims a fix when the other side’s failing names are incomplete', () => {
    const a = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(2), failingTests: ['x', 'y'] }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Bash', category: 'test', status: 'error', metrics: T12(3), failingTests: ['y'] }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.tests.fixed).toEqual([]);
    expect(d.tests.newlyFailing).toEqual([]);
    expect(d.tests.stillFailing.map((t) => t.name)).toEqual(['y']);
    expect(d.tests).toMatchObject({ namesComparable: false, namesNote: 'not_reported_b' });
    // The counts themselves still compare.
    expect(d.tests.failed).toMatchObject({ a: 2, b: 3, delta: 1, comparable: true });
  });

  it('tests: a side without test counts is "not reported", never 0 passed', () => {
    const a = traced({ ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Bash', category: 'test', metrics: T12(0) }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.tests.passed).toEqual({ a: null, b: 12, delta: null, comparable: false, note: 'not_reported_a' });
    expect(d.tests.runs).toMatchObject({ a: 0, b: 1, delta: 1, comparable: true }); // a count of recorded runs
    expect(d.tests.namesNote).toBe('not_reported_a');
    expect(diffRuns(a, a).tests.passed).toEqual({ a: null, b: null, delta: null, comparable: false, note: 'not_reported' });
  });

  it('tokens: not comparable when one side reported none, or when different agents reported', () => {
    const none = traced({ ns: 0xa1 });
    const one = traced({ subagents: [{ name: 'Explore #1', tokens: 1000 }], ns: 0xb1 });
    const two = traced({ subagents: [{ name: 'Explore #1', tokens: 1500 }, { name: 'Plan #1', tokens: 700 }], ns: 0xb2 });
    const oneMore = traced({ subagents: [{ name: 'Explore #1', tokens: 1300 }], ns: 0xb3 });
    expect(diffRuns(none, one).tokens).toEqual({ a: null, b: 1000, delta: null, comparable: false, note: 'not_reported_a' });
    expect(diffRuns(none, none).tokens).toMatchObject({ a: null, b: null, comparable: false, note: 'not_reported' });
    expect(diffRuns(one, two).tokens).toEqual({ a: 1000, b: 2200, delta: null, comparable: false, note: 'coverage_differs' });
    expect(diffRuns(one, oneMore).tokens).toEqual({ a: 1000, b: 1300, delta: 300, comparable: true, note: null });
  });

  it('agents match by name; the main agent’s unreported tokens stay null on both sides', () => {
    const a = traced({ subagents: [{ name: 'Explore #1', model: 'claude-haiku', tokens: 1000 }], ns: 0xa1 });
    const b = traced({ subagents: [{ name: 'Explore #1', model: 'claude-sonnet', tokens: 900 }, { name: 'Plan #1', tokens: 50 }], ns: 0xb1 });
    const rows = diffRuns(a, b).agents;
    expect(rows.map((r) => r.key)).toEqual(['Claude', 'Explore #1', 'Plan #1']);
    expect(rows[0]!.tokens).toMatchObject({ a: null, b: null, comparable: false, note: 'not_reported' });
    expect(rows[1]).toMatchObject({ modelChanged: true, tokens: { a: 1000, b: 900, delta: -100, comparable: true } });
    expect(rows[2]).toMatchObject({ a: null, tokens: { a: null, b: 50, note: 'not_reported_a' } });
  });

  it('a run still recording: outcome and duration are not compared yet', () => {
    const a = traced({ ns: 0xa1 });
    const b = traced({ ended: false, calls: [{ tool: 'Read', category: 'read', target: 'a' }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.outcome).toMatchObject({ a: 'stopped', b: null, comparable: false, changed: false, note: 'running_b' });
    expect(d.durationMs).toMatchObject({ comparable: false, delta: null, note: 'not_reported_b' });
    expect(d.toolCalls).toMatchObject({ a: 0, b: 1, delta: 1, comparable: false, note: 'running_b' });
    expect(d.files).toMatchObject({ comparable: false, note: 'running_b' });
  });

  it('executed vs traced: compared, but flagged as different instruments', () => {
    const executed = summarizeRun(foldExecution(codingMissionFixture()));
    const d = diffRuns(executed, traced({ calls: basic }));
    expect(d.sameMode).toBe(false);
    expect(d.toolCalls).toMatchObject({ a: 9, b: 4, delta: -5, comparable: true, note: 'mode_differs' });
    expect(d.outcome).toMatchObject({ a: 'succeeded', b: 'stopped', changed: true, comparable: true, note: 'mode_differs' });
    expect(d.turns).toMatchObject({ a: null, b: 1, comparable: false, note: 'not_reported_a' });
    expect(d.firstDivergence).toMatchObject({ index: 0, kind: 'call', a: { tool: 'list_files' }, b: { tool: 'Bash' } });
    // The categories line up across instruments.
    expect(d.categories.find((r) => r.key === 'test')!.count).toMatchObject({ a: 2, b: 2, delta: 0 });
  });

  it('duration of two demo runs: not comparable at different paces, a caveat when a pace was not recorded', () => {
    const base = summarizeRun(foldExecution(codingMissionFixture()));
    expect(base.speed).toBe(1); // the fixture is paced like the adapter at speed 1
    const at = (speed: number | null, durationMs: number): RunDigest => ({ ...base, speed, durationMs });
    expect(diffRuns(at(1, 26_000), at(1, 25_000)).durationMs).toEqual({ a: 26_000, b: 25_000, delta: -1000, comparable: true, note: null });
    expect(diffRuns(at(1, 26_000), at(0, 500)).durationMs).toEqual({ a: 26_000, b: 500, delta: null, comparable: false, note: 'pace_differs' });
    expect(diffRuns(at(null, 26_000), at(0, 500)).durationMs).toEqual({ a: 26_000, b: 500, delta: -25_500, comparable: true, note: 'pace_unknown' });
    // Traced runs have no pace.
    expect(diffRuns(traced({ ns: 0xa1 }), traced({ ns: 0xb1 })).durationMs.note).toBeNull();
  });

  it('a category used on one side only counts as 0 (recorded none) on the other', () => {
    const a = traced({ calls: [{ tool: 'WebFetch', category: 'web', target: undefined }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Read', category: 'read', target: 'x' }, { tool: 'Read', category: 'read', target: 'y' }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.categories.map((r) => [r.key, r.a?.count ?? null, r.count.a, r.count.b, r.count.delta])).toEqual([
      ['read', null, 0, 2, 2],
      ['web', 1, 1, 0, -1],
    ]);
  });

  it('permissions: waits compare only when both sides recorded one', () => {
    const a = traced({ permissions: [2000], ns: 0xa1 });
    const b = traced({ permissions: ['inferred'], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.permissions.requested).toMatchObject({ a: 1, b: 1, delta: 0, comparable: true });
    expect(d.permissions.denied).toMatchObject({ a: 0, b: 1, delta: 1 });
    expect(d.permissions.waitMs).toEqual({ a: 2000, b: null, delta: null, comparable: false, note: 'not_reported_b' });
  });

  it('denied calls count as failed calls on the side that had them', () => {
    const a = traced({ calls: [{ tool: 'Bash', category: 'deploy', target: 'git', status: 'denied' }], ns: 0xa1 });
    const b = traced({ calls: [{ tool: 'Bash', category: 'deploy', target: 'git' }], ns: 0xb1 });
    const d = diffRuns(a, b);
    expect(d.failedCalls).toMatchObject({ a: 1, b: 0, delta: -1 });
    expect(d.firstDivergence).toMatchObject({ index: 0, kind: 'result', a: { status: 'failed' }, b: { status: 'success' } });
  });
});
