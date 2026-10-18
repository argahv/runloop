/**
 * S3 acceptance (plan §8): real agents as residents, end to end. Every hook
 * goes through the REAL plugin script (a child `node` process) to a live
 * runtime over HTTP; Add to World, Arrivals and claims go through the agent
 * API. The world is the contract-checking fake host (test/world-fakes.ts)
 * until the world host lands; see the report for what that leaves open.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import {
  worldApiPaths,
  type AgentDetailResponse,
  type AgentSummary,
  type ArrivalsResponse,
  type ClaimSessionResponse,
  type CreateAgentResponse,
  type RunEvent,
} from '@runloop-world/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentService } from '../src/agents/service';
import { DEFAULT_ALLOWED_ORIGINS } from '../src/config';
import { createApp } from '../src/http/app';
import { mountAgentRoutes } from '../src/http/agents';
import { ensureIngestToken } from '../src/ingest-token';
import { Recorder } from '../src/recorder';
import { RunManager } from '../src/run-manager';
import { openDb } from '../src/store/db';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import type { WorldCommandSink } from '../src/world/projector';
import { comparable, envelopeOf, type FixtureLine } from './claude-code-helpers';
import { FIXTURE_CWD, expectTruthful, fixtureIn } from './agents-rig';
import { REPO_ROOT, openRecorder } from './helpers';
import { FakeWorldHost } from './world-fakes';

const SCRIPT = path.join(REPO_ROOT, 'integrations', 'claude-code-plugin', 'scripts', 'runloop-hook.mjs');
const SYNC_HOOKS = new Set(['Stop', 'StopFailure', 'SessionEnd']);

/** A runtime wired as runtime.ts will wire it: the tracer's onSessionSeen feeds the agent service. */
interface Booted {
  url: string;
  recorder: Recorder;
  tracer: TraceSessionManager;
  agents: AgentService;
  close(): Promise<void>;
}

async function boot(dataDir: string, tokenFile: string, world: WorldCommandSink): Promise<Booted> {
  const db = openDb(path.join(dataDir, 'runloop.db'));
  const recorder = new Recorder({ db, dataDir });
  recorder.recoverInterrupted();
  const manager = new RunManager({ recorder, dataDir, missionsDir: path.join(REPO_ROOT, 'examples'), onError: (e) => console.error(e) });
  let agents: AgentService | null = null;
  const tracer = new TraceSessionManager({ recorder, db, onSessionSeen: (s) => agents?.onSessionSeen(s), onError: (e) => console.error(e) });
  agents = new AgentService({ db, recorder, world, dataDir, ingestOn: true, onError: (e) => console.error(e) });
  const app = createApp({
    recorder,
    manager,
    worldsDir: path.join(REPO_ROOT, 'worlds'),
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    tracer: { manager: tracer, token: ensureIngestToken(tokenFile) },
  });
  mountAgentRoutes(app, agents);
  await agents.start();
  let server!: ServerType;
  const url = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
  });
  const svc = agents;
  return {
    url,
    recorder,
    tracer,
    agents: svc,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await svc.stop();
      tracer.stop();
      await manager.shutdown();
      db.close();
    },
  };
}

let suiteDir: string;
let dataDir: string;
let tokenFile: string;
let pluginData: string;
let repo: string;
let host: FakeWorldHost;
let rt: Booted;
/** Every API response body, for the P8 scan. */
const bodies: string[] = [];

beforeAll(async () => {
  suiteDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runloop-agents-int-')));
  dataDir = path.join(suiteDir, 'data');
  tokenFile = path.join(suiteDir, 'config', 'ingest-token');
  pluginData = path.join(suiteDir, 'plugin-data');
  repo = path.join(suiteDir, 'code', 'acme-app');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  host = new FakeWorldHost();
  rt = await boot(dataDir, tokenFile, host);
});

afterAll(async () => {
  await rt.close();
  rmSync(suiteDir, { recursive: true, force: true });
});

async function api<T>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${rt.url}${p}`, init);
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: JSON.parse(text) as T };
}
const postJson = <T>(p: string, body: unknown) => api<T>(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const agentOf = async (id: string): Promise<AgentSummary> => (await api<AgentDetailResponse>(worldApiPaths.agent(id))).body.agent;

/** One hook invocation through the real plugin script, as Claude Code runs it. */
function hook(line: FixtureLine): Promise<number | null> {
  const args = SYNC_HOOKS.has(String(line.input.hook_event_name)) ? ['--sync'] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: pluginData, CLAUDE_PLUGIN_DATA: pluginData, RUNLOOP_URL: rt.url, RUNLOOP_INGEST_TOKEN_FILE: tokenFile },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(line.input));
  });
}

async function play(lines: readonly FixtureLine[], after?: (i: number) => Promise<void>): Promise<void> {
  for (const [i, line] of lines.entries()) {
    expect(await hook(line)).toBe(0);
    await after?.(i);
  }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return { value, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`timed out; last ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The same lines through a plain tracer (no agents, no world): the control for "tracer output unchanged" and P7. */
function controlRuns(name: string, lines: readonly FixtureLine[]): RunEvent[][] {
  const dir = mkdtempSync(path.join(suiteDir, `control-${name}-`));
  const { recorder, db } = openRecorder(dir);
  const tracer = new TraceSessionManager({ recorder, db, onError: (e) => { throw e; } });
  lines.forEach((l, i) => tracer.ingest([envelopeOf(name, l, i)]));
  const runs = recorder
    .listRuns()
    .filter((r) => r.mode === 'traced')
    .sort((a, b) => (a.source?.segment ?? 0) - (b.source?.segment ?? 0))
    .map((r) => recorder.listAll(r.runId));
  db.close();
  return runs;
}

function runsOfSession(sessionId: string): RunEvent[][] {
  return rt.recorder
    .listRuns()
    .filter((r) => r.source?.sessionId === sessionId)
    .sort((a, b) => (a.source?.segment ?? 0) - (b.source?.segment ?? 0))
    .map((r) => rt.recorder.listAll(r.runId));
}

let agentId = '';

describe('S3: real agents as residents (plugin → runtime → world)', { timeout: 120_000 }, () => {
  it('Add to World on a temp repo houses the agent, waiting for its first event', async () => {
    const r = await postJson<CreateAgentResponse>(worldApiPaths.agents, { displayName: 'Acme House', lotId: 'lot_agent_3', workspace: { path: repo } });
    expect(r.status).toBe(201);
    agentId = r.body.agent.agentId;
    const a = await agentOf(agentId);
    expect(a).toMatchObject({ housed: true, buildingId: 'bld_agent_hq_3', health: 'awaiting_first_event', workspace: { label: 'acme-app', pathHint: '…/code/acme-app' } });
    expect(host.presence(agentId)).toMatchObject({ health: 'awaiting_first_event', activeRunId: null });
  });

  it('s1-basic inside the root binds by path, goes live within 2 s of the first prompt, and counts equal the tool calls', async () => {
    const lines = fixtureIn('s1-basic', path.join(repo, 'src'));
    const sessionId = String(lines[0]!.input.session_id);
    let liveMs: number | null = null;
    await play(lines, async (i) => {
      // After the first prompt (line 1) the session has a run: live within 2 s.
      if (i === 1) liveMs = (await until(() => agentOf(agentId), (a) => a.health === 'live', 2000)).ms;
    });
    expect(liveMs).not.toBeNull();
    expect(liveMs!).toBeLessThan(2000);
    const done = (await until(() => agentOf(agentId), (a) => a.health === 'offline' && host.presence(agentId)?.activeRunId === null)).value;
    expect(done.sessions).toEqual([expect.objectContaining({ sessionId, bindingMethod: 'path', status: 'stopped' })]);
    expect(done.capabilities.observe.state).toBe('available');

    const [run] = runsOfSession(sessionId);
    const calls = run!.filter((e) => e.type === 'tool.call_started').length;
    const p = host.presence(agentId)!;
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(calls);
    // Tracer output is unchanged by the world (the same lines with no agents or world).
    expect(runsOfSession(sessionId).map(comparable)).toEqual(controlRuns('s1-basic', lines).map(comparable));
  });

  it('s2-subagents with the world paused: same run events as with no world (P7), presence still updates, the tick holds', async () => {
    expect(await host.submit({ id: 'pause-1', source: 'user', command: { type: 'clock.set', speed: 0 } })).toMatchObject({ ok: true });
    const tick = host.tick;
    const lines = fixtureIn('s2-subagents', repo);
    const sessionId = String(lines[0]!.input.session_id);
    await play(lines);
    await until(() => agentOf(agentId), (a) => a.sessions.length === 2 && a.health === 'offline' && host.presence(agentId)?.activeRunId === null);
    expect(host.tick).toBe(tick);
    expect(host.speed).toBe(0);
    const acts = host.agentEvents(agentId).filter((e) => e.type === 'agent.activity_observed' && e.cause?.runId === runsOfSession(sessionId)[0]![0]!.runId);
    expect(Math.max(...acts.map((e) => (e.type === 'agent.activity_observed' ? e.p.helpers : 0)))).toBe(2);
    expect(runsOfSession(sessionId).map(comparable)).toEqual(controlRuns('s2-subagents', lines).map(comparable));
    expect(await host.submit({ id: 'resume-1', source: 'user', command: { type: 'clock.set', speed: 1 } })).toMatchObject({ ok: true });
  });

  it('P1, P4, P5: agent events are truthful, cite bound runs, and never touch residents', () => {
    expect(host.invalid).toEqual([]);
    expect(host.events.filter((e) => e.type === 'command.rejected')).toEqual([]);
    expectTruthful(host.agentEvents(agentId), rt.recorder, (s) => rt.agents.agentOfSession(s));
    // The projector only ever proposes agent commands (the fake has no residents; the real host checks them).
    const types = new Set(host.events.map((e) => e.type));
    for (const t of types) expect(t.startsWith('agent.') || t === 'world.clock_changed').toBe(true);
    expect(host.snapshot().residents).toEqual([]);
  });

  it('a session from outside the root goes to Arrivals, and claiming it backfills', async () => {
    const lines = fixtureIn('s3-async', FIXTURE_CWD);
    const sessionId = String(lines[0]!.input.session_id);
    const before = host.agentEvents(agentId).length;
    await play(lines);
    const arrivals = (await until(() => api<ArrivalsResponse>(worldApiPaths.arrivals), (r) => r.body.arrivals.length === 1)).value.body.arrivals;
    expect(arrivals[0]).toMatchObject({ sessionId, projectLabel: 'demo' });
    expect(host.agentEvents(agentId)).toHaveLength(before);

    const claimed = await postJson<ClaimSessionResponse>(worldApiPaths.claim(agentId), { sessionId });
    expect(claimed.status).toBe(200);
    expect(claimed.body.backfilledRuns).toBe(1);
    expect(claimed.body.agent.sessions.find((s) => s.sessionId === sessionId)?.bindingMethod).toBe('claimed');
    await rt.agents.projector.idle();
    const runId = runsOfSession(sessionId)[0]![0]!.runId;
    const replayed = host.agentEvents(agentId).filter((e) => e.cause?.runId === runId);
    expect(replayed.map((e) => (e.type === 'agent.session_changed' ? `session:${e.p.phase}` : e.type))).toEqual(['session:started', 'agent.activity_observed', 'session:ended']);
    expectTruthful(replayed, rt.recorder, (s) => rt.agents.agentOfSession(s));
    expect((await api<ArrivalsResponse>(worldApiPaths.arrivals)).body.arrivals).toEqual([]);
  });

  it('after a restart the building survives and the agent reads offline; an interrupted session ends as inferred', async () => {
    // A session left open (no SessionEnd), then the runtime stops without closing it.
    const lines = fixtureIn('synthetic-no-session-end', repo);
    await play(lines);
    await until(() => agentOf(agentId), (a) => a.health === 'live' && host.presence(agentId)?.activeRunId !== null);
    const openRun = host.presence(agentId)!.activeRunId!;
    await rt.close();
    host = host.restart();
    rt = await boot(dataDir, tokenFile, host);

    const a = (await until(() => agentOf(agentId), (x) => x.health === 'offline' && host.presence(agentId)?.activeRunId === null)).value;
    expect(a).toMatchObject({ housed: true, buildingId: 'bld_agent_hq_3', lotId: 'lot_agent_3', displayName: 'Acme House' });
    expect(host.agentEvents(agentId).filter((e) => e.type === 'agent.housed')).toHaveLength(1);
    const ended = host.agentEvents(agentId).find((e) => e.type === 'agent.session_changed' && e.p.runId === openRun && e.p.phase === 'ended')!;
    expect(ended).toMatchObject({ prov: 'inferred', p: { outcome: 'interrupted' } });
    expect(host.presence(agentId)).toMatchObject({ health: 'offline', buildingId: 'bld_agent_hq_3' });
    expectTruthful(host.agentEvents(agentId), rt.recorder, (s) => rt.agents.agentOfSession(s));
  });

  it('P8: the workspace realpath appears in no API response, snapshot, world event or agent table', async () => {
    await api(worldApiPaths.agents);
    await api(worldApiPaths.arrivals);
    for (const s of (await agentOf(agentId)).sessions) await api(`/api/runs/${s.runId}/events?limit=1000`);
    const db = openDb(path.join(dataDir, 'runloop.db'));
    const tables = ['agents', 'workspaces', 'agent_connections', 'session_bindings', 'audit_log', 'dispatches'].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));
    const roots = db.prepare('SELECT root_realpath FROM workspace_roots').all() as { root_realpath: string }[];
    db.close();
    expect(roots).toEqual([{ root_realpath: repo }]);
    const haystacks = [...bodies, JSON.stringify(host.snapshot()), JSON.stringify(host.events), ...tables];
    expect(bodies.length).toBeGreaterThan(10);
    expect(haystacks.filter((h) => h.includes(repo))).toEqual([]);
  });
});
