import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  apiPaths,
  type RunDispatchInfo,
  type BaselineResponse,
  type ErrorResponse,
  type EventsPageResponse,
  type HealthResponse,
  type ListRunsResponse,
  type RunDetailResponse,
  type StartRunResponse,
} from '@runloop-world/events';
import { parseWorldDefinition, type WorldDefinition } from '@runloop-world/world-engine';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { RUNTIME_VERSION } from '../config';
import { MissionNotFoundError } from '../mission';
import { ArtifactIntegrityError, UnknownRunError, type Recorder } from '../recorder';
import { RunConflictError, RunNotActiveError, type RunManager } from '../run-manager';
import type { TraceSessionManager } from '../tracers/claude-code/session-manager';
import { mountClaudeCodeIngest, rejectBrowserOrigins, type IngestRouteOptions } from './ingest';
import { streamRunEvents } from './sse';

export interface AppOptions {
  recorder: Recorder;
  manager: RunManager;
  /** Directory holding `<worldId>/world.json` (the repo's `worlds/`). */
  worldsDir: string;
  allowedOrigins: readonly string[];
  /** SSE keep-alive interval (tests shorten it). */
  pingMs?: number;
  /** Claude Code ingest (tracer mode); null or absent = the route is not served. */
  tracer?: { manager: TraceSessionManager; token: string; rate?: IngestRouteOptions['rate'] } | null;
  /** The dispatch behind a run, for GET /api/runs/:id (absent = dispatch is off). */
  dispatchOfRun?: (runId: string) => RunDispatchInfo | null;
  /** Told about every write the guards below refuse (runtime.ts audits the ones aimed at dispatch). */
  onRefusedWrite?: (r: { method: string; path: string; code: 'origin_not_allowed' | 'not_json'; origin: string | null }) => void;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PAGE = 1000;

/** True for 127.0.0.0/8 and ::1 (also IPv4-mapped and bracketed forms). */
export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Peer address of the socket when served by @hono/node-server (absent for in-process app.request()). */
function remoteAddressOf(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function hostnameOf(c: Context): string | null {
  const host = c.req.header('host');
  try {
    return host ? new URL(`http://${host}`).hostname : new URL(c.req.url).hostname;
  } catch {
    return null;
  }
}

/** Non-negative integer from a query/header value; undefined if absent, null if invalid. */
function parseSeq(value: string | undefined): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

function errorBody(error: string): ErrorResponse {
  return { error };
}

/**
 * The local HTTP API (see packages/events/src/protocol.ts). It has no auth, so
 * guards: the peer must be a loopback address, the Host header must be
 * localhost/127.0.0.1 (blocks DNS rebinding), POSTs must be JSON (forces a
 * CORS preflight) and come from an allowed Origin (or the runtime's own) when
 * a browser sends one. Approving a dispatch is stricter (http/dispatch.ts).
 */
export function createApp(opts: AppOptions): Hono {
  const { recorder, manager, allowedOrigins } = opts;
  const worlds = new Map<string, WorldDefinition>();
  const loadWorld = (worldId: string): WorldDefinition => {
    let w = worlds.get(worldId);
    if (!w) {
      if (!SAFE_WORLD_ID.test(worldId)) throw new Error(`Invalid world id: ${worldId}`);
      const raw: unknown = JSON.parse(readFileSync(path.join(opts.worldsDir, worldId, 'world.json'), 'utf8'));
      w = parseWorldDefinition(raw);
      worlds.set(worldId, w);
    }
    return w;
  };

  const app = new Hono();

  app.use('*', async (c, next) => {
    const peer = remoteAddressOf(c);
    if (peer !== undefined && !isLoopbackAddress(peer)) return c.json(errorBody('Only local connections are allowed'), 403);
    const hostname = hostnameOf(c);
    if (!hostname || !LOCAL_HOSTNAMES.has(hostname)) return c.json(errorBody('Host not allowed'), 403);
    await next();
  });

  if (opts.tracer) rejectBrowserOrigins(app);

  app.use(
    '/api/*',
    cors({
      origin: [...allowedOrigins],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Last-Event-ID'],
      maxAge: 600,
    }),
  );

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'DELETE') {
      const origin = c.req.header('origin');
      const refused = (code: 'origin_not_allowed' | 'not_json') => opts.onRefusedWrite?.({ method: c.req.method, path: c.req.path, code, origin: origin ?? null });
      // The runtime's own pages (the dispatch approval page) are same-origin, which is always allowed.
      const own = c.req.header('host') ? `http://${c.req.header('host')}` : null;
      if (origin !== undefined && origin !== own && !allowedOrigins.includes(origin)) {
        refused('origin_not_allowed');
        return c.json(errorBody('Origin not allowed'), 403);
      }
      const type = c.req.header('content-type') ?? '';
      if (!/^application\/json\s*(;|$)/i.test(type)) {
        refused('not_json');
        return c.json(errorBody('Content-Type must be application/json'), 415);
      }
    }
    await next();
  });

  app.get(apiPaths.health, (c) => {
    const body: HealthResponse = {
      ok: true,
      version: RUNTIME_VERSION,
      activeRunId: manager.activeRunId,
      tracedRunIds: recorder
        .listRuns()
        .filter((r) => r.mode === 'traced' && r.status === 'running')
        .map((r) => r.runId),
      ingest: opts.tracer ? { claudeCode: { protocol: 1 } } : null,
    };
    return c.json(body);
  });

  if (opts.tracer) {
    mountClaudeCodeIngest(app, {
      manager: opts.tracer.manager,
      token: opts.tracer.token,
      ...(opts.tracer.rate ? { rate: opts.tracer.rate } : {}),
    });
  }

  app.get(apiPaths.runs, (c) => {
    const body: ListRunsResponse = { runs: recorder.listRuns() };
    return c.json(body);
  });

  app.post(apiPaths.runs, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody('Invalid JSON body'), 400);
    }
    const req = body as { missionId?: unknown; speed?: unknown } | null;
    if (!req || typeof req !== 'object' || typeof req.missionId !== 'string' || req.missionId === '') {
      return c.json(errorBody('missionId (string) is required'), 400);
    }
    if (req.speed !== undefined && (typeof req.speed !== 'number' || !Number.isFinite(req.speed) || req.speed < 0 || req.speed > 100)) {
      return c.json(errorBody('speed must be a number between 0 and 100'), 400);
    }
    try {
      const { runId } = manager.start({ missionId: req.missionId, ...(req.speed !== undefined ? { speed: req.speed } : {}) });
      const res: StartRunResponse = { runId };
      return c.json(res, 202);
    } catch (err) {
      if (err instanceof RunConflictError) return c.json(errorBody(err.message), 409);
      if (err instanceof MissionNotFoundError) return c.json(errorBody(err.message), 404);
      throw err;
    }
  });

  app.get('/api/runs/:id', (c) => {
    const run = recorder.getRun(c.req.param('id'));
    if (!run) return c.json(errorBody('Run not found'), 404);
    const body: RunDetailResponse = { run, world: loadWorld(run.worldId), dispatch: opts.dispatchOfRun?.(run.runId) ?? null };
    return c.json(body);
  });

  app.get('/api/runs/:id/events', (c) => {
    const run = recorder.getRun(c.req.param('id'));
    if (!run) return c.json(errorBody('Run not found'), 404);
    const after = parseSeq(c.req.query('after'));
    const limit = parseSeq(c.req.query('limit'));
    if (after === null || limit === null || limit === 0) return c.json(errorBody('after and limit must be non-negative integers (limit ≥ 1)'), 400);
    const events = recorder.list(run.runId, { after: after ?? 0, limit: Math.min(limit ?? 500, MAX_PAGE) });
    const nextAfter = events.at(-1)?.sequence ?? after ?? 0;
    const body: EventsPageResponse = { events, nextAfter, hasMore: nextAfter < run.lastSequence };
    return c.json(body);
  });

  app.get('/api/runs/:id/stream', (c) => {
    const run = recorder.getRun(c.req.param('id'));
    if (!run) return c.json(errorBody('Run not found'), 404);
    const header = c.req.header('last-event-id');
    const after = header !== undefined ? parseSeq(header) : parseSeq(c.req.query('after'));
    if (after === null) return c.json(errorBody('Last-Event-ID / after must be a non-negative integer'), 400);
    return streamRunEvents(c, {
      recorder,
      runId: run.runId,
      after: after ?? 0,
      ...(opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}),
    });
  });

  const control = (action: 'stop' | 'pause' | 'resume') => (c: Context) => {
    const runId = c.req.param('id')!;
    if (recorder.getRun(runId)?.mode === 'traced') return c.json(errorBody('Traced runs are controlled by Claude Code'), 409);
    try {
      const run = manager[action](runId);
      return c.json({ run }, 202);
    } catch (err) {
      if (err instanceof UnknownRunError) return c.json(errorBody('Run not found'), 404);
      if (err instanceof RunNotActiveError) return c.json(errorBody(err.message), 409);
      throw err;
    }
  };
  app.post('/api/runs/:id/stop', control('stop'));
  app.post('/api/runs/:id/pause', control('pause'));
  app.post('/api/runs/:id/resume', control('resume'));

  // Baselines: pin (POST) or unpin (DELETE) a run. Same guards as every write (JSON, allowed Origin).
  const baseline = (pinned: boolean) => (c: Context) => {
    try {
      const body: BaselineResponse = { run: recorder.setPinned(c.req.param('id')!, pinned) };
      return c.json(body);
    } catch (err) {
      if (err instanceof UnknownRunError) return c.json(errorBody('Run not found'), 404);
      throw err;
    }
  };
  app.post('/api/runs/:id/baseline', baseline(true));
  app.delete('/api/runs/:id/baseline', baseline(false));

  app.get('/api/runs/:id/artifacts/:aid', (c) => {
    let artifact;
    try {
      artifact = recorder.getArtifact(c.req.param('id'), c.req.param('aid'));
    } catch (err) {
      if (err instanceof ArtifactIntegrityError) return c.json(errorBody(err.message), 409);
      throw err;
    }
    if (!artifact) return c.json(errorBody('Artifact not found'), 404);
    const textual = /^text\/|^application\/json/.test(artifact.mediaType);
    return c.body(new Uint8Array(artifact.content), 200, {
      'Content-Type': textual ? `${artifact.mediaType}; charset=utf-8` : artifact.mediaType,
      'Content-Disposition': `inline; filename="${artifact.name.replace(/[^\w.-]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-cache',
    });
  });

  app.notFound((c) => c.json(errorBody('Not found'), 404));
  app.onError((err, c) => {
    console.error('[runtime] request failed:', err);
    return c.json(errorBody(err instanceof Error ? err.message : 'Internal error'), 500);
  });

  return app;
}
