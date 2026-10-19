/**
 * S3 on the real world host (plan §8): the agent layer submitting to
 * WorldHost over the same database, with a manual clock (the host's `now`
 * and the projector's timers) and `pump()` instead of the 50 ms timer.
 * P5 (residents untouched), P7 (paused world), restart (building survives,
 * agent offline), P8 on the world tables.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { canonicalJson } from '@runloop-world/town';
import type { WorldEvent } from '@runloop-world/events';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from '../src/agents/service';
import { Recorder } from '../src/recorder';
import { openDb, type Db } from '../src/store/db';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import { WorldHost, type TownFiles } from '../src/world/world-host';
import { comparable, envelopeOf, type FixtureLine } from './claude-code-helpers';
import { expectTruthful, fixtureIn, makeRepo } from './agents-rig';
import { REPO_ROOT, openRecorder, tempDir } from './helpers';
import { ManualClock } from './world-fakes';

const COMMONS = path.join(REPO_ROOT, 'worlds', 'runloop-commons');
function commonsFiles(): TownFiles {
  const interiors: Record<string, unknown> = {};
  for (const f of readdirSync(path.join(COMMONS, 'interiors')).sort()) {
    if (f.endsWith('.json')) interiors[f.slice(0, -5)] = JSON.parse(readFileSync(path.join(COMMONS, 'interiors', f), 'utf8'));
  }
  return { town: JSON.parse(readFileSync(path.join(COMMONS, 'town.json'), 'utf8')), interiors };
}
const TOWN = commonsFiles();
const SEED = 42;

interface World {
  dataDir: string;
  db: Db;
  host: WorldHost;
  recorder: Recorder;
  tracer: TraceSessionManager;
  agents: AgentService;
  close(): Promise<void>;
}

/** A runtime slice with the real world host (and, unless `bare`, the agent layer). */
async function world(clock: ManualClock, dataDir = tempDir('agents-world')): Promise<World> {
  const db = openDb(path.join(dataDir, 'runloop.db'));
  const recorder = new Recorder({ db, dataDir, now: () => new Date(clock.now()) });
  recorder.recoverInterrupted();
  const fail = (e: unknown) => {
    throw e;
  };
  const host = new WorldHost({ db, town: TOWN, now: () => clock.now(), seed: SEED, population: 80, tickMs: 0, onError: fail });
  host.start();
  const agents = new AgentService({ db, recorder, world: host, dataDir, ingestOn: true, clock, onError: fail, onRejected: (env, code) => fail(new Error(`${env.id} rejected: ${code}`)) });
  const tracer = new TraceSessionManager({ recorder, db, now: () => new Date(clock.now()), onError: fail, onSessionSeen: (s) => agents.onSessionSeen(s) });
  await agents.start();
  return {
    dataDir,
    db,
    host,
    recorder,
    tracer,
    agents,
    async close() {
      if (!db.isOpen) return;
      await agents.stop();
      await host.stop();
      db.close();
    },
  };
}

/** Move the clock in 50 ms steps, pumping every host (projector timers fire on the way). */
async function run(clock: ManualClock, ms: number, hosts: readonly WorldHost[], agents?: AgentService): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    clock.advance(Math.min(50, ms - t));
    for (const h of hosts) h.pump();
  }
  await agents?.projector.idle();
}

/**
 * Play fixture lines in-process (one delivery each), keeping wall time and the
 * worlds in step. `from` is the index of the first line (delivery ids are per index).
 */
async function play(clock: ManualClock, w: World, name: string, lines: readonly FixtureLine[], also: readonly WorldHost[] = [], from = 0): Promise<void> {
  let last = lines[0]!.t;
  for (const [i, line] of lines.entries()) {
    await run(clock, line.t - last, [w.host, ...also], w.agents);
    last = line.t;
    w.tracer.ingest([{ ...envelopeOf(name, line, from + i), observedAt: new Date(clock.now()).toISOString() }]);
    await run(clock, 0, [w.host, ...also], w.agents);
  }
  await run(clock, 3000, [w.host, ...also], w.agents);
}

/** Residents without the one field that holds a world seq (agent events take seqs too). */
const residentsOf = (h: WorldHost) => canonicalJson(h.snapshot().residents.map(({ lastDecisionSeq: _seq, ...r }) => r));
/** The simulation's own events without their seqs. */
const simulationLog = (h: WorldHost) => allEvents(h).filter((e) => e.prov === 'simulation').map(({ seq: _s, ...e }) => e);

function allEvents(h: WorldHost): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let after = 0; ; ) {
    const page = h.events({ after, limit: 1000 });
    out.push(...page.events);
    if (!page.hasMore) return out;
    after = page.nextAfter;
  }
}

const open: World[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) await w.close();
});

describe('S3 on the real world host', { timeout: 120_000 }, () => {
  it('P5: projecting s1-basic and s2-subagents leaves the residents identical to a control world', async () => {
    const clock = new ManualClock(Date.parse('2026-10-18T08:00:00Z'));
    const w = await world(clock);
    const control = await world(clock);
    open.push(w, control);
    const repo = makeRepo();
    const created = await w.agents.createAgent({ displayName: 'Acme House', lotId: 'lot_agent_1', workspace: { path: repo } });
    expect(created.ok).toBe(true);
    const agentId = created.ok ? created.agent.agentId : '';
    // Run both worlds at 16× so the residents make many decisions meanwhile.
    for (const h of [w.host, control.host]) expect(await h.submit({ id: 'fast', source: 'user', command: { type: 'clock.set', speed: 16 } })).toMatchObject({ ok: true });
    await run(clock, 1000, [w.host, control.host]);

    await play(clock, w, 's1-basic', fixtureIn('s1-basic', repo), [control.host]);
    await play(clock, w, 's2-subagents', fixtureIn('s2-subagents', repo), [control.host]);
    await run(clock, 60_000, [w.host, control.host], w.agents);

    expect(w.host.tick).toBe(control.host.tick);
    expect(w.host.tick).toBeGreaterThan(480 + 1000); // ~100 wall seconds at 16×
    const agentEvents = allEvents(w.host).filter((e) => e.type.startsWith('agent.'));
    expect(agentEvents.filter((e) => e.type === 'agent.session_changed')).toHaveLength(4);
    expect(allEvents(w.host).filter((e) => e.type === 'command.rejected')).toEqual([]);
    expectTruthful(agentEvents, w.recorder, (s) => w.agents.agentOfSession(s));
    expect(w.host.snapshot().agents.find((a) => a.agentId === agentId)).toMatchObject({ health: 'offline', activeRunId: null, buildingId: 'bld_agent_hq_1' });

    const decisions = simulationLog(control.host).filter((e) => e.type === 'resident.decided').length;
    expect(decisions).toBeGreaterThan(80);
    expect(residentsOf(w.host)).toBe(residentsOf(control.host));
    expect(simulationLog(w.host)).toEqual(simulationLog(control.host));
  });

  it('P7: with the world paused, ingest records the same run events as with no world; presence updates; the tick holds', async () => {
    const clock = new ManualClock(Date.parse('2026-10-18T08:00:00Z'));
    const w = await world(clock);
    open.push(w);
    const repo = makeRepo();
    const created = await w.agents.createAgent({ displayName: 'Acme House', lotId: 'lot_agent_2', workspace: { path: repo } });
    const agentId = created.ok ? created.agent.agentId : '';
    expect(await w.host.submit({ id: 'pause', source: 'user', command: { type: 'clock.set', speed: 0 } })).toMatchObject({ ok: true });
    const tick = w.host.tick;
    const lines = fixtureIn('s1-basic', repo);
    // Stop before SessionEnd so the presence shows the open session.
    await play(clock, w, 's1-basic', lines.slice(0, -2));
    expect(w.host.tick).toBe(tick);
    const p = w.host.snapshot().agents.find((a) => a.agentId === agentId)!;
    expect(p).toMatchObject({ health: 'live', execState: expect.any(String) });
    expect(p.activeRunId).not.toBeNull();
    await play(clock, w, 's1-basic', lines.slice(-2), [], lines.length - 2);
    await run(clock, 120_000, [w.host], w.agents);
    expect(w.host.tick).toBe(tick);
    expect(w.host.snapshot().agents.find((a) => a.agentId === agentId)).toMatchObject({ health: 'offline', activeRunId: null });

    // The run log equals the same deliveries through a tracer with no world and no agents.
    const { recorder, db } = openRecorder(tempDir('p7-control'));
    const bare = new TraceSessionManager({ recorder, db, onError: (e) => { throw e; } });
    lines.forEach((l, i) => bare.ingest([envelopeOf('s1-basic', l, i)]));
    const control = recorder.listRuns().map((r) => comparable(recorder.listAll(r.runId)));
    db.close();
    expect(w.recorder.listRuns().map((r) => comparable(w.recorder.listAll(r.runId)))).toEqual(control);
  });

  it('after a restart the building survives and the agent reads offline; the open session ends as inferred', async () => {
    const clock = new ManualClock(Date.parse('2026-10-18T08:00:00Z'));
    const w = await world(clock);
    const repo = makeRepo();
    const created = await w.agents.createAgent({ displayName: 'Acme House', lotId: 'lot_agent_4', workspace: { path: repo } });
    const agentId = created.ok ? created.agent.agentId : '';
    await play(clock, w, 'synthetic-no-session-end', fixtureIn('synthetic-no-session-end', repo));
    const live = w.host.snapshot().agents.find((a) => a.agentId === agentId)!;
    expect(live.health).toBe('live');
    const openRun = live.activeRunId!;
    await w.close();

    clock.advance(10 * 60_000);
    const again = await world(clock, w.dataDir);
    open.push(again);
    await run(clock, 2000, [again.host], again.agents);
    const p = again.host.snapshot().agents.find((a) => a.agentId === agentId)!;
    expect(p).toMatchObject({ health: 'offline', activeRunId: null, buildingId: 'bld_agent_hq_4', lotId: 'lot_agent_4', displayName: 'Acme House' });
    const log = allEvents(again.host);
    expect(log.filter((e) => e.type === 'agent.housed')).toHaveLength(1);
    expect(log.some((e) => e.type === 'world.resumed_after_offline')).toBe(true);
    const ended = log.find((e) => e.type === 'agent.session_changed' && e.p.runId === openRun && e.p.phase === 'ended')!;
    expect(ended).toMatchObject({ prov: 'inferred', p: { outcome: 'interrupted' } });
    expect(ended.obs).toBeUndefined();
    expect(again.agents.summary(agentId)).toMatchObject({ housed: true, health: 'offline', buildingId: 'bld_agent_hq_4' });
    expectTruthful(log.filter((e) => e.type.startsWith('agent.')), again.recorder, (s) => again.agents.agentOfSession(s));

    // P8 on the world's own tables, checkpoints included.
    const db = again.db;
    const real = repo;
    const rows = [
      JSON.stringify(db.prepare('SELECT world_id, town_id, content_hash, seed, tick, last_seq, created_at FROM worlds').all()),
      ...(db.prepare('SELECT body FROM world_events').all() as { body: string }[]).map((r) => r.body),
      ...(db.prepare('SELECT state_gz FROM world_checkpoints').all() as { state_gz: Uint8Array }[]).map((r) => gunzipSync(r.state_gz).toString('utf8')),
      JSON.stringify(again.host.snapshot()),
    ];
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.filter((r) => r.includes(real))).toEqual([]);
  });
});
