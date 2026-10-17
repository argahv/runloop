import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  INGEST_TOKEN_HEADER,
  apiPaths,
  type ClaudeCodeIngestResponse,
  type EventOf,
  type HealthResponse,
  type RunEvent,
} from '@runloop-world/events';
import { foldExecution } from '@runloop-world/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureIngestToken, resolveIngestTokenFile, tokenMatches } from '../src/ingest-token';
import { EventValidationError } from '../src/recorder';
import { createRuntime, type Runtime, type RuntimeOptions } from '../src/runtime';
import { envelopeOf, readFixture } from './claude-code-helpers';
import { MANIFEST, REPO_ROOT, openRecorder, tempDir } from './helpers';

const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
});

function runtime(opts: Partial<RuntimeOptions> & { dataDir?: string; tokenFile?: string } = {}): Runtime {
  const { tokenFile, ...rest } = opts;
  const rt = createRuntime({
    repoRoot: REPO_ROOT,
    dataDir: tempDir('ingest'),
    env: {},
    pingMs: 50,
    ...rest,
    trace: { tokenFile: tokenFile ?? path.join(tempDir('token'), 'ingest-token'), sweepMs: 3_600_000, ...rest.trace },
  });
  runtimes.push(rt);
  return rt;
}

const tokenOf = (rt: Runtime) => readFileSync(rt.ingestTokenFile!, 'utf8').trim();

function post(rt: Runtime, body: unknown, headers: Record<string, string> = {}) {
  return rt.app.request(apiPaths.ingestClaudeCode, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [INGEST_TOKEN_HEADER]: tokenOf(rt), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Envelopes for a fixture, as the plugin would send them. */
const fixtureEnvelopes = (name: string) => readFixture(name).map((line, i) => envelopeOf(name, line, i));

async function ingestAll(rt: Runtime, envelopes: unknown[]): Promise<ClaudeCodeIngestResponse> {
  const total = { accepted: 0, duplicates: 0, ignored: 0 };
  for (const env of envelopes) {
    const res = await post(rt, { envelopes: [env] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as ClaudeCodeIngestResponse;
    total.accepted += body.accepted;
    total.duplicates += body.duplicates;
    total.ignored += body.ignored;
  }
  return total;
}

const tracedRuns = (rt: Runtime) => rt.recorder.listRuns().filter((r) => r.mode === 'traced');

describe('POST /api/ingest/claude-code guards', () => {
  it('needs the token (401), rejects any Origin (403), non-JSON (415), bodies over 1 MiB (413)', async () => {
    const rt = runtime();
    const body = { envelopes: fixtureEnvelopes('s1-basic').slice(0, 1) };
    expect((await post(rt, body, { [INGEST_TOKEN_HEADER]: '' })).status).toBe(401);
    expect((await post(rt, body, { [INGEST_TOKEN_HEADER]: 'wrong-token-wrong-token' })).status).toBe(401);
    for (const origin of ['http://localhost:3000', 'http://evil.example']) expect((await post(rt, body, { origin })).status).toBe(403);
    const preflight = await rt.app.request(apiPaths.ingestClaudeCode, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
    expect(preflight.status).toBe(403);
    expect((await post(rt, body, { 'content-type': 'text/plain' })).status).toBe(415);
    const big = JSON.stringify({ envelopes: [{ ...body.envelopes[0], hook: { ...body.envelopes[0]!.hook, pad: 'x'.repeat(1_100_000) } }] });
    expect((await post(rt, big)).status).toBe(413);
    expect(tracedRuns(rt)).toEqual([]);
  });

  it('rejects invalid JSON, unknown protocol versions and invalid envelopes (400)', async () => {
    const rt = runtime();
    const [env] = fixtureEnvelopes('s1-basic');
    expect((await post(rt, '{nope')).status).toBe(400);
    const v2 = await post(rt, { envelopes: [{ ...env, v: 2 }] });
    expect(v2.status).toBe(400);
    expect(await v2.json()).toMatchObject({ supported: [1] });
    expect((await post(rt, { envelopes: [] })).status).toBe(400);
    expect((await post(rt, { envelopes: [{ ...env, hook: { hook_event_name: 'Stop' } }] })).status).toBe(400);
    expect((await post(rt, { envelopes: [{ ...env, deliveryId: '../../etc' }] })).status).toBe(400);
  });

  it('rate-limits per session (429) without recording any of the request', async () => {
    const rt = runtime({ trace: { rate: { perSecond: 1, burst: 3 } } });
    const envs = fixtureEnvelopes('s1-basic');
    expect((await post(rt, { envelopes: envs.slice(0, 3) })).status).toBe(202); // SessionStart, prompt, PreToolUse
    const run = tracedRuns(rt)[0]!;
    const before = rt.recorder.listAll(run.runId).length;
    const res = await post(rt, { envelopes: envs.slice(3, 5) }); // PermissionRequest, PreToolUse
    expect(res.status).toBe(429);
    expect(rt.recorder.listAll(run.runId)).toHaveLength(before);
  });

  it('is off with RUNLOOP_TRACE=off, and when no token file can be resolved', async () => {
    const off = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('off'), env: { RUNLOOP_TRACE: 'off', HOME: tempDir('home') } });
    runtimes.push(off);
    expect(off.tracer).toBeNull();
    const health = (await (await off.app.request(apiPaths.health)).json()) as HealthResponse;
    expect(health.ingest).toBeNull();
    const res = await off.app.request(apiPaths.ingestClaudeCode, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    const noHome = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('nohome'), env: {} });
    runtimes.push(noHome);
    expect(noHome.tracer).toBeNull();
  });
});

describe('ingest behaviour', () => {
  it('records a session as one traced run and counts retries as duplicates', async () => {
    const rt = runtime();
    const envs = fixtureEnvelopes('s2-subagents');
    const first = await ingestAll(rt, envs);
    expect(first.accepted).toBeGreaterThan(20);
    const [run] = tracedRuns(rt);
    expect(run).toMatchObject({ status: 'stopped', mode: 'traced', source: { kind: 'claude-code', segment: 1, projectLabel: 'demo' } });
    expect(run!.lastEventAt).toBe(rt.recorder.listAll(run!.runId).at(-1)!.timestamp);
    const before = rt.recorder.listAll(run!.runId).length;
    // A retry of everything (a spool flush): handled hooks are duplicates; nothing new is recorded.
    const again = await ingestAll(rt, envs);
    expect(again.accepted).toBe(0);
    expect(again.duplicates).toBe(first.accepted);
    expect(rt.recorder.listAll(run!.runId)).toHaveLength(before);
    expect(foldExecution(rt.recorder.listAll(run!.runId)).anomalies).toEqual([]);
  });

  it('keeps concurrent sessions in separate runs with contiguous sequences', async () => {
    const rt = runtime();
    const a = fixtureEnvelopes('s1-basic');
    const b = fixtureEnvelopes('s3-async');
    const interleaved: unknown[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) interleaved.push(...[a[i], b[i]].filter(Boolean));
    await ingestAll(rt, interleaved);
    const runs = tracedRuns(rt);
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      const events = rt.recorder.listAll(r.runId);
      expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
      expect(new Set(events.map((e) => e.runId))).toEqual(new Set([r.runId]));
      expect(foldExecution(events).anomalies).toEqual([]);
    }
  });

  it('coexists with a scripted run: separate slots, health lists both, control routes refuse traced runs (409)', async () => {
    const rt = runtime();
    const envs = fixtureEnvelopes('s1-basic');
    await ingestAll(rt, envs.slice(0, 6)); // open traced run
    const { runId: scripted } = rt.manager.start({ missionId: 'coding-mission', speed: 0 });
    const traced = tracedRuns(rt)[0]!.runId;
    const health = (await (await rt.app.request(apiPaths.health)).json()) as HealthResponse;
    expect(health).toMatchObject({ activeRunId: scripted, tracedRunIds: [traced], ingest: { claudeCode: { protocol: 1 } } });
    for (const action of ['stop', 'pause', 'resume'] as const) {
      const res = await rt.app.request(apiPaths[action](traced), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Traced runs are controlled by Claude Code' });
    }
    await ingestAll(rt, envs.slice(6));
    expect((await rt.manager.whenDone(scripted)).status).toBe('succeeded');
    expect(rt.recorder.getRun(traced)!.status).toBe('stopped');
    expect(rt.recorder.getRun(scripted)).toMatchObject({ mode: 'executed', source: null });
  });

  it('a runtime restart closes traced runs as unobserved (inferred); the next hook opens a continuation segment', async () => {
    const dataDir = tempDir('restart');
    const tokenFile = path.join(tempDir('token'), 'ingest-token');
    const envs = fixtureEnvelopes('s2-subagents');
    const a = runtime({ dataDir, tokenFile });
    await ingestAll(a, envs.slice(0, 9)); // both subagents running, their Agent calls open
    const first = tracedRuns(a)[0]!.runId;
    await a.close();

    const b = runtime({ dataDir, tokenFile });
    expect(b.recovered).toEqual([first]);
    const closed = b.recorder.listAll(first);
    const failures = closed.filter((e): e is EventOf<'tool.call_failed'> => e.type === 'tool.call_failed');
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect(f).toMatchObject({ provenance: 'inferred', payload: { errorType: 'unobserved' } });
    expect(closed.at(-1)).toMatchObject({ type: 'run.completed', provenance: 'inferred', payload: { outcome: 'interrupted' } });
    expect(foldExecution(closed).anomalies).toEqual([]);

    await ingestAll(b, envs.slice(9));
    const runs = tracedRuns(b);
    expect(runs).toHaveLength(2);
    const next = runs.find((r) => r.runId !== first)!;
    expect(next.source).toMatchObject({ segment: 2 });
    const events = b.recorder.listAll(next.runId);
    expect((events[0] as EventOf<'run.started'>).payload.source).toMatchObject({ segment: 2, continuesRunId: first });
    expect(foldExecution(events).anomalies).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', payload: { outcome: 'stopped' } });
  });

  it('the idle sweep closes a quiet session as interrupted, stamped at its last event', async () => {
    const envs = fixtureEnvelopes('s1-basic');
    const lastMs = Date.parse(envs[4]!.observedAt);
    let clock = lastMs;
    const rt = runtime({ trace: { now: () => new Date(clock) } });
    await ingestAll(rt, envs.slice(0, 5));
    const run = tracedRuns(rt)[0]!;
    expect(rt.tracer!.sweepIdle(new Date(lastMs + 60_000))).toEqual([]);
    expect(rt.tracer!.sweepIdle(new Date(lastMs + 121 * 60_000))).toEqual([run.runId]);
    clock = lastMs + 121 * 60_000;
    const events = rt.recorder.listAll(run.runId);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', provenance: 'inferred', payload: { outcome: 'interrupted' } });
    expect(Date.parse(events.at(-1)!.timestamp)).toBe(lastMs);
    // A spooled event observed before the close is late and dropped; a newer one opens segment 2.
    const late = { ...envs[5]!, observedAt: new Date(lastMs - 1000).toISOString() };
    expect(await ingestAll(rt, [late])).toMatchObject({ accepted: 0, ignored: 1 });
    const later = { ...envs[7]!, deliveryId: 'later', observedAt: new Date(lastMs + 200 * 60_000).toISOString() };
    await ingestAll(rt, [later]);
    expect(tracedRuns(rt).map((r) => r.source?.segment).sort()).toEqual([1, 2]);
  });
});

describe('idle sweep and late results', () => {
  it('measures idleness from when envelopes arrived, so an old spooled backlog is not split', async () => {
    const envs = fixtureEnvelopes('s1-basic');
    const now = Date.parse(envs.at(-1)!.observedAt) + 3 * 3600_000; // the backlog was observed 3 h ago
    const rt = runtime({ trace: { now: () => new Date(now) } });
    await ingestAll(rt, envs.slice(0, 10));
    expect(rt.tracer!.sweepIdle(new Date(now + 60_000))).toEqual([]);
    await ingestAll(rt, envs.slice(10));
    const runs = tracedRuns(rt);
    expect(runs).toHaveLength(1);
    const exec = foldExecution(rt.recorder.listAll(runs[0]!.runId));
    // The only failing test run (line 10) is recorded as Claude Code reported it.
    expect(exec.toolCalls.get('toolu_01DUuvoTXKCZEH1W5pc3GVHm')).toMatchObject({ status: 'error', exitCode: 1, endProvenance: 'reported' });
    expect(exec.run.status).toBe('stopped');
  });

  it('a result for a call the idle sweep closed is recorded in the continuation segment, not dropped', async () => {
    const envs = fixtureEnvelopes('s1-basic');
    let clock = Date.parse(envs[9]!.observedAt);
    const rt = runtime({ trace: { now: () => new Date(clock) } });
    await ingestAll(rt, envs.slice(0, 10)); // ends with PreToolUse(node --test)
    clock += 121 * 60_000; // the test run took longer than the idle limit
    const [first] = rt.tracer!.sweepIdle();
    expect(first).toBeDefined();
    const closed = foldExecution(rt.recorder.listAll(first!));
    expect(closed.toolCalls.get('toolu_01DUuvoTXKCZEH1W5pc3GVHm')).toMatchObject({ status: 'failed', errorType: 'unobserved' });
    const result = { ...envs[10]!, observedAt: new Date(clock).toISOString() };
    expect(await ingestAll(rt, [result])).toMatchObject({ accepted: 1, ignored: 0 });
    const next = tracedRuns(rt).find((r) => r.runId !== first)!;
    const exec = foldExecution(rt.recorder.listAll(next.runId));
    expect(exec.toolCalls.get('toolu_01DUuvoTXKCZEH1W5pc3GVHm')).toMatchObject({ status: 'error', exitCode: 1, startProvenance: 'inferred', endProvenance: 'reported' });
    expect(exec.anomalies).toEqual([]);
  });
});

describe('Recorder modes', () => {
  const RUN = '22222222-2222-4222-8222-222222222222';
  const TRACED = '33333333-3333-4333-8333-333333333333';
  const tracedManifest = {
    title: 'Claude Code · demo',
    missionId: 'claude-code',
    worldId: 'research-campus',
    adapter: { id: 'claude-code', kind: 'external' as const, label: 'Claude Code' },
    mode: 'traced' as const,
    source: { kind: 'claude-code' as const, sessionId: 's', segment: 1, projectLabel: 'demo' },
  };
  const call = { type: 'tool.call_started' as const, payload: { callId: 'c', agentId: 'a', tool: 'Read', inputSummary: 'x' } };

  it('executed runs reject provenance and timestamps', () => {
    const { recorder } = openRecorder(tempDir());
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    expect(() => recorder.append(RUN, { ...call, provenance: 'reported' })).toThrow(EventValidationError);
    expect(() => recorder.append(RUN, { ...call, timestamp: '2026-10-17T09:00:00.000Z' })).toThrow(EventValidationError);
    expect(recorder.append(RUN, call).provenance).toBeUndefined();
  });

  it('traced runs require provenance on tool events and clamp source timestamps to [start, now]', () => {
    const now = new Date('2026-10-17T12:00:00.000Z');
    const { recorder } = openRecorder(tempDir(), { now: () => now });
    const [started] = recorder.recordBatch({ runId: TRACED, create: { manifest: tracedManifest, timestamp: '2026-10-17T10:00:00.000Z' }, drafts: [] });
    expect(started!.timestamp).toBe('2026-10-17T10:00:00.000Z');
    expect(() => recorder.recordBatch({ runId: TRACED, drafts: [call] })).toThrow(/provenance/);
    const [early, late] = recorder.recordBatch({
      runId: TRACED,
      drafts: [
        { ...call, provenance: 'reported', timestamp: '2026-10-17T08:00:00.000Z' },
        { type: 'tool.call_completed', payload: { callId: 'c', status: 'success', durationMs: 1, outputSummary: '' }, provenance: 'reported', timestamp: '2026-10-18T00:00:00.000Z', parentCallId: 'c' },
      ],
    });
    expect(early!.timestamp).toBe('2026-10-17T10:00:00.000Z');
    expect(late!.timestamp).toBe(now.toISOString());
    expect(late!.parentEventId).toBe(early!.eventId);
    expect(late!.provenance).toBe('reported');
  });

  it('recordBatch is all or nothing (events, sequence and ingest mark)', () => {
    const { recorder } = openRecorder(tempDir());
    const published: RunEvent[] = [];
    recorder.bus.subscribeAll((e) => published.push(e));
    const mark = { sessionId: 's', key: 'k1', hookEvent: 'PreToolUse', observedAt: null };
    expect(() =>
      recorder.recordBatch({
        runId: TRACED,
        create: { manifest: tracedManifest },
        drafts: [{ ...call, provenance: 'reported' }, { type: 'agent.state_changed', payload: { agentId: 'a', state: 'dancing' as never } }],
        ingest: mark,
      }),
    ).toThrow(EventValidationError);
    expect(recorder.getRun(TRACED)).toBeNull();
    expect(recorder.hasIngested('s', 'k1')).toBe(false);
    expect(published).toEqual([]);
    const events = recorder.recordBatch({ runId: TRACED, create: { manifest: tracedManifest }, drafts: [{ ...call, provenance: 'reported' }], ingest: mark });
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(recorder.hasIngested('s', 'k1')).toBe(true);
    expect(published.map((e) => e.sequence)).toEqual([1, 2]);
  });
});

describe('ingest token file', () => {
  it('resolves the per-user path from the environment', () => {
    expect(resolveIngestTokenFile({ RUNLOOP_INGEST_TOKEN_FILE: '/x/t' })).toBe('/x/t');
    expect(resolveIngestTokenFile({ XDG_CONFIG_HOME: '/cfg', HOME: '/h' }, 'linux')).toBe('/cfg/runloop/ingest-token');
    expect(resolveIngestTokenFile({ HOME: '/h' }, 'linux')).toBe('/h/.config/runloop/ingest-token');
    expect(resolveIngestTokenFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', HOME: '/h' }, 'win32')).toContain('runloop');
    expect(resolveIngestTokenFile({})).toBeNull();
  });

  it('creates a 0600 token once and compares in constant time', () => {
    const file = path.join(tempDir('tok'), 'nested', 'ingest-token');
    const token = ensureIngestToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureIngestToken(file)).toBe(token);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}x`)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('tightens an existing token file readable by others to 0600', () => {
    const file = path.join(tempDir('tok-lax'), 'ingest-token');
    writeFileSync(file, 'an-existing-token-of-good-length\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    expect(ensureIngestToken(file, (m) => warnings.push(m))).toBe('an-existing-token-of-good-length');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(warnings).toEqual([]);
  });
});
