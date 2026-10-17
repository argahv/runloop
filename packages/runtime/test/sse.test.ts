import { apiPaths, type RunEvent } from '@runloop-world/events';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { streamRunEvents } from '../src/http/sse';
import type { Recorder } from '../src/recorder';
import { createRuntime, type Runtime } from '../src/runtime';
import { MANIFEST, REPO_ROOT, sseReader, tempDir } from './helpers';

const RUN = '44444444-4444-4444-8444-444444444444';
let rt: Runtime | null = null;

afterEach(async () => {
  await rt?.close();
  rt = null;
});

function setup(events: number): Runtime {
  rt = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('sse'), env: {}, pingMs: 50 });
  rt.recorder.createRun({ runId: RUN, manifest: MANIFEST });
  for (let i = 1; i < events; i++) tick(rt.recorder);
  return rt;
}

function tick(recorder: Recorder): RunEvent {
  return recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'working' } });
}

const ids = (frames: { id?: string }[]) => frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));

describe('SSE stream', () => {
  it('resumes after Last-Event-ID, then follows live events without duplicates or gaps, then ends', async () => {
    const { app, recorder } = setup(10);
    const res = await app.request(apiPaths.stream(RUN), { headers: { 'last-event-id': '4' } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const sse = sseReader(res);
    await sse.until((f) => ids(f).includes(10));
    tick(recorder);
    tick(recorder);
    await sse.until((f) => ids(f).includes(12));
    recorder.append(RUN, { type: 'run.completed', payload: { outcome: 'succeeded' } });
    const frames = await sse.until(() => false);
    expect(sse.done).toBe(true);
    expect(ids(frames)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const messages = frames.filter((f) => f.id !== undefined);
    expect(messages.every((f) => f.event === undefined)).toBe(true); // default "message" events
    expect(JSON.parse(messages[0]!.data!)).toMatchObject({ sequence: 5, runId: RUN });
    const end = frames.at(-1)!;
    expect(end.event).toBe('end');
    expect(JSON.parse(end.data!)).toEqual({ status: 'succeeded', lastSequence: 13 });
  });

  it('accepts ?after and rejects a malformed Last-Event-ID', async () => {
    const { app, recorder } = setup(5);
    recorder.append(RUN, { type: 'run.completed', payload: { outcome: 'failed' } });
    const frames = await sseReader(await app.request(`${apiPaths.stream(RUN)}?after=3`)).until(() => false);
    expect(ids(frames)).toEqual([4, 5, 6]);
    expect(frames.at(-1)?.event).toBe('end');
    expect((await app.request(apiPaths.stream(RUN), { headers: { 'last-event-id': 'abc' } })).status).toBe(400);
  });

  it('ends immediately for a terminal run that the client already has', async () => {
    const { app, recorder } = setup(3);
    recorder.append(RUN, { type: 'run.completed', payload: { outcome: 'stopped' } });
    const frames = await sseReader(await app.request(apiPaths.stream(RUN), { headers: { 'last-event-id': '4' } })).until(() => false);
    expect(ids(frames)).toEqual([]);
    expect(JSON.parse(frames.at(-1)!.data!)).toEqual({ status: 'stopped', lastSequence: 4 });
  });

  it('sends an event appended during the backfill exactly once', async () => {
    const { recorder } = setup(5);
    // Simulate the race: the event lands after subscribe() but before (or while) the DB is read,
    // so it is both in the backfill page and in the live queue.
    const racy = Object.create(recorder) as Recorder;
    let injected = false;
    racy.list = (runId, opts) => {
      if (!injected) {
        injected = true;
        tick(recorder);
      }
      return recorder.list(runId, opts);
    };
    const app = new Hono().get('/s', (c) => streamRunEvents(c, { recorder: racy, runId: RUN, after: 0, pingMs: 50 }));
    const sse = sseReader(await app.request('/s'));
    await sse.until((f) => ids(f).includes(6));
    tick(recorder);
    await sse.until((f) => ids(f).includes(7));
    await new Promise((r) => setTimeout(r, 120)); // let any duplicate arrive
    await sse.until(() => true);
    expect(ids(sse.frames)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await sse.cancel();
  });

  it('keeps an idle stream alive with ": ping" comments', async () => {
    const { app } = setup(1);
    const sse = sseReader(await app.request(apiPaths.stream(RUN)));
    const frames = await sse.until((f) => f.some((x) => x.comment === 'ping'));
    expect(ids(frames)).toEqual([1]);
    await sse.cancel();
  });
});
