import { apiPaths, type EventsPageResponse, type RunDetailResponse } from '@runloop-world/events';
import { parseWorldDefinition } from '@runloop-world/world-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli';
import { isLoopbackAddress } from '../src/http/app';
import { createRuntime, type Runtime } from '../src/runtime';
import { MANIFEST, REPO_ROOT, openRecorder, tempDir } from './helpers';

const JSON_HEADERS = { 'content-type': 'application/json' };
let rt: Runtime | null = null;

afterEach(async () => {
  await rt?.close();
  rt = null;
});

function runtime(dataDir = tempDir('http')): Runtime {
  rt = createRuntime({ repoRoot: REPO_ROOT, dataDir, env: {}, pingMs: 50 });
  return rt;
}

function post(path: string, body: unknown = {}, headers: Record<string, string> = JSON_HEADERS) {
  return rt!.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('HTTP API', () => {
  it('serves health', async () => {
    const { app } = runtime();
    const res = await app.request(apiPaths.health);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String), activeRunId: null });
  });

  it('only answers for localhost hosts (any port)', async () => {
    const { app } = runtime();
    expect((await app.request(apiPaths.health, { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await app.request(apiPaths.health, { headers: { host: 'localhost.evil.example:4317' } })).status).toBe(403);
    expect((await app.request(apiPaths.health, { headers: { host: '127.0.0.1:4317' } })).status).toBe(200);
    expect((await app.request(apiPaths.health, { headers: { host: 'localhost:9999' } })).status).toBe(200);
  });

  it('refuses connections from non-loopback peers, even with a spoofed localhost Host', async () => {
    const { app } = runtime();
    const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
    const spoofed = { headers: { host: 'localhost' } };
    expect((await app.request(apiPaths.health, spoofed, peer('192.0.2.2'))).status).toBe(403);
    expect((await app.request(apiPaths.health, spoofed, peer('::ffff:10.0.0.7'))).status).toBe(403);
    for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await app.request(apiPaths.health, spoofed, peer(local))).status).toBe(200);
    }
  });

  it('isLoopbackAddress accepts only loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ['0.0.0.0', '192.168.1.2', '::', '::ffff:10.0.0.1', 'localhost.evil', '1127.0.0.1']) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
  });

  it('the CLI refuses to listen on a non-loopback host', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a.join(' ')));
    try {
      expect(await main(['serve', '--host', '0.0.0.0', '--port', '0'])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(String(errors[0])).toContain('loopback');
  });

  it('sends CORS headers only to allowed origins', async () => {
    const { app } = runtime();
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      const res = await app.request(apiPaths.runs, { headers: { origin } });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const evil = await app.request(apiPaths.runs, { headers: { origin: 'http://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await app.request(apiPaths.runs, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('honours RUNLOOP_ALLOWED_ORIGINS', async () => {
    rt = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('http'), env: { RUNLOOP_ALLOWED_ORIGINS: 'http://localhost:5173' } });
    const res = await rt.app.request(apiPaths.runs, { headers: { origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('guards POSTs: JSON only (415), allowed Origin only (403), valid body (400), known mission (404)', async () => {
    runtime();
    expect((await post(apiPaths.runs, { missionId: 'coding-mission' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await rt!.app.request(apiPaths.runs, { method: 'POST' })).status).toBe(415);
    expect((await post(apiPaths.runs, { missionId: 'coding-mission' }, { ...JSON_HEADERS, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(apiPaths.runs, {})).status).toBe(400);
    expect((await post(apiPaths.runs, { missionId: 'coding-mission', speed: -1 })).status).toBe(400);
    expect((await rt!.app.request(apiPaths.runs, { method: 'POST', headers: JSON_HEADERS, body: '{nope' })).status).toBe(400);
    expect((await post(apiPaths.runs, { missionId: 'no-such-mission' })).status).toBe(404);
    expect((await post(apiPaths.runs, { missionId: '../etc' })).status).toBe(404);
    expect(rt!.recorder.listRuns()).toEqual([]);
  });

  it('starts a run (202), rejects a second one (409), and serves run, events and artifacts', { timeout: 30_000 }, async () => {
    const { app, manager } = runtime();
    const res = await post(apiPaths.runs, { missionId: 'coding-mission', speed: 0 }, { ...JSON_HEADERS, origin: 'http://localhost:3000' });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect((await post(apiPaths.runs, { missionId: 'coding-mission', speed: 0 })).status).toBe(409);
    expect(((await (await app.request(apiPaths.health)).json()) as { activeRunId: string }).activeRunId).toBe(runId);

    await manager.whenDone(runId);

    const list = (await (await app.request(apiPaths.runs)).json()) as { runs: { runId: string; status: string }[] };
    expect(list.runs).toEqual([expect.objectContaining({ runId, status: 'succeeded', lastSequence: 58, paused: false })]);

    const detail = (await (await app.request(apiPaths.run(runId))).json()) as RunDetailResponse;
    expect(detail.run).toMatchObject({ runId, missionId: 'coding-mission', worldId: 'research-campus' });
    expect(parseWorldDefinition(detail.world).id).toBe('research-campus');

    const page1 = (await (await app.request(`${apiPaths.events(runId)}?after=0&limit=10`)).json()) as EventsPageResponse;
    expect(page1.events.map((e) => (e as { sequence: number }).sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(page1).toMatchObject({ nextAfter: 10, hasMore: true });
    const page2 = (await (await app.request(`${apiPaths.events(runId)}?after=50&limit=100`)).json()) as EventsPageResponse;
    expect(page2.events).toHaveLength(8);
    expect(page2).toMatchObject({ nextAfter: 58, hasMore: false });
    const empty = (await (await app.request(`${apiPaths.events(runId)}?after=58`)).json()) as EventsPageResponse;
    expect(empty).toEqual({ events: [], nextAfter: 58, hasMore: false });
    expect((await app.request(`${apiPaths.events(runId)}?after=-1`)).status).toBe(400);
    expect((await app.request(`${apiPaths.events(runId)}?limit=abc`)).status).toBe(400);

    const art = await app.request(apiPaths.artifact(runId, 'art-2'));
    expect(art.status).toBe(200);
    expect(art.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(art.headers.get('x-content-type-options')).toBe('nosniff');
    const tap = await art.text();
    expect(tap).toContain('# fail 2');
    const file = await app.request(apiPaths.artifact(runId, 'art-1'));
    expect(file.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    // The run is over: controls conflict.
    for (const action of ['stop', 'pause', 'resume'] as const) {
      expect((await post(apiPaths[action](runId))).status).toBe(409);
    }
  });

  it('answers 404 for unknown runs, artifacts and routes', async () => {
    const { app } = runtime();
    const ghost = '22222222-2222-4222-8222-222222222222';
    expect((await app.request(apiPaths.run(ghost))).status).toBe(404);
    expect((await app.request(apiPaths.events(ghost))).status).toBe(404);
    expect((await app.request(apiPaths.stream(ghost))).status).toBe(404);
    expect((await app.request(apiPaths.artifact(ghost, 'art-1'))).status).toBe(404);
    expect((await post(apiPaths.stop(ghost))).status).toBe(404);
    expect((await post(apiPaths.pause(ghost))).status).toBe(404);
    expect((await app.request('/api/nope')).status).toBe(404);
  });

  it('lists a run left running by a dead process as interrupted after boot', async () => {
    const dir = tempDir('http');
    const crashed = openRecorder(dir);
    const runId = '33333333-3333-4333-8333-333333333333';
    crashed.recorder.createRun({ runId, manifest: MANIFEST });
    crashed.db.close();

    const { app, recovered } = runtime(dir);
    expect(recovered).toEqual([runId]);
    const list = (await (await app.request(apiPaths.runs)).json()) as { runs: { status: string }[] };
    expect(list.runs).toEqual([expect.objectContaining({ runId, status: 'interrupted', lastSequence: 2 })]);
  });
});
