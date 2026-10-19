/**
 * The world projector on a fake world host and a manual clock: commands,
 * keys, the activity rate limit, provenance, P4, restart and claims.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { WorldEvent } from '@runloop-world/events';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, openRecorder } from './helpers';
import { FIXTURE_CWD, expectTruthful, fixtureIn, makeRepo, makeRig, type Rig } from './agents-rig';

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

async function withAgent(r: Rig, repo: string, lotId = 'lot_agent_1') {
  const res = await r.agents.createAgent({ displayName: 'Engineering House', lotId, workspace: { path: repo } });
  if (!res.ok) throw new Error(`createAgent: ${res.code}`);
  await r.settle();
  return res.agent.agentId;
}

const kinds = (events: readonly WorldEvent[]) =>
  events.map((e) => {
    switch (e.type) {
      case 'agent.session_changed':
        return `session:${e.p.phase}`;
      case 'agent.connection_changed':
        return `connection:${e.p.health}/${e.p.attention}`;
      case 'agent.activity_observed':
        return 'activity';
      default:
        return e.type;
    }
  });

describe('WorldProjector', () => {
  it('projects a session inside the root: started, rate-limited activity, ended; truthful (P1, P4)', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    expect(kinds(rig.host.agentEvents(agentId))).toEqual(['agent.housed', 'connection:awaiting_first_event/none']);

    await rig.play('s1-basic', fixtureIn('s1-basic', repo));
    await rig.settle(5000);
    const events = rig.host.agentEvents(agentId);
    expect(rig.host.invalid).toEqual([]);
    expect(rig.rejected).toEqual([]);

    const k = kinds(events);
    expect(k.slice(0, 4)).toEqual(['agent.housed', 'connection:awaiting_first_event/none', 'session:started', 'activity']);
    expect(k).toContain('connection:live/none');
    expect(k).toContain('connection:live/permission_requested');
    expect(k.at(-2)).toBe('session:ended');
    expect(k.at(-1)).toBe('connection:offline/none');
    expect(k.filter((x) => x === 'session:started')).toHaveLength(1);

    // Keys: sess:<runId>:start:1, act:<runId>:<seqTo>, sess:<runId>:end.
    const runId = rig.recorder.listRuns()[0]!.runId;
    const ids = events.map((e) => e.cmdId);
    expect(ids).toContain(`house:${agentId}`);
    expect(ids).toContain(`sess:${runId}:start:1`);
    expect(ids).toContain(`sess:${runId}:end`);
    for (const e of events.filter((x) => x.type === 'agent.activity_observed')) expect(e.cmdId).toBe(`act:${runId}:${e.cause!.seqTo}`);

    // At most one activity per wall second per run.
    const times = events.filter((e) => e.type === 'agent.activity_observed').map((e) => rig!.host.submittedAt.get(e.cmdId!)!);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);

    // Provenance: housed by the user, connection by the system, the rest observed.
    expect(events[0]!.prov).toBe('user');
    for (const e of events.filter((x) => x.type === 'agent.connection_changed')) expect(e.prov).toBe('system');
    for (const e of events.filter((x) => x.type === 'agent.session_changed' || x.type === 'agent.activity_observed')) {
      expect(e.prov).toBe('external-agent');
      expect(e.obs).toBe('observed');
    }
    expectTruthful(events, rig.recorder, (s) => rig!.agents.agentOfSession(s));

    // The final presence equals the whole run.
    const all = rig.recorder.listAll(runId);
    const p = rig.host.presence(agentId)!;
    expect(p).toMatchObject({ activeRunId: null, execState: 'idle', health: 'offline', helpers: 0 });
    // The last activity covers every tool call (later events changed nothing it reports).
    const last = events.filter((e) => e.type === 'agent.activity_observed').at(-1)!;
    expect(last.cause).toMatchObject({ runId, seqFrom: 1 });
    expect(last.cause!.seqTo).toBeGreaterThanOrEqual(all.filter((e) => e.type === 'tool.call_started').at(-1)!.sequence);
    expect(p.counts).toEqual({ edit: 1, read: 2, test: 3 });
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(all.filter((e) => e.type === 'tool.call_started').length);
  });

  it('subagents show as helpers', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    await rig.play('s2-subagents', fixtureIn('s2-subagents', repo));
    await rig.settle(5000);
    expect(rig.host.invalid).toEqual([]);
    const acts = rig.host.agentEvents(agentId).filter((e) => e.type === 'agent.activity_observed');
    expect(Math.max(...acts.map((e) => (e.type === 'agent.activity_observed' ? e.p.helpers : 0)))).toBe(2);
    expect(acts.some((e) => e.type === 'agent.activity_observed' && e.p.counts.delegate === 2)).toBe(true);
    expectTruthful(rig.host.agentEvents(agentId), rig.recorder, (s) => rig!.agents.agentOfSession(s));
  });

  it('a run the idle sweep closes ends as inferred, citing the inferred close', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    await rig.play('synthetic-no-session-end', fixtureIn('synthetic-no-session-end', repo));
    await rig.settle(5000);
    expect(rig.host.presence(agentId)?.health).toBe('live');
    await rig.settle(6 * 60_000);
    expect(rig.host.presence(agentId)?.health).toBe('idle');

    rig.clock.advance(3 * 3600_000);
    rig.tracer.sweepIdle();
    await rig.settle(5000);
    const events = rig.host.agentEvents(agentId);
    const ended = events.find((e) => e.type === 'agent.session_changed' && e.p.phase === 'ended')!;
    expect(ended.prov).toBe('inferred');
    expect(ended.obs).toBeUndefined();
    const runId = rig.recorder.listRuns()[0]!.runId;
    const completed = rig.recorder.listAll(runId).find((e) => e.type === 'run.completed')!;
    expect(completed.provenance).toBe('inferred');
    expect(ended.cause).toEqual({ runId, seqFrom: completed.sequence, seqTo: completed.sequence });
    // The last activity cites the sweep's events only, so it is inferred too.
    const last = events.filter((e) => e.type === 'agent.activity_observed').at(-1)!;
    expect(last.prov).toBe('inferred');
    expect(last.cause!.seqTo).toBe(completed.sequence);
    expect(rig.host.presence(agentId)).toMatchObject({ activeRunId: null, health: 'offline' });
    expectTruthful(events, rig.recorder, (s) => rig!.agents.agentOfSession(s));
  });

  it('after a restart the open run ends (inferred), the building stays and the agent reads offline (P9)', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    const lines = fixtureIn('s1-basic', repo);
    await rig.play('s1-basic', lines.slice(0, 10));
    await rig.settle(2000);
    const before = rig.host.presence(agentId)!;
    expect(before.health).toBe('live');
    const runId = before.activeRunId!;
    expect(runId).toBeTruthy();

    // Crash: nothing is flushed or closed. Boot again on the same data dir and world.
    const { dataDir, clock } = rig;
    const host = rig.host.restart();
    const seqBefore = host.events.length;
    rig.crash();
    clock.advance(60_000);
    rig = await makeRig({ dataDir, clock, host });
    await rig.settle(0);
    await rig.settle(2000);
    const after = rig.host.presence(agentId)!;
    expect(after).toMatchObject({ activeRunId: null, health: 'offline', buildingId: 'bld_agent_hq_1' });
    const newEvents = rig.host.agentEvents(agentId).filter((e) => e.seq > seqBefore);
    expect(kinds(newEvents)).toEqual(['activity', 'session:ended', 'connection:offline/none']);
    const ended = newEvents.find((e) => e.type === 'agent.session_changed' && e.p.phase === 'ended')!;
    expect(ended.prov).toBe('inferred');
    expect(ended.type === 'agent.session_changed' && ended.p.outcome).toBe('interrupted');
    // Not housed twice.
    expect(rig.host.agentEvents(agentId).filter((e) => e.type === 'agent.housed')).toHaveLength(1);
    expect(rig.host.invalid).toEqual([]);
    expectTruthful(rig.host.agentEvents(agentId), rig.recorder, (s) => rig!.agents.agentOfSession(s));
    expect(rig.agents.summary(agentId)?.health).toBe('offline');
  });

  it('two sessions at once: the newest is shown, and the older one is shown again when it ends', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    const a = fixtureIn('s1-basic', repo, 'session-a');
    const b = fixtureIn('s2-subagents', repo, 'session-b');
    await rig.play('s1-basic', a.slice(0, 8));
    await rig.settle(2000);
    const runA = rig.host.presence(agentId)!.activeRunId!;
    await rig.play('s2-subagents', b);
    await rig.settle(2000);
    // B ended: A (still open) is shown again under a fresh id.
    const p = rig.host.presence(agentId)!;
    expect(p.activeRunId).toBe(runA);
    const resumed = rig.host.agentEvents(agentId).filter((e) => e.cmdId?.startsWith(`sess:${runA}:resume:`));
    expect(resumed).toHaveLength(1);
    await rig.play('s1-basic', a.slice(8));
    await rig.settle(5000);
    expect(rig.host.presence(agentId)).toMatchObject({ activeRunId: null, health: 'offline' });
    expect(rig.host.invalid).toEqual([]);
    expect(rig.rejected).toEqual([]);
    expectTruthful(rig.host.agentEvents(agentId), rig.recorder, (s) => rig!.agents.agentOfSession(s));
  });

  it('a session outside every root is an Arrival; claiming it replays its runs (backfill)', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    await rig.play('s1-basic', fixtureIn('s1-basic', FIXTURE_CWD));
    await rig.settle(5000);
    // Nothing reached the agent.
    expect(rig.host.agentEvents(agentId).map((e) => e.type)).toEqual(['agent.housed', 'agent.connection_changed']);
    const arrivals = rig.agents.arrivalList();
    expect(arrivals).toHaveLength(1);
    const sessionId = arrivals[0]!.sessionId;
    expect(arrivals[0]).toMatchObject({ projectLabel: 'demo', pathHint: '…/dev/demo', runIds: [expect.any(String)] });

    const res = rig.agents.claim(agentId, sessionId);
    expect(res.ok && res.backfilledRuns).toBe(1);
    await rig.settle(0);
    expect(rig.agents.arrivalList()).toEqual([]);
    const k = kinds(rig.host.agentEvents(agentId));
    expect(k).toEqual(['agent.housed', 'connection:awaiting_first_event/none', 'session:started', 'activity', 'session:ended', 'connection:offline/none']);
    expectTruthful(rig.host.agentEvents(agentId), rig.recorder, (s) => rig!.agents.agentOfSession(s));
    // Claimed twice: refused; the session is fixed to its agent.
    expect(rig.agents.claim(agentId, sessionId)).toMatchObject({ ok: false, status: 409, code: 'session_bound' });
    expect(rig.agents.summary(agentId)?.sessions[0]).toMatchObject({ sessionId, bindingMethod: 'claimed' });
  });

  it('never projects for an agent the world has not housed', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    // The world refuses this lot (another presence holds it), so the agent is rolled back.
    await rig.host.submit({
      id: 'house:other',
      source: 'system',
      command: { type: 'agent.house', agentId: 'agt_00000000-0000-4000-8000-000000000001', lotId: 'lot_agent_2', displayName: 'Other', hue: '#5aa9f5' },
    });
    const res = await rig.agents.createAgent({ displayName: 'Mine', lotId: 'lot_agent_2', workspace: { path: repo } });
    expect(res).toMatchObject({ ok: false, status: 409, code: 'lot_unavailable' });
    expect(rig.agents.list()).toEqual([]);
    const unknown = await rig.agents.createAgent({ displayName: 'Mine', lotId: 'lot_nowhere', workspace: { path: repo } });
    expect(unknown).toMatchObject({ ok: false, status: 404, code: 'unknown_entity' });
    // The folder is free again, and its sessions are Arrivals.
    await rig.play('s1-basic', fixtureIn('s1-basic', repo));
    await rig.settle(5000);
    expect(rig.host.events.filter((e) => e.type === 'agent.session_changed')).toEqual([]);
    expect(rig.agents.arrivalList()).toHaveLength(1);
  });

  it('P11: the projector and the world code never import dispatch', () => {
    const dir = path.join(REPO_ROOT, 'packages', 'runtime', 'src', 'world');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files).toContain('projector.ts');
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      const imports = [...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
      expect(imports.filter((i) => /dispatch/.test(i!)), f).toEqual([]);
    }
  });

  it('house is resubmitted at boot for an agent left unhoused, with the same id', async () => {
    rig = await makeRig();
    const repo = makeRepo();
    const agentId = await withAgent(rig, repo);
    const { dataDir, clock } = rig;
    const host = rig.host.restart();
    rig.crash();
    // Simulate a crash between the world's answer and `housed = 1`.
    const { db } = openRecorder(dataDir);
    db.prepare('UPDATE agents SET housed = 0 WHERE agent_id = ?').run(agentId);
    db.close();
    rig = await makeRig({ dataDir, clock, host });
    expect(rig.agents.summary(agentId)?.housed).toBe(true);
    expect(rig.host.agentEvents(agentId).filter((e) => e.type === 'agent.housed')).toHaveLength(1);
  });
});
