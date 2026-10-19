/**
 * Dispatch API (plan §4.5, S4):
 *   GET  /api/dispatches/policy                 policy + CLI probe
 *   POST /api/agents/:id/dispatches/preview     exact argv + approveUrl (nothing runs)
 *   GET  /approve/:previewId, POST (form)       the runtime's approval page: a person approves here
 *   GET  /api/dispatches/previews/:previewId    where that approval stands
 *   POST /api/dispatches                        {previewId, approvalNonce} → 201; same-origin only
 *   GET  /api/dispatches?agentId=, GET /api/dispatches/:id[/stream], POST /api/dispatches/:id/cancel
 *
 * Mounted on the app from createApp, so every /api route also passes its
 * guards (loopback peer, localhost Host, JSON body and allowed Origin on
 * writes). Approval is stricter. An allowed Origin is not enough: any page
 * on such an origin (localhost:3000 is any dev server) could preview a task,
 * read the nonce and approve it with no person involved. So the nonce reaches
 * only same-origin callers (a page the runtime serves, or a local process
 * without an Origin), and approving needs the runtime's own Origin: Studio
 * opens the approval page, where a person reads exactly what will run and
 * approves. Refusals are audited. Errors are `{error, code}` and never
 * contain a path.
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
import { newCspNonce, pageHeaders, renderApproval, renderOutcome } from './approval-page';
import { DEFAULT_PING_MS } from './sse';

export interface DispatchRouteOptions {
  /** null = dispatch is off (RUNLOOP_DISPATCH=off or no world): every route answers 404 `dispatch_disabled`. */
  dispatch: DispatchManager | null;
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

/**
 * Whether a browser sent this request from the runtime's own origin (a page
 * the runtime served). A request with no Origin is a local process, not a
 * page: `sameOrigin` is null then.
 */
function originOf(c: Context): { origin: string | undefined; sameOrigin: boolean | null } {
  const origin = c.req.header('origin');
  if (origin === undefined) return { origin, sameOrigin: null };
  const fetchSite = c.req.header('sec-fetch-site');
  const own = requestUrl(c);
  return { origin, sameOrigin: own !== null && origin === own && (fetchSite === undefined || fetchSite === 'same-origin') };
}

export function mountDispatchRoutes(app: Hono, opts: DispatchRouteOptions): void {
  const { dispatch } = opts;
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
    // A page on another origin (Studio's too) never sees the nonce: a person approves on approveUrl.
    const { sameOrigin } = originOf(c);
    const body: DispatchPreviewResponse = { preview: sameOrigin === false ? { ...r.preview, approvalNonce: '' } : r.preview };
    return c.json(body);
  });

  app.get('/api/dispatches/previews/:previewId', (c) => c.json(dispatch.previewStatus(c.req.param('previewId'))));

  app.post(worldApiPaths.dispatches, async (c) => {
    // createApp already refused an Origin that is not allowed. Approving needs the runtime's own.
    const { origin, sameOrigin } = originOf(c);
    const refuse = (code: 'origin_required' | 'approve_in_runtime', error: string) => {
      dispatch.auditRequestRefusal({ method: 'POST', path: c.req.path, code, origin: origin ?? null });
      return errorJson(c, 403, code, error);
    };
    if (sameOrigin === null) return refuse('origin_required', 'Approve tasks on Runloop’s approval page (this request has no Origin)');
    if (!sameOrigin) return refuse('approve_in_runtime', 'Approve tasks on Runloop’s own approval page (the preview’s approveUrl); no other web page can approve one');
    const req = await parseBody(c, DispatchCreateRequestSchema);
    if (!req.ok) {
      dispatch.auditRequestRefusal({ method: 'POST', path: c.req.path, code: 'invalid', origin: origin ?? null });
      return req.res;
    }
    const r = await dispatch.create(req.data, { runtimeUrl: requestUrl(c) });
    if (!r.ok) return errorJson(c, r.status, r.code, r.error);
    const body: DispatchResponse = { dispatch: r.dispatch };
    return c.json(body, 201);
  });

  mountApprovalPage(app, dispatch);

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

/**
 * GET /approve/:previewId shows the approval page; POST (its own form)
 * approves or declines. The POST must come from that page: the runtime's own
 * Origin (and Sec-Fetch-Site same-origin when the browser sends it), a form
 * body with the nonce the page carries, and the page open at least
 * minReviewMs (a click landing at once, e.g. on a window another page just
 * opened, does not count and spends nothing).
 */
function mountApprovalPage(app: Hono, dispatch: DispatchManager): void {
  const html = (c: Context, status: 200 | 403 | 404 | 409 | 410 | 415, render: (nonce: string) => string) => {
    const nonce = newCspNonce();
    return c.body(render(nonce), status, pageHeaders(nonce));
  };
  const gone = (c: Context, previewId: string) => {
    const st = dispatch.previewStatus(previewId);
    const text: Record<typeof st.state, string> = {
      awaiting_approval: '',
      approved: 'This task was already approved and started.',
      refused: 'This approval was already used, and refused. Nothing was run from it.',
      declined: 'You declined this task. Nothing was run.',
      expired: 'This approval expired (they last 5 minutes). Preview the task again in Studio.',
      unknown: 'Runloop does not know this approval (it may have restarted since). Preview the task again in Studio.',
    };
    return html(c, st.state === 'unknown' ? 404 : st.state === 'expired' ? 410 : 409, (n) =>
      renderOutcome({ ok: st.state === 'approved', title: st.state === 'approved' ? 'Already approved' : 'Nothing to approve', text: text[st.state], detail: st.dispatchId }, n),
    );
  };

  app.get('/approve/:previewId', (c) => {
    const previewId = c.req.param('previewId');
    const view = dispatch.approvalView(previewId);
    return view ? html(c, 200, (n) => renderApproval(view, n)) : gone(c, previewId);
  });

  app.post('/approve/:previewId', async (c) => {
    const previewId = c.req.param('previewId');
    const { origin, sameOrigin } = originOf(c);
    const refuse = (status: 403 | 415, code: string, text: string) => {
      dispatch.auditRequestRefusal({ method: 'POST', path: c.req.path, code, origin: origin ?? null });
      return html(c, status, (n) => renderOutcome({ ok: false, title: 'Not approved', text }, n));
    };
    if (!sameOrigin) return refuse(403, sameOrigin === null ? 'origin_required' : 'approve_in_runtime', 'Only Runloop’s own approval page can approve a task. Nothing was run.');
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return refuse(415, 'invalid', 'Nothing was run.');
    const form = await c.req.parseBody();
    const nonce = typeof form.nonce === 'string' ? form.nonce : '';
    const view = dispatch.approvalView(previewId);
    if (!view) return gone(c, previewId);
    if (form.action === 'decline') {
      return dispatch.decline(previewId, nonce)
        ? html(c, 200, (n) => renderOutcome({ ok: false, title: 'Declined', text: 'Nothing was run.' }, n))
        : refuse(403, 'bad_nonce', 'Nothing was run.');
    }
    if (!dispatch.reviewed(previewId)) {
      return html(c, 200, (n) => renderApproval(view, n, 'Take a moment to read what will run, then approve.'));
    }
    const r = await dispatch.create({ previewId, approvalNonce: nonce }, { runtimeUrl: requestUrl(c) });
    if (!r.ok) return html(c, r.status === 403 ? 403 : 409, (n) => renderOutcome({ ok: false, title: 'Nothing was run', text: r.error }, n));
    return html(c, 200, (n) => renderOutcome({ ok: true, title: 'Task started', text: `Claude Code is working on it for ${view.agentName}. Follow it in Runloop Studio.`, detail: r.dispatch.dispatchId }, n));
  });
}
