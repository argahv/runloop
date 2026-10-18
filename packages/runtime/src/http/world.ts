/**
 * World API (plan §4.5; types in @runloop-world/events world-protocol.ts).
 * Mounted after createApp, so every request passes its guards (loopback,
 * Host, JSON-only writes from allowed Origins).
 *
 * - POST /api/world/commands: body `{id, command}` only (strict; `source` or
 *   `prov` in the body is a 400, P2). The source is always 'user'.
 * - GET /api/world/stream: SSE like http/sse.ts — subscribe first, then a
 *   `snapshot` (or a backfill after Last-Event-ID), then batches as `message`
 *   frames with `id: <last seq>`, and a `clock` frame every second. A client
 *   more than 5 000 events behind, or behind pruned events, gets a fresh
 *   snapshot.
 * - When the world is off (RUNLOOP_WORLD=off) every route answers 404 `world_disabled`.
 */
import {
  ExplainQuerySchema,
  WORLD_SSE_CLOCK_EVENT,
  WORLD_SSE_SNAPSHOT_EVENT,
  WORLD_STREAM_RESNAPSHOT,
  WorldCommandRequestSchema,
  WorldEventsQuerySchema,
  worldApiPaths,
  type ErrorResponse,
  type ExplainResponse,
  type WorldEvent,
} from '@runloop-world/events';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { WorldHost } from '../world/world-host';

export interface WorldRouteOptions {
  /** null = the world is off. */
  host: WorldHost | null;
  /** Clock frame interval (default 1000 ms; also the keep-alive). */
  clockMs?: number;
}

const PAGE = 500;
const err = (error: string): ErrorResponse => ({ error });

function issues(e: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return e.issues
    .slice(0, 4)
    .map((i) => `${i.path.map(String).join('.') || '(body)'}: ${i.message}`)
    .join('; ');
}

export function mountWorldRoutes(app: Hono, opts: WorldRouteOptions): void {
  const { host } = opts;
  if (!host) {
    app.all(`${worldApiPaths.world}`, (c) => c.json(err('world_disabled'), 404));
    app.all(`${worldApiPaths.world}/*`, (c) => c.json(err('world_disabled'), 404));
    return;
  }

  app.get(worldApiPaths.world, (c) => c.json(host.info()));
  app.get(worldApiPaths.town, (c) => c.json(host.townResponse()));
  app.get(worldApiPaths.snapshot, (c) => c.json(host.snapshot()));

  app.get(worldApiPaths.events, (c) => {
    const q = WorldEventsQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err(issues(q.error)), 400);
    return c.json(host.events(q.data));
  });

  app.get(worldApiPaths.explain, (c) => {
    const q = ExplainQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err(issues(q.error)), 400);
    const idx = Number(q.data.ref.slice('resident:res_'.length)) - 1;
    const explanation = host.explain(idx, q.data.atSeq);
    if (!explanation) return c.json(err('No recorded decision for that resident at that seq'), 404);
    const body: ExplainResponse = { explanation };
    return c.json(body);
  });

  app.post(worldApiPaths.commands, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err('Invalid JSON body'), 400);
    }
    const req = WorldCommandRequestSchema.safeParse(body);
    if (!req.success) return c.json(err(issues(req.error)), 400);
    const res = await host.submit({ id: req.data.id, source: 'user', command: req.data.command });
    return c.json(res, 202);
  });

  app.get(worldApiPaths.stream, (c) => streamWorld(c, host, opts.clockMs ?? 1000));
}

function parseAfter(value: string | undefined): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

function streamWorld(c: Context, host: WorldHost, clockMs: number): Response {
  const header = c.req.header('last-event-id');
  const after = parseAfter(header ?? c.req.query('after'));
  if (after === null) return c.json(err('Last-Event-ID / after must be a non-negative integer'), 400);
  return streamSSE(c, async (stream) => {
    const queue: (readonly WorldEvent[])[] = [];
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const unsubscribe = host.subscribe((batch) => {
      queue.push(batch);
      notify();
    });
    stream.onAbort(notify);
    c.req.raw.signal?.addEventListener('abort', () => stream.abort(), { once: true });

    let lastSent = 0;
    const sendSnapshot = async () => {
      const snap = host.snapshot();
      await stream.writeSSE({ event: WORLD_SSE_SNAPSHOT_EVENT, id: String(snap.seq), data: JSON.stringify(snap) });
      lastSent = snap.seq;
    };
    const sendEvents = async (events: readonly WorldEvent[]) => {
      if (!events.length) return;
      await stream.writeSSE({ id: String(events.at(-1)!.seq), data: JSON.stringify({ events }) });
      lastSent = events.at(-1)!.seq;
    };
    /** Committed events after lastSent from the store; a pruned gap means a fresh snapshot. */
    const backfill = async () => {
      for (;;) {
        const page = host.store.events(host.worldId, { after: lastSent, limit: PAGE });
        if (page.length && page[0]!.seq !== lastSent + 1) return sendSnapshot();
        await sendEvents(page);
        if (page.length < PAGE || stream.aborted) return;
      }
    };
    const sendClock = () => stream.writeSSE({ event: WORLD_SSE_CLOCK_EVENT, data: JSON.stringify(host.clockFrame()) });

    try {
      await stream.write('retry: 2000\n\n');
      if (after === undefined || host.seq - after > WORLD_STREAM_RESNAPSHOT) await sendSnapshot();
      else {
        lastSent = after;
        await backfill();
      }
      await sendClock();
      let nextClock = Date.now() + clockMs;
      while (!stream.aborted) {
        while (queue.length && !stream.aborted) {
          const batch = queue.shift()!.filter((e) => e.seq > lastSent);
          if (!batch.length) continue;
          if (batch[0]!.seq > lastSent + 1) await backfill();
          await sendEvents(batch.filter((e) => e.seq > lastSent));
        }
        if (stream.aborted) break;
        const wait = nextClock - Date.now();
        if (wait <= 0) {
          await sendClock();
          nextClock = Date.now() + clockMs;
          continue;
        }
        if (queue.length) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, wait);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    } catch (e) {
      if (!stream.aborted) throw e;
    } finally {
      unsubscribe();
    }
  });
}
