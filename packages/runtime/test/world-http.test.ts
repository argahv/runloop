/**
 * World API (plan §4.5, §8 S1): routes, the strict command body (P2), the
 * world switch, and the SSE stream: folding it reproduces the server's state
 * hash, a reconnect leaves no gap, and a client far behind gets a snapshot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORLD_STREAM_RESNAPSHOT,
  WorldClockFrameSchema,
  WorldEventsFrameSchema,
  WorldSnapshotSchema,
  apiPaths,
  worldApiPaths,
  type WorldEvent,
  type WorldInfoResponse,
} from '@runloop-world/events';
import { applyEvent, hashState, type SimState } from '@runloop-world/sim';
import { createRuntime, type Runtime } from '../src/runtime';
import { REPO_ROOT, sseReader, tempDir, type SseFrame } from './helpers';

let rt: Runtime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

const T0 = Date.parse('2026-10-18T10:00:00Z');

function setup(env: NodeJS.ProcessEnv = {}) {
  const clock = { t: T0 };
  rt = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('world-http'), env, world: { seed: 42, now: () => clock.t, tickMs: 0 } });
  return { rt, app: rt.app, host: rt.world, clock };
}

const post = (app: Runtime['app'], body: unknown, headers: Record<string, string> = {}) =>
  app.request(worldApiPaths.commands, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Run the world forward `ms` of fake time (pump every 250 ms so batches commit). */
function advance(host: NonNullable<Runtime['world']>, clock: { t: number }, ms: number): void {
  for (let done = 0; done < ms; done += 250) {
    clock.t += 250;
    host.pump();
  }
}

describe('world routes', () => {
  it('serves info, town, snapshot, events and explanations', async () => {
    const { app, host, clock } = setup();
    host!.start();
    advance(host!, clock, 5_000);
    const info = (await (await app.request(worldApiPaths.world)).json()) as WorldInfoResponse;
    expect(info).toMatchObject({ worldId: 'runloop-commons', townId: 'runloop-commons', seed: 42, population: 80, speed: 1 });
    const town = (await (await app.request(worldApiPaths.town)).json()) as { contentHash: string; interiors: Record<string, unknown> };
    expect(town.contentHash).toBe(info.contentHash);
    expect(Object.keys(town.interiors)).toContain('cafe');
    const snap = WorldSnapshotSchema.parse(await (await app.request(worldApiPaths.snapshot)).json());
    expect(snap.seq).toBe(host!.seq);

    const page = (await (await app.request(`${worldApiPaths.events}?after=0&limit=5`)).json()) as { events: WorldEvent[]; nextAfter: number; hasMore: boolean };
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page).toMatchObject({ nextAfter: 5, hasMore: true });
    const mine = (await (await app.request(`${worldApiPaths.events}?actor=res_0012&type=resident.decided`)).json()) as { events: WorldEvent[] };
    expect(mine.events.length).toBeGreaterThan(0);
    expect(mine.events.every((e) => e.actor === 'res_0012' && e.type === 'resident.decided')).toBe(true);
    const system = (await (await app.request(`${worldApiPaths.events}?prov=system`)).json()) as { events: WorldEvent[] };
    expect(system.events.map((e) => e.type)).toEqual(['world.created']);
    expect((await app.request(`${worldApiPaths.events}?limit=0`)).status).toBe(400);

    const why = await app.request(`${worldApiPaths.explain}?ref=resident:res_0012`);
    expect(why.status).toBe(200);
    const { explanation } = (await why.json()) as { explanation: { subject: unknown; atSeq: number; label: string } };
    expect(explanation).toMatchObject({ subject: { kind: 'resident', id: 'res_0012' }, label: 'Simulated resident · rule-based decision' });
    expect(explanation.atSeq).toBe(mine.events.at(-1)!.seq);
    const atStart = (await (await app.request(`${worldApiPaths.explain}?ref=resident:res_0012&atSeq=${mine.events[0]!.seq}`)).json()) as { explanation: { atSeq: number } };
    expect(atStart.explanation.atSeq).toBe(mine.events[0]!.seq);
    expect((await app.request(`${worldApiPaths.explain}?ref=resident:res_9999`)).status).toBe(404);
    expect((await app.request(`${worldApiPaths.explain}?ref=agent:agt_x`)).status).toBe(400);
  });

  it('takes commands as {id, command} only, always from the user (P2)', async () => {
    const { app, host } = setup();
    const ok = await post(app, { id: 'speed:4', command: { type: 'clock.set', speed: 4 } });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ ok: true, seq: host!.seq });
    expect(host!.snapshot().speed).toBe(4);
    // A body naming its own source or provenance is refused outright.
    expect((await post(app, { id: 'x1', source: 'system', command: { type: 'clock.set', speed: 1 } })).status).toBe(400);
    expect((await post(app, { id: 'x2', prov: 'system', command: { type: 'clock.set', speed: 1 } })).status).toBe(400);
    expect((await post(app, { id: 'x3', command: { type: 'clock.set', speed: 3 } })).status).toBe(400);
    expect(host!.snapshot().speed).toBe(4);
    // An HTTP command that only the system may send is rejected (and logged) as forbidden.
    const forbidden = await post(app, { id: 'conn', command: { type: 'agent.connection', agentId: 'agt_5f1c2a8e-3b4d-4c6e-9a7b-1d2e3f405a61', health: 'live', attention: 'none' } });
    expect(forbidden.status).toBe(202);
    expect(await forbidden.json()).toEqual({ ok: false, code: 'forbidden_source' });
    // The app's guards apply: JSON only, allowed origins only.
    expect((await app.request(worldApiPaths.commands, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post(app, { id: 'evil', command: { type: 'clock.set', speed: 0 } }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(host!.snapshot().speed).toBe(4);
  });

  it('answers 404 world_disabled everywhere when RUNLOOP_WORLD=off, and the rest of the API still works', async () => {
    const { app, rt: r } = setup({ RUNLOOP_WORLD: 'off' });
    expect(r.world).toBeNull();
    for (const p of [worldApiPaths.world, worldApiPaths.snapshot, worldApiPaths.stream, worldApiPaths.events]) {
      const res = await app.request(p);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'world_disabled' });
    }
    expect((await post(app, { id: 'c', command: { type: 'clock.set', speed: 0 } })).status).toBe(404);
    expect((await app.request(apiPaths.health)).status).toBe(200);
    expect(r.db.prepare('SELECT COUNT(*) AS n FROM worlds').get()).toEqual({ n: 0 });
  });
});

/** Fold a stream's frames: the latest snapshot, then every event batch after it. */
function fold(frames: readonly SseFrame[], into: SimState | null = null): { state: SimState | null; lastId: number } {
  let state = into;
  let lastId = state?.seq ?? 0;
  for (const f of frames) {
    if (f.event === 'snapshot') {
      state = WorldSnapshotSchema.parse(JSON.parse(f.data!));
      lastId = state.seq;
    } else if (f.event === undefined && f.data) {
      const { events } = WorldEventsFrameSchema.parse(JSON.parse(f.data));
      for (const e of events) {
        expect(e.seq).toBe(lastId + 1); // no gap, no duplicate
        state = applyEvent(state, e);
        lastId = e.seq;
      }
      expect(Number(f.id)).toBe(lastId);
    }
  }
  return { state, lastId };
}

describe('world stream (SSE)', () => {
  it('sends a snapshot, then committed batches and clock frames; folding them gives the server’s state hash', async () => {
    const { app, host, clock } = setup();
    host!.start();
    const sse = sseReader(await app.request(worldApiPaths.stream));
    await sse.until((f) => f.some((x) => x.event === 'snapshot'));
    advance(host!, clock, 20_000);
    await post(app, { id: 'pause', command: { type: 'clock.set', speed: 0 } });
    const frames = await sse.until((f) => f.some((x) => x.id === String(host!.seq)));
    expect(frames[0]!.event).toBe('snapshot');
    const clocks = frames.filter((f) => f.event === 'clock').map((f) => WorldClockFrameSchema.parse(JSON.parse(f.data!)));
    expect(clocks.length).toBeGreaterThan(0);
    const { state } = fold(frames);
    expect(hashState(state!)).toBe(host!.stateHash());
    await sse.cancel();
  });

  it('resumes after Last-Event-ID without a gap, and sends a snapshot to a client too far behind', async () => {
    const { app, host, clock } = setup();
    host!.start();
    await post(app, { id: 'fast', command: { type: 'clock.set', speed: 16 } });
    const first = sseReader(await app.request(worldApiPaths.stream));
    advance(host!, clock, 5_000);
    const seen = await first.until((f) => f.some((x) => x.id === String(host!.seq)));
    const part = fold(seen);
    await first.cancel();
    // Missed while away.
    advance(host!, clock, 5_000);
    const again = sseReader(await app.request(worldApiPaths.stream, { headers: { 'last-event-id': String(part.lastId) } }));
    const rest = await again.until((f) => f.some((x) => x.id === String(host!.seq)));
    expect(rest.some((f) => f.event === 'snapshot')).toBe(false);
    const firstEvents = WorldEventsFrameSchema.parse(JSON.parse(rest.find((f) => f.event === undefined && f.data)!.data!));
    expect(firstEvents.events[0]!.seq).toBe(part.lastId + 1);
    const done = fold(rest, part.state);
    expect(done.lastId).toBe(host!.seq);
    expect(hashState(done.state!)).toBe(host!.stateHash());
    await again.cancel();

    // More than 5 000 events behind: a fresh snapshot instead of a backfill.
    while (host!.seq < WORLD_STREAM_RESNAPSHOT + 100) advance(host!, clock, 10_000);
    const late = sseReader(await app.request(worldApiPaths.stream, { headers: { 'last-event-id': '1' } }));
    const lateFrames = await late.until((f) => f.some((x) => x.event === 'snapshot'));
    expect(lateFrames.find((f) => f.id !== undefined)!.event).toBe('snapshot');
    await late.cancel();
  }, 30_000);
});
