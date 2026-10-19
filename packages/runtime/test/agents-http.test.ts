/**
 * Agent API over the app's guards (plan §4.5): Add to World, list/detail,
 * Arrivals, claim, validation and P8 (no absolute path in any response).
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { worldApiPaths, type AgentDetailResponse, type ArrivalsResponse, type ClaimSessionResponse, type CreateAgentResponse, type ListAgentsResponse } from '@runloop-world/events';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from '../src/agents/service';
import { DEFAULT_ALLOWED_ORIGINS } from '../src/config';
import { mountAgentRoutes } from '../src/http/agents';
import { createApp } from '../src/http/app';
import { RunManager } from '../src/run-manager';
import type { Db } from '../src/store/db';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import { envelopeOf } from './claude-code-helpers';
import { REPO_ROOT, openRecorder, tempDir } from './helpers';
import { FIXTURE_CWD, fixtureIn, makeRepo } from './agents-rig';
import { FakeWorldHost } from './world-fakes';

const JSON_HEADERS = { 'content-type': 'application/json' };

// The app with its guards, but the agent layer on a fake world host (createRuntime wires the real one).
let rt: { db: Db; close(): Promise<void> } | null = null;
let agents: AgentService | null = null;
afterEach(async () => {
  await agents?.stop();
  await rt?.close();
  rt = null;
  agents = null;
});

/** Every response body seen, for the P8 scan. */
const bodies: string[] = [];

async function setup() {
  const dataDir = tempDir('agents-http');
  const { db, recorder } = openRecorder(dataDir);
  const manager = new RunManager({ recorder, dataDir, missionsDir: path.join(REPO_ROOT, 'examples') });
  const app = createApp({ recorder, manager, worldsDir: path.join(REPO_ROOT, 'worlds'), allowedOrigins: DEFAULT_ALLOWED_ORIGINS, pingMs: 50 });
  rt = {
    db,
    async close() {
      await manager.shutdown();
      db.close();
    },
  };
  const host = new FakeWorldHost();
  agents = new AgentService({ db, recorder, world: host, dataDir, ingestOn: true, onError: (e) => { throw e; } });
  const svc = agents;
  const tracer = new TraceSessionManager({ recorder, db, onSessionSeen: (s) => svc.onSessionSeen(s), onError: (e) => { throw e; } });
  mountAgentRoutes(app, agents);
  await agents.start();
  const call = async (p: string, init?: RequestInit) => {
    const res = await app.request(p, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null, text };
  };
  const post = (p: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) => call(p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { dataDir, host, tracer, call, post, svc };
}

describe('agent API', () => {
  it('Add to World houses the agent; list and detail show it waiting for its first event', async () => {
    const { post, call, host } = await setup();
    const repo = makeRepo('runloop');
    const created = await post(worldApiPaths.agents, { displayName: '  Engineering House ', lotId: 'lot_agent_1', workspace: { path: repo } });
    expect(created.status).toBe(201);
    const { agent } = created.json as CreateAgentResponse;
    expect(agent).toMatchObject({
      kind: 'claude-code',
      displayName: 'Engineering House',
      hue: '#5aa9f5',
      orgId: 'org_home',
      lotId: 'lot_agent_1',
      buildingId: 'bld_agent_hq_1',
      housed: true,
      health: 'awaiting_first_event',
      attention: 'none',
      lastEventAt: null,
      workspace: { label: 'runloop', pathHint: '…/code/runloop' },
      sessions: [],
    });
    expect(agent.agentId).toMatch(/^agt_[0-9a-f-]{36}$/);
    expect(agent.workspace!.workspaceId).toMatch(/^wsp_[0-9a-f-]{36}$/);
    expect(agent.capabilities.observe.state).toBe('needs_setup');
    expect(host.events.filter((e) => e.type === 'agent.housed').map((e) => [e.cmdId, e.prov])).toEqual([[`house:${agent.agentId}`, 'user']]);

    const list = await call(worldApiPaths.agents);
    expect((list.json as ListAgentsResponse).agents.map((a) => a.agentId)).toEqual([agent.agentId]);
    const detail = await call(worldApiPaths.agent(agent.agentId));
    expect((detail.json as AgentDetailResponse).agent).toEqual(agent);
    expect((await call(worldApiPaths.agent('agt_nope'))).status).toBe(404);
    // A second agent gets the next identity hue.
    const second = await post(worldApiPaths.agents, { displayName: 'Two', lotId: 'lot_agent_2', workspace: { path: makeRepo('two') } });
    expect((second.json as CreateAgentResponse).agent.hue).toBe('#e0946a');
  });

  it('refuses bad requests, without echoing the path', async () => {
    const { post, dataDir } = await setup();
    const repo = makeRepo('busy');
    const file = path.join(tempDir('file'), 'notes.txt');
    writeFileSync(file, 'x');
    mkdirSync(path.join(dataDir, 'inner'), { recursive: true });
    const ok = await post(worldApiPaths.agents, { displayName: 'A', lotId: 'lot_agent_1', workspace: { path: repo } });
    expect(ok.status).toBe(201);
    const cases: [string, unknown, number, string][] = [
      ['a body naming source', { displayName: 'B', lotId: 'lot_agent_2', workspace: { path: repo }, source: 'system' }, 400, 'invalid'],
      ['no workspace', { displayName: 'B', lotId: 'lot_agent_2' }, 400, 'invalid'],
      ['an empty name', { displayName: '   ', lotId: 'lot_agent_2', workspace: { path: makeRepo('x') } }, 400, 'invalid'],
      ['a relative path', { displayName: 'B', lotId: 'lot_agent_2', workspace: { path: 'code/repo' } }, 400, 'not_absolute'],
      ['a missing folder', { displayName: 'B', lotId: 'lot_agent_2', workspace: { path: path.join(repo, 'missing') } }, 400, 'not_found'],
      ['a file', { displayName: 'B', lotId: 'lot_agent_2', workspace: { path: file } }, 400, 'not_a_directory'],
      ['the data dir', { displayName: 'B', lotId: 'lot_agent_2', workspace: { path: path.join(dataDir, 'inner') } }, 400, 'inside_data_dir'],
      ['a bound folder', { displayName: 'B', lotId: 'lot_agent_2', workspace: { path: repo } }, 409, 'already_bound'],
      ['a taken lot', { displayName: 'B', lotId: 'lot_agent_1', workspace: { path: makeRepo('y') } }, 409, 'lot_unavailable'],
      ['an unknown lot', { displayName: 'B', lotId: 'lot_market_1', workspace: { path: makeRepo('z') } }, 404, 'unknown_entity'],
      ['an unknown session', { displayName: 'B', lotId: 'lot_agent_2', workspace: { fromSessionId: 'nope' } }, 404, 'unknown_session'],
    ];
    for (const [label, body, status, code] of cases) {
      const r = await post(worldApiPaths.agents, body);
      expect([r.status, (r.json as { code: string }).code], label).toEqual([status, code]);
      expect(r.text.includes(repo), label).toBe(false);
      expect(r.text.includes(dataDir), label).toBe(false);
    }
    expect((await post(worldApiPaths.agents, 'not json')).status).toBe(400);
    expect(agents!.list()).toHaveLength(1);
  });

  it('keeps the app’s guards: Origin, Content-Type and Host', async () => {
    const { post, call } = await setup();
    const body = { displayName: 'A', lotId: 'lot_agent_1', workspace: { path: makeRepo() } };
    expect((await post(worldApiPaths.agents, body, { ...JSON_HEADERS, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(worldApiPaths.agents, body, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call(worldApiPaths.agents, { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await post(worldApiPaths.claim('agt_x'), { sessionId: 's' }, { ...JSON_HEADERS, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(worldApiPaths.agents, body, { ...JSON_HEADERS, origin: 'http://localhost:3000' })).status).toBe(201);
  });

  it('lists Arrivals and claims one, replaying its run; an Arrival can also found an agent', async () => {
    const { post, call, tracer, host } = await setup();
    const repo = makeRepo('home');
    const created = (await post(worldApiPaths.agents, { displayName: 'Home', lotId: 'lot_agent_1', workspace: { path: repo } })).json as CreateAgentResponse;
    const agentId = created.agent.agentId;

    // A session outside every root (the sanitised fixture's folder does not exist here).
    fixtureIn('s1-basic', FIXTURE_CWD).forEach((l, i) => tracer.ingest([envelopeOf('s1-basic', l, i)]));
    // A session in a real folder outside the root, seen only up to SessionStart (no run yet).
    const elsewhere = makeRepo('elsewhere');
    const startOnly = fixtureIn('s2-subagents', elsewhere, 'session-elsewhere')[0]!;
    tracer.ingest([envelopeOf('s2-subagents', startOnly, 0)]);

    const arrivals = (await call(worldApiPaths.arrivals)).json as ArrivalsResponse;
    expect(arrivals.arrivals.map((a) => [a.projectLabel, a.pathHint, a.runIds.length])).toEqual([
      ['demo', '…/dev/demo', 1],
      ['elsewhere', '…/code/elsewhere', 0],
    ]);
    const sessionId = arrivals.arrivals[0]!.sessionId;

    expect((await post(worldApiPaths.claim('agt_nope'), { sessionId })).status).toBe(404);
    expect((await post(worldApiPaths.claim(agentId), { sessionId: 'nope' })).status).toBe(404);
    expect((await post(worldApiPaths.claim(agentId), { sessionId, extra: 1 })).status).toBe(400);
    const claimed = await post(worldApiPaths.claim(agentId), { sessionId });
    expect(claimed.status).toBe(200);
    const res = claimed.json as ClaimSessionResponse;
    expect(res.backfilledRuns).toBe(1);
    expect(res.agent.sessions).toEqual([expect.objectContaining({ sessionId, bindingMethod: 'claimed', status: 'stopped' })]);
    expect(res.agent.health).toBe('offline');
    expect(res.agent.capabilities.observe.state).toBe('available');
    expect((await post(worldApiPaths.claim(agentId), { sessionId })).status).toBe(409);
    await agents!.projector.stop();
    expect(host.agentEvents(agentId).map((e) => e.type)).toContain('agent.session_changed');

    // Found a second agent from the remaining Arrival (its folder is known in memory).
    const fromArrival = await post(worldApiPaths.agents, { displayName: 'Elsewhere', lotId: 'lot_agent_2', workspace: { fromSessionId: 'session-elsewhere' } });
    expect(fromArrival.status).toBe(201);
    expect((fromArrival.json as CreateAgentResponse).agent.workspace).toMatchObject({ label: 'elsewhere', pathHint: '…/code/elsewhere' });
    expect(((await call(worldApiPaths.arrivals)).json as ArrivalsResponse).arrivals).toEqual([]);
    expect(agents!.registry.bindingOf('session-elsewhere')).toEqual({ agentId: (fromArrival.json as CreateAgentResponse).agent.agentId, method: 'claimed' });
  });

  it('P8: no API response, snapshot, world event or agent table holds a workspace realpath', async () => {
    bodies.length = 0;
    const { post, call, tracer, host, svc } = await setup();
    const repo = makeRepo('secret-project');
    const created = (await post(worldApiPaths.agents, { displayName: 'P8', lotId: 'lot_agent_1', workspace: { path: repo } })).json as CreateAgentResponse;
    fixtureIn('s1-basic', path.join(repo, 'src')).forEach((l, i) => tracer.ingest([envelopeOf('s1-basic', l, i)]));
    await new Promise((r) => setTimeout(r, 20));
    await svc.projector.idle();
    const agent = (await call(worldApiPaths.agent(created.agent.agentId))).json as AgentDetailResponse;
    expect(agent.agent.sessions).toHaveLength(1);
    await call(worldApiPaths.agents);
    await call(worldApiPaths.arrivals);
    for (const s of agent.agent.sessions) {
      await call(`/api/runs/${s.runId}`);
      await call(`/api/runs/${s.runId}/events?limit=1000`);
    }
    const db = rt!.db;
    const tables = ['agents', 'workspaces', 'agent_connections', 'session_bindings', 'audit_log', 'dispatches'].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));
    const haystacks = [...bodies, JSON.stringify(host.snapshot()), JSON.stringify(host.events), ...tables];
    const real = realpathSync(repo);
    expect(haystacks.filter((h) => h.includes(real))).toEqual([]);
    // The one place it lives.
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_roots WHERE root_realpath = ?').get(real)).toEqual({ n: 1 });
  });
});
