/**
 * The world host (plan §4.1, §8 S1): fake-clock tick math, commands,
 * persistence across a restart, checkpoints, and resuming after a SIGKILL at
 * the last flushed seq.
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorldEvent, type CommandEnvelope, type WorldEvent } from '@runloop-world/events';
import { WorldReplay, hashState } from '@runloop-world/sim';
import { openDb, type Db } from '../src/store/db';
import { readTownFiles } from '../src/world/town-files';
import { PRUNE_EVENTS_SQL } from '../src/world/world-store';
import { DAY_TICKS, MAX_TICKS_PER_WAKE, WorldHost, type WorldHostOptions } from '../src/world/world-host';
import { REPO_ROOT, tempDir } from './helpers';

const TOWN = readTownFiles(path.join(REPO_ROOT, 'worlds'));
const T0 = Date.parse('2026-10-18T10:00:00Z');
const hosts: WorldHost[] = [];
const dbs: Db[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dbs.splice(0)) d.close();
});

function setup(opts: Partial<WorldHostOptions> & { file?: string; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: T0 };
  const db = openDb(opts.file ?? ':memory:');
  dbs.push(db);
  const host = new WorldHost({ db, town: TOWN, now: () => clock.t, seed: 42, tickMs: 0, ...opts });
  hosts.push(host);
  return { db, host, clock };
}

const clock = (id: string, speed: 0 | 1 | 4 | 16): CommandEnvelope => ({ id, source: 'user', command: { type: 'clock.set', speed } });

/** Advance the fake clock in steps of `stepMs`, pumping after each. */
function advance(host: WorldHost, c: { t: number }, ms: number, stepMs = 50): void {
  for (let done = 0; done < ms; done += stepMs) {
    c.t += Math.min(stepMs, ms - done);
    host.pump();
  }
}

const allEvents = (db: Db): WorldEvent[] =>
  (db.prepare('SELECT body FROM world_events ORDER BY seq').all() as { body: string }[]).map((r) => JSON.parse(r.body) as WorldEvent);

describe('WorldHost: a new world', () => {
  it('creates Runloop Commons at Day 1 08:00, commits its events and publishes them only after the commit', () => {
    const { host, db } = setup();
    const info = host.info();
    expect(info).toMatchObject({ townId: 'runloop-commons', seed: 42, tick: 480, speed: 1, prevSpeed: 1, population: 80, simVersion: 1, lagging: false });
    // Every world created is told apart (a stream client of an earlier world must not resume into this one).
    expect(info.worldId).toMatch(/^runloop-commons-[0-9a-f]{8}$/);
    expect(setup().host.worldId).not.toBe(info.worldId);
    const events = allEvents(db);
    expect(events[0]!.type).toBe('world.created');
    expect(events.filter((e) => e.type === 'resident.decided')).toHaveLength(80);
    for (const e of events) expect(parseWorldEvent(e).ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_checkpoints').get()).toEqual({ n: 1 });

    const published: number[] = [];
    host.subscribe((batch) => {
      // Already committed when published.
      const max = (db.prepare('SELECT MAX(seq) AS s FROM world_events').get() as { s: number }).s;
      for (const e of batch) {
        expect(e.seq).toBeLessThanOrEqual(max);
        published.push(e.seq);
      }
    });
    host.start();
    advance(host, { t: T0 }, 0);
  });
});

describe('WorldHost: the clock (fake time)', () => {
  it('runs exactly 40 ticks in 10 s at 4×, holds the tick while paused and resumes at the previous speed', async () => {
    const { host, clock: c } = setup();
    host.start();
    expect(await host.submit(clock('c1', 4))).toMatchObject({ ok: true });
    const t0 = host.tick;
    advance(host, c, 10_000);
    expect(host.tick - t0).toBe(40);
    // Paused: time passes, the tick holds.
    await host.submit(clock('c2', 0));
    expect(host.snapshot()).toMatchObject({ speed: 0, prevSpeed: 4 });
    advance(host, c, 30_000);
    expect(host.tick - t0).toBe(40);
    // Resume with the previous speed (what Studio's ▶ sends).
    await host.submit(clock('c3', host.snapshot().prevSpeed));
    expect(host.snapshot()).toMatchObject({ speed: 4, prevSpeed: 4 });
    advance(host, c, 2_500);
    expect(host.tick - t0).toBe(50);
  });

  it('counts whole sim minutes at 1× and never runs a tick early', () => {
    const { host, clock: c } = setup();
    host.start();
    const t0 = host.tick;
    advance(host, c, 999, 333);
    expect(host.tick).toBe(t0);
    advance(host, c, 1, 1);
    expect(host.tick).toBe(t0 + 1);
  });

  it('runs at most 40 ticks per wake and drops the rest (lagging) instead of catching up', async () => {
    const { host, clock: c } = setup();
    host.start();
    await host.submit(clock('fast', 16));
    const t0 = host.tick;
    c.t += 10_000; // 160 ticks due at once
    host.pump();
    expect(host.tick - t0).toBe(MAX_TICKS_PER_WAKE);
    expect(host.info().lagging).toBe(true);
    expect(host.lagMs()).toBe(Math.round(((160 - 40) * 1000) / 16));
    host.pump(); // re-anchored: nothing more is due now
    expect(host.tick - t0).toBe(MAX_TICKS_PER_WAKE);
    advance(host, c, 1_000);
    expect(host.tick - t0).toBe(MAX_TICKS_PER_WAKE + 16);
    expect(host.info().lagging).toBe(false);
  });
});

describe('WorldHost: commands', () => {
  it('applies a command once (resubmitting returns the first outcome) and logs rejections with their source', async () => {
    const { host, db } = setup();
    host.start();
    const first = await host.submit(clock('same-id', 4));
    expect(await host.submit(clock('same-id', 16))).toEqual(first);
    expect(host.snapshot().speed).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM world_events WHERE cmd_id = 'same-id'").get()).toEqual({ n: 1 });

    // A forbidden source is logged, even when the envelope is incomplete (no cause) (P3).
    const forbidden = await host.submit({
      id: 'sess:user',
      source: 'user',
      command: { type: 'agent.session', agentId: 'agt_5f1c2a8e-3b4d-4c6e-9a7b-1d2e3f405a61', runId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', phase: 'started' },
    });
    expect(forbidden).toEqual({ ok: false, code: 'forbidden_source' });
    expect(allEvents(db).at(-1)).toMatchObject({ type: 'command.rejected', prov: 'user', cmdId: 'sess:user' });
    // A malformed envelope from an allowed source is refused without being logged.
    const before = host.seq;
    expect(await host.submit({ id: 'bad', source: 'user', command: { type: 'clock.set', speed: 3 } } as never)).toEqual({ ok: false, code: 'invalid' });
    expect(host.seq).toBe(before);
  });

  it('closing a building sends walkers elsewhere at the current tick (dest_closed)', async () => {
    const { host, clock: c } = setup();
    host.start();
    // 08:00 rush: someone is walking somewhere; close where they are going.
    advance(host, c, 2_000);
    const doorOf = (r: { motion: { path: [number, number][] } | null }) => {
      const end = r.motion?.path.at(-1);
      return end ? host.town.doorAt.get(end[1] * host.town.width + end[0]) : undefined;
    };
    const walker = host.snapshot().residents.find((r) => doorOf(r) && host.town.buildingById.get(doorOf(r)!)!.def.access !== 'residents')!;
    const target = doorOf(walker);
    expect(target).toBeDefined();
    const tick = host.tick;
    const res = await host.submit({ id: 'close', source: 'user', command: { type: 'building.set_open', buildingId: target!, open: false } });
    expect(res).toMatchObject({ ok: true, tick });
    const page = host.events({ after: res.ok ? res.seq : 0, limit: 1000 }).events;
    expect(page.some((e) => e.type === 'resident.decided' && e.p.r === walker.idx && e.p.reason === 'dest_closed' && e.tick === tick)).toBe(true);
  });
});

describe('WorldHost: persistence', () => {
  it('restarts with the same residents, town, seed and tick, and appends world.resumed_after_offline', async () => {
    const file = path.join(tempDir('world'), 'runloop.db');
    const c = { t: T0 };
    const a = setup({ file, clock: c });
    a.host.start();
    await a.host.submit(clock('c', 16));
    advance(a.host, c, 20_000, 1_000);
    const before = a.host.snapshot();
    const tick = a.host.tick;
    await a.host.stop();
    c.t += 3_600_000; // an hour offline
    const b = setup({ file, clock: c, seed: 999, town: { town: { not: 'a town' }, interiors: {} } });
    expect(b.host.seed).toBe(42); // the stored world wins over options and files
    expect(b.host.worldId).toBe(a.host.worldId);
    expect(b.host.town.contentHash).toBe(a.host.town.contentHash);
    expect(b.host.tick).toBe(tick);
    const after = b.host.snapshot();
    expect(after.residents.map((r) => [r.id, r.name, r.role, r.homeId])).toEqual(before.residents.map((r) => [r.id, r.name, r.role, r.homeId]));
    expect(after.seq).toBe(before.seq + 1);
    const resumed = allEvents(b.db).at(-1)!;
    expect(resumed).toMatchObject({ type: 'world.resumed_after_offline', prov: 'system', tick, p: { offlineWallMs: 3_600_000 } });
    // Apart from the resume event, nothing changed.
    expect(hashState({ ...after, seq: before.seq, tick: before.tick })).toBe(hashState(before));
    // And it keeps going at the stored speed.
    b.host.start();
    advance(b.host, c, 1_000);
    expect(b.host.tick).toBe(tick + 16);
  });

  it('boots from the latest checkpoint plus the tail, equal to a fold of the whole log; checkpoints at sim midnight', async () => {
    const file = path.join(tempDir('world'), 'runloop.db');
    const c = { t: T0 };
    const a = setup({ file, clock: c });
    a.host.start();
    await a.host.submit(clock('c', 16));
    advance(a.host, c, ((24 * 60 - 480 + 30) / 16) * 1000, 2_500); // past midnight
    const cps = a.db.prepare('SELECT seq, tick FROM world_checkpoints ORDER BY seq').all() as { seq: number; tick: number }[];
    expect(cps.some((cp) => cp.tick === 1440)).toBe(true);
    a.host.flush();
    const events = allEvents(a.db);
    const fold = new WorldReplay(events, [], a.host.town).stateAt(events.at(-1)!.seq);
    expect(hashState(fold)).toBe(a.host.stateHash());
    // Simulate a crash: no stop, no final checkpoint.
    hosts.splice(hosts.indexOf(a.host), 1);
    const b = setup({ file, clock: c });
    const resumed = b.host.snapshot();
    expect(hashState({ ...resumed, seq: fold.seq, tick: fold.tick })).toBe(hashState(fold));
  });

  it('records a new sim version on boot (world.sim_upgraded)', async () => {
    const file = path.join(tempDir('world'), 'runloop.db');
    const a = setup({ file });
    await a.host.stop();
    a.db.prepare('UPDATE worlds SET sim_version = 2').run();
    const b = setup({ file });
    expect(allEvents(b.db).slice(-2).map((e) => e.type)).toEqual(['world.resumed_after_offline', 'world.sim_upgraded']);
    expect(allEvents(b.db).at(-1)).toMatchObject({ p: { fromVersion: 2, toVersion: 1 } });
  });

  it('after a SIGKILL, resumes at the last flushed seq with no gap', async () => {
    const file = path.join(tempDir('world-kill'), 'runloop.db');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.join(import.meta.dirname, 'world-child.ts'), file], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('ready') && resolve());
      child.once('exit', (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    // Let it run and flush a few batches, then kill it mid-flight.
    const peek = new DatabaseSync(file, { readOnly: true });
    const lastSeq = () => (peek.prepare('SELECT last_seq FROM worlds').get() as { last_seq: number }).last_seq;
    const start = lastSeq();
    const deadline = Date.now() + 15_000;
    while (lastSeq() < start + 150 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const flushed = lastSeq();
    const max = (peek.prepare('SELECT MAX(seq) AS s, COUNT(*) AS n FROM world_events').get() as { s: number; n: number });
    peek.close();
    expect(flushed).toBeGreaterThan(start);
    expect(max).toEqual({ s: flushed, n: flushed }); // events and clock committed together, no gap

    const b = setup({ file, clock: { t: Date.now() } });
    expect(b.host.seq).toBe(flushed + 1);
    const events = allEvents(b.db);
    expect(events.at(-1)).toMatchObject({ seq: flushed + 1, type: 'world.resumed_after_offline' });
    const fold = new WorldReplay(events.slice(0, -1), [], b.host.town).stateAt(flushed);
    expect(hashState({ ...b.host.snapshot(), seq: flushed, tick: fold.tick })).toBe(hashState(fold));
  }, 30_000);
});

describe('WorldHost: retention and storage (plan §4.1, §12 database growth)', () => {
  it('keeps the log bounded over sim days: short-lived events, interactions too, go after 3 sim days; the world still boots', async () => {
    const file = path.join(tempDir('world-retention'), 'runloop.db');
    const c = { t: T0 };
    const { host, db } = setup({ file, clock: c });
    host.start();
    await host.submit(clock('fast', 16));
    const dayMs = (DAY_TICKS * 1000) / 16; // one sim day of wall time at 16×
    const count = (where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM world_events WHERE ${where}`).get() as { n: number }).n;
    const pages = () => (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const days: { rows: number; pages: number; interactions: number; kept: number }[] = [];
    for (let d = 0; d < 8; d++) {
      advance(host, c, dayMs, 2_500); // 40 ticks per wake: on time, nothing dropped
      host.flush();
      days.push({ rows: count(), pages: pages(), interactions: count("type = 'interaction.happened'"), kept: count('ambient = 0') });
      // Nothing short-lived older than 3 sim days survives the last midnight's prune (plus the day since).
      expect(count(`ambient = 1 AND tick < ${host.tick - 4 * DAY_TICKS}`)).toBe(0);
    }
    // Interactions happen, and are pruned like the ambient events (their effect lives on in affinity).
    expect(days[2]!.interactions).toBeGreaterThan(0);
    expect(count(`type = 'interaction.happened' AND ambient = 0`)).toBe(0);
    expect(count(`type = 'interaction.happened' AND tick < ${host.tick - 4 * DAY_TICKS}`)).toBe(0);
    // Steady state from day 5 on: the row count and the file stop growing.
    expect(days[7]!.rows).toBeLessThanOrEqual(days[4]!.rows * 1.15);
    expect(days[7]!.pages).toBeLessThanOrEqual(days[4]!.pages * 1.15);
    // What is kept for good is only the few user and system events.
    expect(days[7]!.kept).toBeLessThan(20);
    // The prune reaches the rows it deletes through the index, not a scan of all history.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${PRUNE_EVENTS_SQL}`).all('w', 0, 0) as { detail: string }[]).map((r) => r.detail).join(' ');
    expect(plan).toMatch(/USING INDEX world_events_prunable \(world_id=\? AND ambient=\? AND tick<\?\)/);
    // Retention never breaks a boot: the next host folds the latest checkpoint plus the kept tail.
    const hash = host.stateHash();
    await host.stop();
    const b = setup({ file, clock: c });
    const resumed = b.host.snapshot();
    expect(hashState({ ...resumed, seq: resumed.seq - 1 })).toBe(hash);
  }, 60_000);
});
