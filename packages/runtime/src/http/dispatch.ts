/**
 * Dispatch API (plan §4.5, S4):
 *   GET  /api/dispatches/policy                 policy + CLI probe
 *   POST /api/agents/:id/dispatches/preview     exact argv + single-use nonce (nothing runs)
 *   POST /api/dispatches                        {previewId, approvalNonce} → 201; needs an allowed Origin
 *   GET  /api/dispatches?agentId=, GET /api/dispatches/:id[/stream], POST /api/dispatches/:id/cancel
 *
 * Mounted on the app from createApp, so every route also passes its guards
 * (loopback peer, localhost Host, JSON body and allowed Origin on writes).
 * Approval is stricter: the Origin header must be present, so only a page
 * served from an allowed origin (Studio) can start a process, never a bare
 * request. Errors are `{error, code}` and never contain a path.
 */
import {
  DispatchCreateRequestSchema,
  DispatchPreviewRequestSchema,
  SSE_END_EVENT,
  worldApiPaths,
  type DispatchEndData,
  type DispatchErrorCode,
  type DispatchPreviewResponse,
  type DispatchResponse,
  type ListDispatchesResponse,
} from '@runloop-world/events';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DispatchManager } from '../dispatch/dispatch-manager';
import { DEFAULT_PING_MS } from './sse';

export interface DispatchRouteOptions {
  /** null = dispatch is off (RUNLOOP_DISPATCH=off or no world): every route answers 404 `dispatch_disabled`. */
  dispatch: DispatchManager | null;
  allowedOrigins: readonly string[];
  pingMs?: number;
}

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

const errorJson = (c: Context, status: 400 | 403 | 404 | 409 | 500, code: DispatchErrorCode, error: string) => c.json({ error, code }, status);

async function parseBody<T>(c: Context, schema: Schema<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: errorJson(c, 400, 'invalid', 'Invalid JSON body') };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.map(String).join('.') : '(root)';
    return { ok: false, res: errorJson(c, 400, 'invalid', `Invalid request: ${where}: ${issue?.message ?? 'schema'}`) };
  }
  return { ok: true, data: parsed.data };
}

/** The URL this request reached the runtime on (the app guard already allowed only localhost hosts). */
function requestUrl(c: Context): string | null {
  const host = c.req.header('host');
  return host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host) ? `http://${host}` : null;
}

export function mountDispatchRoutes(app: Hono, opts: DispatchRouteOptions): void {
  const { dispatch, allowedOrigins } = opts;
  if (!dispatch) {
    const off = (c: Context) => errorJson(c, 404, 'dispatch_disabled', 'Task dispatch is off in this runtime');
    app.all(worldApiPaths.dispatches, off);
    app.all(`${worldApiPaths.dispatches}/*`, off);
    app.all('/api/agents/:id/dispatches/*', off);
    return;
  }

  app.get(worldApiPaths.dispatchPolicy, (c) => c.json(dispatch.policyResponse()));

  app.post('/api/agents/:id/dispatches/preview', async (c) => {
    const req = await parseBody(c, DispatchPreviewRequestSchema);
    if (!req.ok) return req.res;
    const r = await dispatch.preview(c.req.param('id'), req.data, { runtimeUrl: requestUrl(c) });
    if (!r.ok) return errorJson(c, r.status, r.code, r.error);
    const body: DispatchPreviewResponse = { preview: r.preview };
    return c.json(body);
  });

  app.post(worldApiPaths.dispatches, async (c) => {
    // createApp already refused a foreign Origin; approving also needs one to be present.
    const origin = c.req.header('origin');
    if (origin === undefined) return errorJson(c, 403, 'origin_required', 'Approve tasks from Runloop Studio (this request has no Origin)');
    if (!allowedOrigins.includes(origin)) return errorJson(c, 403, 'origin_required', 'Origin not allowed');
    const req = await parseBody(c, DispatchCreateRequestSchema);
    if (!req.ok) return req.res;
    const r = await dispatch.create(req.data, { runtimeUrl: requestUrl(c) });
    if (!r.ok) return errorJson(c, r.status, r.code, r.error);
    const body: DispatchResponse = { dispatch: r.dispatch };
    return c.json(body, 201);
  });

  app.get(worldApiPaths.dispatches, (c) => {
    const agentId = c.req.query('agentId');
    const body: ListDispatchesResponse = { dispatches: dispatch.list(agentId || undefined) };
    return c.json(body);
  });

  app.get('/api/dispatches/:id', (c) => {
    const d = dispatch.get(c.req.param('id'));
    if (!d) return errorJson(c, 404, 'unknown_dispatch', 'No such dispatch');
    const body: DispatchResponse = { dispatch: d };
    return c.json(body);
  });

  app.post('/api/dispatches/:id/cancel', (c) => {
    const r = dispatch.cancel(c.req.param('id'));
    if (!r.ok) return errorJson(c, r.status, r.code, r.error);
    const body: DispatchResponse = { dispatch: r.dispatch };
    return c.json(body, 202);
  });

  app.get('/api/dispatches/:id/stream', (c) => {
    const id = c.req.param('id');
    if (!dispatch.output(id)) return errorJson(c, 404, 'unknown_dispatch', 'No such dispatch');
    const header = c.req.header('last-event-id') ?? c.req.query('after');
    const after = header !== undefined && /^\d{1,9}$/.test(header) ? Number(header) : 0;
    const pingMs = opts.pingMs ?? DEFAULT_PING_MS;
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      // Set by every new line (also while a write is awaited), so none waits for the next ping.
      let dirty = false;
      const off = dispatch.onOutput(id, () => {
        dirty = true;
        const w = wake;
        wake = null;
        w?.();
      });
      stream.onAbort(() => wake?.());
      let sent = after;
      try {
        await stream.write('retry: 2000\n\n');
        while (!stream.aborted) {
          dirty = false;
          const out = dispatch.output(id);
          if (!out) break;
          // Frame ids are 1-based indexes into the output.
          for (; sent < out.frames.length && !stream.aborted; sent++) {
            await stream.writeSSE({ id: String(sent + 1), data: JSON.stringify(out.frames[sent]) });
          }
          if (out.done) {
            const end: DispatchEndData = { status: out.status, outcome: out.outcome };
            await stream.writeSSE({ event: SSE_END_EVENT, data: JSON.stringify(end) });
            break;
          }
          if (dirty) continue;
          const timedOut = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve(true);
            }, pingMs);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          if (timedOut && !stream.aborted) await stream.write(': ping\n\n');
        }
      } catch (err) {
        if (!stream.aborted) throw err;
      } finally {
        off();
      }
    });
  });
}
