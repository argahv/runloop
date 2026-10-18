/**
 * S4 acceptance with a FAKE `claude` (plan §8 S4): the real HTTP routes and
 * guards, the real agent layer and tracer, the real plugin hook script (run
 * by the fake as Claude Code would), and the contract-checking world host.
 *
 * Asserts: argv equals the preview; a bad, reused or expired nonce gets 403
 * or 409; a missing or foreign Origin gets 403; a moved root gets 409; cancel
 * kills the process group; restart → orphaned or lost; audit rows; world
 * commands with the right provenance; the session binds by dispatch; and the
 * workspace path appears in no API response, dispatch table or world event (P8).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import {
  SSE_END_EVENT,
  worldApiPaths,
  type AgentDetailResponse,
  type CreateAgentResponse,
  type DispatchEndData,
  type DispatchOutputFrame,
  type DispatchPolicyResponse,
  type DispatchPreview,
  type DispatchPreviewResponse,
  type DispatchResponse,
  type DispatchSummary,
  type ListDispatchesResponse,
  type WorldEvent,
} from '@runloop-world/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentService } from '../src/agents/service';
import { DEFAULT_ALLOWED_ORIGINS } from '../src/config';
import { DispatchManager } from '../src/dispatch/dispatch-manager';
import { createApp } from '../src/http/app';
import { mountAgentRoutes } from '../src/http/agents';
import { mountDispatchRoutes } from '../src/http/dispatch';
import { ensureIngestToken } from '../src/ingest-token';
import { Recorder } from '../src/recorder';
import { RunManager } from '../src/run-manager';
import { openDb, type Db } from '../src/store/db';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import { FAKE_VERSION, makeFakeClaude, type FakeClaude } from './fake-claude';
import { REPO_ROOT } from './helpers';
import { FakeWorldHost } from './world-fakes';

const PLUGIN_DIR = path.join(REPO_ROOT, 'integrations', 'claude-code-plugin');
const ORIGIN = DEFAULT_ALLOWED_ORIGINS[0]!;
const GRACE_MS = 600;

interface Booted {
  url: string;
  db: Db;
  recorder: Recorder;
  agents: AgentService;
  dispatch: DispatchManager;
  close(): Promise<void>;
}

/** A runtime wired the way runtime.ts should wire it (see the report): tracer → agents → dispatch. */
async function boot(o: { dataDir: string; tokenFile: string; host: FakeWorldHost; env: NodeJS.ProcessEnv; skew: { ms: number } }): Promise<Booted> {
  const db = openDb(path.join(o.dataDir, 'runloop.db'));
  const recorder = new Recorder({ db, dataDir: o.dataDir });
  recorder.recoverInterrupted();
  const manager = new RunManager({ recorder, dataDir: o.dataDir, missionsDir: path.join(REPO_ROOT, 'examples'), onError: (e) => console.error(e) });
  let agents: AgentService | null = null;
  const tracer = new TraceSessionManager({ recorder, db, onSessionSeen: (s) => agents?.onSessionSeen(s), onError: (e) => console.error(e) });
  agents = new AgentService({ db, recorder, world: o.host, dataDir: o.dataDir, ingestOn: true, onError: (e) => console.error(e) });
  const dispatch = new DispatchManager({
    db,
    agents,
    world: o.host,
    pluginDir: PLUGIN_DIR,
    ingestTokenFile: o.tokenFile,
    env: o.env,
    now: () => Date.now() + o.skew.ms,
    cancelGraceMs: GRACE_MS,
    orphanPollMs: 50,
    // A "minute" of task timeout: 1.5 s, so the default 10 min (15 s) outlasts a fake run on a loaded machine.
    timeoutMinuteMs: 1500,
    onStopped: (s) => stoppedSessions.push(s),
    onError: (e) => console.error('[dispatch]', e),
  });
  const app = createApp({
    recorder,
    manager,
    worldsDir: path.join(REPO_ROOT, 'worlds'),
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    tracer: { manager: tracer, token: ensureIngestToken(o.tokenFile) },
  });
  mountAgentRoutes(app, agents);
  mountDispatchRoutes(app, { dispatch, allowedOrigins: DEFAULT_ALLOWED_ORIGINS, pingMs: 200 });
  await agents.start();
  await dispatch.start();
  let server!: ServerType;
  const url = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
  });
  const svc = agents;
  return {
    url,
    db,
    recorder,
    agents: svc,
    dispatch,
    async close() {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dispatch.stop();
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
let repo: string;
let fake: FakeClaude;
let host: FakeWorldHost;
let rt: Booted;
let agentId: string;
const skew = { ms: 0 };
const apiKey = 'test-' + 'api-key-' + 'value-for-dispatch';
/** Every API response body, for the P8 scan. */
const bodies: string[] = [];
/** What onStopped reported (the tracer would close these sessions' runs). */
const stoppedSessions: { sessionId: string; dispatchId: string; outcome: string }[] = [];

beforeAll(async () => {
  suiteDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runloop-dispatch-int-')));
  dataDir = path.join(suiteDir, 'data');
  tokenFile = path.join(suiteDir, 'config', 'ingest-token');
  repo = path.join(suiteDir, 'code', 'acme-app');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(suiteDir, 'home'), { recursive: true });
  fake = makeFakeClaude(path.join(suiteDir, 'fake'));
  host = new FakeWorldHost();
  rt = await boot({ dataDir, tokenFile, host, env: runtimeEnv(), skew });
  const created = await post<CreateAgentResponse>(worldApiPaths.agents, { displayName: 'Engineering House', lotId: 'lot_agent_1', workspace: { path: repo } });
  expect(created.status).toBe(201);
  agentId = created.body.agent.agentId;
}, 30_000);

afterAll(async () => {
  await rt?.close();
  // Nothing a test started may outlive the suite.
  for (const f of readdirSync(fake.logDir).filter((n) => n.endsWith('.pids'))) {
    const { parent, child } = JSON.parse(readFileSync(path.join(fake.logDir, f), 'utf8')) as { parent: number; child: number };
    for (const pid of [parent, child]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
  rmSync(suiteDir, { recursive: true, force: true });
});

function runtimeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: path.join(suiteDir, 'home'),
    ANTHROPIC_API_KEY: apiKey,
    // A parent Claude Code's session variables must never reach the child.
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDECODE: '1',
    SOME_OTHER_SECRET: 'not-for-children',
  };
}

async function api<T>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${rt.url}${p}`, init);
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: JSON.parse(text) as T };
}
const post = <T>(p: string, body: unknown, origin: string | null = ORIGIN) =>
  api<T>(p, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const preview = async (task: string, extra: Record<string, unknown> = {}) => {
  const r = await post<DispatchPreviewResponse & { code?: string }>(worldApiPaths.dispatchPreview(agentId), { task, preset: 'read_only', ...extra });
  return r;
};
const approve = (p: Pick<DispatchPreview, 'previewId' | 'approvalNonce'>, origin: string | null = ORIGIN) =>
  post<DispatchResponse & { code?: string }>(worldApiPaths.dispatches, { previewId: p.previewId, approvalNonce: p.approvalNonce }, origin);
const getDispatch = async (id: string) => (await api<DispatchResponse>(worldApiPaths.dispatch(id))).body.dispatch;
const auditActions = (db: Db = rt.db) => (db.prepare('SELECT action, detail_json FROM audit_log ORDER BY id').all() as { action: string; detail_json: string }[]);
const dispatchEvents = (dispatchId: string) =>
  host.events.filter((e): e is Extract<WorldEvent, { type: 'agent.dispatch_changed' }> => e.type === 'agent.dispatch_changed' && e.p.dispatchId === dispatchId);

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const finished = (id: string, timeoutMs?: number) =>
  until(async () => {
    const d = await getDispatch(id);
    return d.status === 'finished' ? d : null;
  }, `dispatch ${id} to finish`, timeoutMs);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Read a dispatch's SSE stream to its end. */
async function readStream(id: string): Promise<{ frames: DispatchOutputFrame[]; end: DispatchEndData | null; raw: string }> {
  const res = await fetch(`${rt.url}${worldApiPaths.dispatchStream(id)}`);
  const raw = await res.text();
  bodies.push(raw);
  const frames: DispatchOutputFrame[] = [];
  let end: DispatchEndData | null = null;
  for (const block of raw.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!data) continue;
    if (event === SSE_END_EVENT) end = JSON.parse(data) as DispatchEndData;
    else frames.push(JSON.parse(data) as DispatchOutputFrame);
  }
  return { frames, end, raw };
}

// Each fake run replays a recorded session through the real hook script (one node process per hook),
// which takes seconds on a loaded machine: tests here wait up to 30 s rather than vitest's 5 s.
describe('dispatch v1 with a fake claude', { timeout: 30_000 }, () => {
  it('probes the CLI and seeds the default policy, so Assign task is available', async () => {
    const policy = (await api<DispatchPolicyResponse>(worldApiPaths.dispatchPolicy)).body;
    expect(policy.cli).toEqual({ state: 'ok', version: FAKE_VERSION, reason: null });
    expect(policy.policy).toMatchObject({ enabled: true, models: ['haiku', 'sonnet'], defaultBudgetUsd: 0.25, maxBudgetUsd: 1, defaultTimeoutMin: 10 });
    const agent = (await api<AgentDetailResponse>(worldApiPaths.agent(agentId))).body.agent;
    expect(agent.capabilities.submit_task).toEqual({ state: 'available', reason: null });
    expect(agent.capabilities.cancel.state).toBe('unsupported');
  });

  it('previews the exact argv without running anything', async () => {
    const r = await preview('Summarise the repo [fake:exit]');
    expect(r.status).toBe(200);
    const p = r.body.preview;
    expect(p.argv).toEqual([
      'claude',
      '-p',
      'Summarise the repo [fake:exit]',
      '--session-id',
      p.sessionId,
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--model',
      'haiku',
      '--max-budget-usd',
      '0.25',
      '--output-format',
      'stream-json',
      '--verbose',
      // The workspace never sent a hook, so the plugin is loaded for this session.
      '--plugin-dir',
      PLUGIN_DIR,
    ]);
    expect(p).toMatchObject({ executable: path.join(fake.binDir, 'claude'), cliVersion: FAKE_VERSION, usesPluginDir: true, workspaceLabel: 'acme-app', permissionMode: 'dontAsk' });
    expect(p.envKeys).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'PATH', 'RUNLOOP_INGEST_TOKEN_FILE', 'RUNLOOP_URL']);
    expect(Date.parse(p.expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(fake.runs()).toBe(0);
    expect(auditActions().at(-1)!.action).toBe('dispatch.previewed');
  });

  it('refuses a task that would read as an option, and anything over the policy', async () => {
    expect((await preview('--dangerously-skip-permissions')).status).toBe(400);
    expect((await preview('x', { maxBudgetUsd: 2 })).status).toBe(400);
    expect((await preview('x', { model: 'opus' })).body).toMatchObject({ code: 'model_not_allowed' });
    expect((await preview('x', { timeoutMin: 45 })).body).toMatchObject({ code: 'timeout_over_cap' });
    expect((await preview('x', { permissionMode: 'bypassPermissions' })).status).toBe(400);
    expect(fake.runs()).toBe(0);
  });

  it('approval needs an allowed Origin, JSON and the right nonce, once (403/409); nothing spawns otherwise', async () => {
    const p = (await preview('Approve me [fake:exit]')).body.preview;
    expect(await approve(p, null)).toMatchObject({ status: 403, body: { code: 'origin_required' } });
    expect((await approve(p, 'http://evil.example')).status).toBe(403);
    const asText = await fetch(`${rt.url}${worldApiPaths.dispatches}`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: JSON.stringify(p) });
    expect(asText.status).toBe(415);
    // A wrong nonce spends the preview; the right one cannot be used after it.
    expect(await approve({ previewId: p.previewId, approvalNonce: 'x'.repeat(43) })).toMatchObject({ status: 403, body: { code: 'bad_nonce' } });
    expect(await approve(p)).toMatchObject({ status: 409, body: { code: 'nonce_used' } });
    expect(await approve({ previewId: 'pvw_unknown', approvalNonce: p.approvalNonce })).toMatchObject({ status: 409, body: { code: 'preview_unknown' } });
    expect((await post(worldApiPaths.dispatches, { previewId: p.previewId, approvalNonce: p.approvalNonce, extra: 1 })).status).toBe(400);
    expect(fake.runs()).toBe(0);
    const refused = auditActions().filter((a) => a.action === 'dispatch.refused').map((a) => (JSON.parse(a.detail_json) as { code: string }).code);
    expect(refused).toEqual(['bad_nonce', 'nonce_used', 'preview_unknown']);
  });

  it('an expired nonce gets 409', async () => {
    const p = (await preview('Too late [fake:exit]')).body.preview;
    skew.ms = 5 * 60_000 + 1000;
    try {
      expect(await approve(p)).toMatchObject({ status: 409, body: { code: 'nonce_expired' } });
      expect(await approve(p)).toMatchObject({ status: 409, body: { code: 'nonce_expired' } });
    } finally {
      skew.ms = 0;
    }
    expect(fake.runs()).toBe(0);
  });

  it('a moved workspace root gets 409 and nothing runs', async () => {
    const p = (await preview('Moved [fake:exit]')).body.preview;
    const moved = `${repo}-moved`;
    renameSync(repo, moved);
    try {
      expect(await approve(p)).toMatchObject({ status: 409, body: { code: 'workspace_moved' } });
      expect((await preview('Moved again')).body).toMatchObject({ code: 'workspace_moved' });
    } finally {
      renameSync(moved, repo);
    }
    expect(fake.runs()).toBe(0);
  });

  let first: DispatchSummary;
  let firstPreview: DispatchPreview;

  it('runs exactly the previewed argv, binds the session by dispatch, and stores the result as reported', async () => {
    firstPreview = (await preview('Summarise the repo [fake:exit]')).body.preview;
    const created = await approve(firstPreview);
    expect(created.status).toBe(201);
    expect(created.body.dispatch).toMatchObject({ agentId, sessionId: firstPreview.sessionId, status: 'running', model: 'haiku', allowedTools: ['Read', 'Grep', 'Glob'], maxBudgetUsd: 0.25 });
    first = await finished(created.body.dispatch.dispatchId, 20_000);

    // P11: the spawned argv equals the preview; the env is the allowlist.
    const log = fake.log(firstPreview.sessionId)!;
    expect(['claude', ...log.argv]).toEqual(firstPreview.argv);
    expect(log.cwd).toBe(repo);
    expect(log.envKeys).toEqual(firstPreview.envKeys);

    expect(first).toMatchObject({ outcome: 'completed', exitCode: 0, reportedCostUsd: 0.0123, reportedTurns: 2 });
    expect(first.resultText).toBe('Done. Looked at …/code/acme-app/src');
    expect(rt.agents.registry.bindingOf(firstPreview.sessionId)).toEqual({ agentId, method: 'dispatch' });
    expect(first.runId).not.toBeNull();
    const run = rt.recorder.getRun(first.runId!)!;
    expect(run.mode).toBe('traced');
    expect(rt.recorder.listAll(first.runId!).filter((e) => e.type === 'tool.call_started').length).toBeGreaterThan(0);
    const agent = (await api<AgentDetailResponse>(worldApiPaths.agent(agentId))).body.agent;
    expect(agent.sessions.map((s) => s.bindingMethod)).toContain('dispatch');
  });

  it('tells the world approved (user), running and finished (system)', async () => {
    await until(() => dispatchEvents(first.dispatchId).length === 3, 'three dispatch events');
    expect(dispatchEvents(first.dispatchId).map((e) => [e.p.phase, e.prov, e.p.outcome ?? null, e.cmdId])).toEqual([
      ['approved', 'user', null, `dsp:${first.dispatchId}:approved`],
      ['running', 'system', null, `dsp:${first.dispatchId}:running`],
      ['finished', 'system', 'completed', `dsp:${first.dispatchId}:finished`],
    ]);
    expect(host.snapshot().agents.find((a) => a.agentId === agentId)!.dispatch).toEqual({ dispatchId: first.dispatchId, phase: 'finished', outcome: 'completed' });
    // The dispatched session's own events are observed, like any traced session.
    const session = host.events.find((e) => e.type === 'agent.session_changed' && e.p.runId === first.runId);
    expect(session).toMatchObject({ prov: 'external-agent', obs: 'observed' });
    expect(host.invalid).toEqual([]);
  });

  it('writes every step to the audit log, with ids only', async () => {
    const actions = auditActions().map((a) => a.action);
    for (const a of ['dispatch.previewed', 'dispatch.approved', 'dispatch.spawned', 'session.bound', 'dispatch.exited']) expect(actions).toContain(a);
    const exited = auditActions().filter((a) => a.action === 'dispatch.exited').map((a) => JSON.parse(a.detail_json) as Record<string, unknown>);
    expect(exited.at(-1)).toEqual({ dispatchId: first.dispatchId, exitCode: 0, signal: null, outcome: 'completed', reportedCostUsd: 0.0123 });
    const row = rt.db.prepare('SELECT argv_template_json, task_redacted, status, outcome, cost_usd FROM dispatches WHERE dispatch_id = ?').get(first.dispatchId) as Record<string, string>;
    expect(JSON.parse(row.argv_template_json!).argv[2]).toBe('{task}');
    expect(row).toMatchObject({ task_redacted: 'Summarise the repo [fake:exit]', status: 'finished', outcome: 'completed', cost_usd: 0.0123 });
  });

  it('streams the output (redacted, path shortened) and ends', async () => {
    const s = await readStream(first.dispatchId);
    expect(s.end).toEqual({ status: 'finished', outcome: 'completed' });
    const init = JSON.parse(s.frames[0]!.line) as { type: string; cwd: string };
    expect(init).toMatchObject({ type: 'system', cwd: '…/code/acme-app' });
    expect(s.frames.at(-1)!.line).toContain('"type":"result"');
    expect(s.raw).not.toContain(repo);
    const resumed = await fetch(`${rt.url}${worldApiPaths.dispatchStream(first.dispatchId)}`, { headers: { 'last-event-id': String(s.frames.length - 1) } });
    expect((await resumed.text()).match(/^data: /gm)!.length).toBe(2); // the last frame + end
  });

  it('a workspace that has sent hooks gets no --plugin-dir; a budget stop reads budget_exceeded', async () => {
    const p = (await preview('Spend it all [fake:budget]', { maxBudgetUsd: 0.05 })).body.preview;
    expect(p.usesPluginDir).toBe(false);
    expect(p.argv.at(-1)).toBe('--verbose');
    expect(p.argv[p.argv.indexOf('--max-budget-usd') + 1]).toBe('0.05');
    const d = await finished((await approve(p)).body.dispatch.dispatchId);
    expect(d).toMatchObject({ outcome: 'budget_exceeded', exitCode: 1, reportedCostUsd: 0.05 });
  });

  it('a failure reads failed, with stderr in the stream', async () => {
    const p = (await preview('Break [fake:fail]')).body.preview;
    const d = await finished((await approve(p)).body.dispatch.dispatchId);
    expect(d).toMatchObject({ outcome: 'failed', exitCode: 1 });
    const s = await readStream(d.dispatchId);
    expect(s.frames.some((f) => f.stream === 'stderr' && f.line === 'something went wrong')).toBe(true);
  });

  it('output past the 1 MiB cap is dropped from the stream, but the result is still read', async () => {
    const p = (await preview('Talk a lot [fake:flood]')).body.preview;
    const d = await finished((await approve(p)).body.dispatch.dispatchId, 20_000);
    expect(d).toMatchObject({ outcome: 'completed', outputTruncated: true, reportedCostUsd: 0.0123 });
    const s = await readStream(d.dispatchId);
    expect(s.frames.reduce((n, f) => n + Buffer.byteLength(f.line), 0)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('cancel at the first PreToolUse kills the process group (SIGTERM, then SIGKILL after the grace period)', async () => {
    const p = (await preview('Stubborn [fake:ignore-term]')).body.preview;
    const id = (await approve(p)).body.dispatch.dispatchId;
    const pids = await until(() => fake.pids(p.sessionId), 'the fake to start its child');
    expect(alive(pids.parent) && alive(pids.child)).toBe(true);
    // Its hooks bound it; while it runs the agent is live, a second task is refused, and cancel is available.
    const agent = await until(async () => {
      const a = (await api<AgentDetailResponse>(worldApiPaths.agent(agentId))).body.agent;
      return a.health === 'live' && a.capabilities.cancel.state === 'available' ? a : null;
    }, 'the agent to read live');
    expect(agent.health).toBe('live');
    expect((await preview('Another one')).body).toMatchObject({ code: 'dispatch_running' });

    const t0 = Date.now();
    const cancelled = await post<DispatchResponse>(worldApiPaths.dispatchCancel(id), {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.dispatch.stopping).toBe(true);
    const d = await finished(id);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(GRACE_MS - 50);
    expect(d.outcome).toBe('cancelled');
    await until(() => !alive(pids.parent) && !alive(pids.child), 'both processes to be gone', 3000);
    const actions = auditActions().map((a) => a.action);
    expect(actions.slice(actions.lastIndexOf('dispatch.cancel_requested'))).toEqual(['dispatch.cancel_requested', 'dispatch.killed', 'dispatch.exited']);
    expect((await post(worldApiPaths.dispatchCancel(id), {})).body).toMatchObject({ code: 'not_running' });
    expect(stoppedSessions.at(-1)).toEqual({ sessionId: p.sessionId, dispatchId: id, outcome: 'cancelled' });
  });

  it('a cancel honoured by SIGTERM reads cancelled within 2 s', async () => {
    const p = (await preview('Polite [fake:hang]')).body.preview;
    const id = (await approve(p)).body.dispatch.dispatchId;
    const pids = await until(() => fake.pids(p.sessionId), 'the fake to start');
    const t0 = Date.now();
    await post(worldApiPaths.dispatchCancel(id), {});
    const d = await finished(id, 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(d.outcome).toBe('cancelled');
    await until(() => !alive(pids.parent) && !alive(pids.child), 'both processes to be gone', 3000);
  });

  it('the timeout stops it as timed_out', async () => {
    const p = (await preview('Slow [fake:hang]', { timeoutMin: 1 })).body.preview;
    const d = await finished((await approve(p)).body.dispatch.dispatchId, 5000);
    expect(d.outcome).toBe('timed_out');
    expect(auditActions().some((a) => a.action === 'dispatch.timed_out')).toBe(true);
  });

  it('lists an agent’s dispatches, newest first', async () => {
    const list = (await api<ListDispatchesResponse>(`${worldApiPaths.dispatches}?agentId=${agentId}`)).body.dispatches;
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(list.at(-1)!.dispatchId).toBe(first.dispatchId);
    expect((await api(worldApiPaths.dispatch('dsp_nope'))).status).toBe(404);
  });

  it('after a restart a live process is orphaned (and can be cancelled); a dead one is lost', async () => {
    const p = (await preview('Outlive the runtime [fake:hang]')).body.preview;
    const id = (await approve(p)).body.dispatch.dispatchId;
    const pids = await until(() => fake.pids(p.sessionId), 'the fake to start');
    // A row whose process is gone, as a crash would leave it.
    rt.db
      .prepare(`INSERT INTO dispatches (dispatch_id, agent_id, session_id, argv_template_json, task_redacted, status, pid, created_at) VALUES (?, ?, ?, '{}', 'x', 'running', ?, ?)`)
      .run('dsp_00000000-0000-4000-8000-000000000001', agentId, '00000000-0000-4000-8000-0000000000aa', 2 ** 22 + 7, new Date().toISOString());

    await rt.close();
    host = host.restart();
    rt = await boot({ dataDir, tokenFile, host, env: runtimeEnv(), skew });

    expect(alive(pids.parent)).toBe(true);
    expect(await getDispatch(id)).toMatchObject({ status: 'orphaned', outcome: null });
    const lost = await getDispatch('dsp_00000000-0000-4000-8000-000000000001');
    expect(lost).toMatchObject({ status: 'finished', outcome: 'lost' });
    await until(() => dispatchEvents(lost.dispatchId).some((e) => e.p.phase === 'finished' && e.p.outcome === 'lost' && e.prov === 'system'), 'lost in the world');

    expect((await post(worldApiPaths.dispatchCancel(id), {})).status).toBe(202);
    const d = await finished(id, 5000);
    expect(d.outcome).toBe('cancelled');
    await until(() => !alive(pids.parent) && !alive(pids.child), 'the orphan to be gone', 3000);
    const actions = auditActions().map((a) => a.action);
    for (const a of ['dispatch.orphaned', 'dispatch.lost']) expect(actions).toContain(a);
  });

  it('P8: the workspace path and the API key appear in no response, dispatch table, audit row or world event', () => {
    const tables = [
      ...(rt.db.prepare('SELECT * FROM dispatches').all() as object[]),
      ...(rt.db.prepare('SELECT * FROM audit_log').all() as object[]),
      ...(rt.db.prepare('SELECT * FROM org_policies').all() as object[]),
    ].map((r) => JSON.stringify(r));
    const haystacks = [...bodies, ...tables, JSON.stringify(host.events), JSON.stringify(host.snapshot())];
    expect(haystacks.filter((h) => h.includes(repo))).toEqual([]);
    expect(haystacks.filter((h) => h.includes(apiKey))).toEqual([]);
  });
});

describe('dispatch setup problems', () => {
  it('when Claude Code reports the tracer installed, even a new workspace gets no --plugin-dir', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runloop-dispatch-plugin-')));
    try {
      const cli = makeFakeClaude(path.join(dir, 'fake'), { pluginList: 'installed' });
      const w = path.join(dir, 'code', 'w');
      mkdirSync(w, { recursive: true });
      const b = await boot({
        dataDir: path.join(dir, 'data'),
        tokenFile: path.join(dir, 'token'),
        host: new FakeWorldHost(),
        env: { PATH: [cli.binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: dir },
        skew: { ms: 0 },
      });
      try {
        const call = (p: string, init?: RequestInit) => fetch(`${b.url}${p}`, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
        const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
        const a = await call(worldApiPaths.agents, json({ displayName: 'Installed', lotId: 'lot_agent_3', workspace: { path: w } }));
        const r = await call(worldApiPaths.dispatchPreview(a.body.agent.agentId as string), json({ task: 'x', preset: 'read_only' }));
        expect(r.status).toBe(200);
        expect(r.body.preview.usesPluginDir).toBe(false);
        expect(r.body.preview.argv).not.toContain('--plugin-dir');
        expect(cli.runs()).toBe(0);
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a CLI without a required flag leaves Assign task needing setup, with the reason, and previews refuse', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runloop-dispatch-probe-')));
    try {
      const old = makeFakeClaude(path.join(dir, 'fake'), { omitFlags: ['--max-budget-usd'] });
      const w = path.join(dir, 'code', 'w');
      mkdirSync(w, { recursive: true });
      const h = new FakeWorldHost();
      const b = await boot({
        dataDir: path.join(dir, 'data'),
        tokenFile: path.join(dir, 'token'),
        host: h,
        env: { PATH: [old.binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: dir },
        skew: { ms: 0 },
      });
      try {
        const call = (p: string, init?: RequestInit) => fetch(`${b.url}${p}`, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
        const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
        const a = await call(worldApiPaths.agents, json({ displayName: 'Old CLI', lotId: 'lot_agent_2', workspace: { path: w } }));
        const id = a.body.agent.agentId as string;
        const caps = (await call(worldApiPaths.agent(id))).body.agent.capabilities;
        expect(caps.submit_task.state).toBe('needs_setup');
        expect(caps.submit_task.reason).toMatch(/--max-budget-usd/);
        const r = await call(worldApiPaths.dispatchPreview(id), json({ task: 'x', preset: 'read_only' }));
        expect(r).toMatchObject({ status: 409, body: { code: 'cli_unavailable' } });
        expect(old.runs()).toBe(0);
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('with dispatch off every route answers 404 dispatch_disabled', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    mountDispatchRoutes(app, { dispatch: null, allowedOrigins: DEFAULT_ALLOWED_ORIGINS });
    for (const [method, p] of [
      ['GET', worldApiPaths.dispatchPolicy],
      ['POST', worldApiPaths.dispatchPreview('agt_x')],
      ['POST', worldApiPaths.dispatches],
      ['GET', worldApiPaths.dispatch('dsp_x')],
    ] as const) {
      const res = await app.request(`http://localhost${p}`, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'dispatch_disabled' });
    }
  });
});

describe('P11', () => {
  it('only the sandbox (scripted demo) and dispatch start processes; dispatch spawns in one place, after the nonce', () => {
    const src = path.join(REPO_ROOT, 'packages', 'runtime', 'src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    const spawning = files.filter((f) => readFileSync(path.join(src, f), 'utf8').includes('node:child_process')).sort();
    expect(spawning).toEqual([path.join('dispatch', 'claude-cli.ts'), path.join('dispatch', 'dispatch-manager.ts'), path.join('sandbox', 'command.ts')]);
    const manager = readFileSync(path.join(src, 'dispatch', 'dispatch-manager.ts'), 'utf8');
    expect(manager.match(/\bspawn\(/g)!.length).toBe(1);
    expect(manager.match(/this\.launch\(/g)!.length).toBe(1);
    // launch is reached only from create, after the nonce check.
    const create = manager.slice(manager.indexOf('async create('), manager.indexOf('// ── read side'));
    expect(create.indexOf('timingSafeEqual')).toBeGreaterThan(0);
    expect(create.indexOf('this.launch(')).toBeGreaterThan(create.indexOf('timingSafeEqual'));
    // claude-cli only runs --version, --help and plugin list --json (read-only probes).
    expect(readFileSync(path.join(src, 'dispatch', 'claude-cli.ts'), 'utf8').match(/run\(exe, \[[^\]]*\]/g)).toEqual([
      "run(exe, ['--version']",
      "run(exe, ['--help']",
      "run(exe, ['plugin', 'list', '--json']",
    ]);
  });
});
