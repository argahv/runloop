/**
 * The agent layer and dispatch as createRuntime wires them (plan §4.3–4.5):
 * the tracer's onSessionSeen binds sessions, ingest over HTTP makes the agent
 * live in the real world host, a restart keeps the building and reads
 * offline, RUNLOOP_WORLD=off turns the agent and dispatch routes off, and a
 * stopped dispatched session's run is closed (inferred) by the tracer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  INGEST_TOKEN_HEADER,
  apiPaths,
  worldApiPaths,
  type CreateAgentResponse,
  type ListAgentsResponse,
  type WorldEvent,
} from '@runloop-world/events';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime';
import { envelopeOf } from './claude-code-helpers';
import { fixtureIn, makeRepo } from './agents-rig';
import { REPO_ROOT, tempDir } from './helpers';

const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
});

const T0 = Date.parse('2026-10-18T10:00:00Z');

function boot(dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const clock = { t: T0 };
  const rt = createRuntime({
    repoRoot: REPO_ROOT,
    dataDir,
    env,
    trace: { tokenFile: path.join(dataDir, 'ingest-token'), sweepMs: 3_600_000 },
    world: { seed: 42, population: 80, now: () => clock.t, tickMs: 0 },
  });
  runtimes.push(rt);
  return rt;
}

const json = { 'content-type': 'application/json' };

async function ingest(rt: Runtime, envelopes: unknown[]): Promise<void> {
  const token = readFileSync(rt.ingestTokenFile!, 'utf8').trim();
  for (const env of envelopes) {
    const res = await rt.app.request(apiPaths.ingestClaudeCode, {
      method: 'POST',
      headers: { ...json, [INGEST_TOKEN_HEADER]: token },
      body: JSON.stringify({ envelopes: [env] }),
    });
    expect(res.status).toBe(202);
  }
}

async function until(ok: () => Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function agentsOf(rt: Runtime) {
  return ((await (await rt.app.request(worldApiPaths.agents)).json()) as ListAgentsResponse).agents;
}

describe('createRuntime wires agents and dispatch', () => {
  it('Add to World, a hook-driven session goes live in the real world, and a restart reads offline', async () => {
    const dataDir = tempDir('rt-agents');
    const repo = makeRepo('wired');
    let rt = boot(dataDir);
    await rt.agents!.projector.idle();

    const created = await rt.app.request(worldApiPaths.agents, {
      method: 'POST',
      headers: { ...json, origin: 'http://localhost:3000' },
      body: JSON.stringify({ displayName: 'Claude', lotId: 'lot_agent_1', workspace: { path: repo } }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as CreateAgentResponse;
    expect(agent).toMatchObject({ displayName: 'Claude', housed: true, health: 'awaiting_first_event', buildingId: 'bld_agent_hq_1' });

    // Hooks as the plugin sends them, from inside the registered folder, up to the failing test run.
    const lines = fixtureIn('s1-basic', repo);
    const failed = lines.findIndex((l) => l.input.hook_event_name === 'PostToolUseFailure' && l.input.tool_name === 'Bash');
    const stop = lines.findIndex((l) => l.input.hook_event_name === 'Stop');
    expect(failed).toBeGreaterThan(0);
    const send = (from: number, to: number) => ingest(rt, lines.slice(from, to).map((l, i) => ({ ...envelopeOf('s1-basic', l, from + i), observedAt: new Date().toISOString() })));
    await send(0, failed + 1);
    // The projector paces commands on the wall clock (at most one activity per second).
    const presenceOf = () => rt.world!.snapshot().agents.find((a) => a.agentId === agent.agentId)!;
    await until(async () => {
      await rt.agents!.projector.idle();
      return presenceOf().activeRunId !== null && presenceOf().health === 'live' && presenceOf().openIncidents > 0;
    });
    // The failing test is an incident on the building.
    expect(presenceOf().attention).toBe('incident');
    await send(failed + 1, stop);
    await until(async () => {
      await rt.agents!.projector.idle();
      return (presenceOf().counts.edit ?? 0) > 0;
    });
    const [live] = await agentsOf(rt);
    expect(live!.health).toBe('live');
    expect(live!.sessions).toHaveLength(1);
    expect(live!.sessions[0]!.bindingMethod).toBe('path');
    expect(presenceOf().activeRunId).toBe(live!.sessions[0]!.runId);
    const page = (await (await rt.app.request(`${worldApiPaths.events}?after=0&limit=1000&type=agent.session_changed`)).json()) as { events: WorldEvent[] };
    expect(page.events.map((e) => e.prov)).toEqual(['external-agent']);

    // Dispatch is mounted (the CLI is not on this PATH, so it reads missing).
    const policy = await rt.app.request(worldApiPaths.dispatchPolicy);
    expect(policy.status).toBe(200);
    expect(((await policy.json()) as { cli: { state: string } }).cli.state).toBe('missing');

    // Restart: the building survives, the open run was interrupted, the agent reads offline.
    await rt.close();
    runtimes.splice(runtimes.indexOf(rt), 1);
    rt = boot(dataDir);
    await new Promise((r) => setTimeout(r, 20));
    await rt.agents!.projector.idle();
    const [after] = await agentsOf(rt);
    expect(after).toMatchObject({ agentId: agent.agentId, displayName: 'Claude', housed: true, health: 'offline' });
    expect(rt.world!.snapshot().agents.map((a) => a.agentId)).toEqual([agent.agentId]);
    expect(rt.recorder.getRun(live!.sessions[0]!.runId)?.status).toBe('interrupted');
  });

  it('RUNLOOP_WORLD=off answers 404 on the agent and dispatch routes', async () => {
    const rt = boot(tempDir('rt-agents-off'), { RUNLOOP_WORLD: 'off' });
    expect(rt.agents).toBeNull();
    expect(rt.dispatch).toBeNull();
    for (const p of [worldApiPaths.agents, worldApiPaths.arrivals, worldApiPaths.dispatchPolicy, worldApiPaths.dispatches]) {
      const res = await rt.app.request(p);
      expect(res.status, p).toBe(404);
    }
    expect(((await (await rt.app.request(worldApiPaths.agents)).json()) as { code: string }).code).toBe('world_disabled');
  });

  it('RUNLOOP_DISPATCH=off keeps agents but turns dispatch off', async () => {
    const rt = boot(tempDir('rt-dispatch-off'), { RUNLOOP_DISPATCH: 'off' });
    expect(rt.agents).not.toBeNull();
    expect(rt.dispatch).toBeNull();
    expect((await rt.app.request(worldApiPaths.agents)).status).toBe(200);
    const res = await rt.app.request(worldApiPaths.dispatchPolicy);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('dispatch_disabled');
  });

  it('closeStopped ends an open traced run as interrupted (inferred) and later deliveries are late', async () => {
    const rt = boot(tempDir('rt-stopped'));
    const repo = makeRepo('stopped');
    const lines = fixtureIn('s1-basic', repo);
    const first = lines.slice(0, 3);
    const t = Date.now() - 10_000;
    await ingest(rt, first.map((l, i) => ({ ...envelopeOf('s1-basic', l, i), observedAt: new Date(t + i).toISOString() })));
    const sessionId = String(first[0]!.input.session_id);
    const runId = rt.tracer!.closeStopped(sessionId);
    expect(runId).not.toBeNull();
    const run = rt.recorder.getRun(runId!)!;
    expect(run.status).toBe('interrupted');
    const events = rt.recorder.listAll(runId!);
    const done = events.find((e) => e.type === 'run.completed')!;
    expect(done.provenance).toBe('inferred');
    expect(JSON.stringify(done.payload)).toContain('Runloop stopped this dispatched session');
    expect(rt.tracer!.closeStopped(sessionId)).toBeNull();
    // A hook observed before the stop is a late delivery, not a new segment.
    await ingest(rt, [{ ...envelopeOf('s1-basic', lines[3]!, 3), observedAt: new Date(t + 5).toISOString() }]);
    expect(rt.recorder.listRuns().filter((r) => r.mode === 'traced')).toHaveLength(1);
  });
});
