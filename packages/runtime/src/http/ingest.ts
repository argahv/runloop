/**
 * POST /api/ingest/claude-code — hook envelopes from the Claude Code plugin.
 *
 * Checks, in order (the Host guard and the JSON content-type check are the
 * app's own middleware):
 *   any Origin header → 403 (the plugin is not a browser; web pages cannot post here)
 *   body over 1 MiB → 413
 *   X-Runloop-Token mismatch → 401 (constant time)
 *   invalid JSON / unknown protocol version / schema → 400
 *   per-session rate over 100/s (burst 1000) → 429
 *   → 202 { accepted, duplicates, ignored }
 */
import {
  CLAUDE_CODE_PROTOCOLS,
  ClaudeCodeIngestRequestSchema,
  INGEST_TOKEN_HEADER,
  apiPaths,
  type ClaudeCodeIngestResponse,
  type ErrorResponse,
} from '@runloop-world/events';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { tokenMatches } from '../ingest-token';
import type { TraceSessionManager } from '../tracers/claude-code/session-manager';

export const INGEST_BODY_LIMIT = 1024 * 1024;

export interface IngestRouteOptions {
  manager: TraceSessionManager;
  token: string;
  /** Envelopes per second per session, and the burst allowance. */
  rate?: { perSecond: number; burst: number };
  now?: () => number;
}

const err = (error: string): ErrorResponse => ({ error });

/** Token bucket per session id. A request is admitted whole or not at all. */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {}

  admit(counts: Map<string, number>): boolean {
    const t = this.now();
    const refilled = new Map<string, number>();
    for (const [sessionId, n] of counts) {
      const b = this.buckets.get(sessionId) ?? { tokens: this.burst, at: t };
      const tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSecond);
      if (tokens < n) return false;
      refilled.set(sessionId, tokens - n);
    }
    for (const [sessionId, tokens] of refilled) this.buckets.set(sessionId, { tokens, at: t });
    if (this.buckets.size > 10_000) this.buckets.clear(); // bound memory; worst case a fresh burst allowance
    return true;
  }
}

/** Rejects any request to the ingest path that carries an Origin (register before CORS). */
export function rejectBrowserOrigins(app: Hono): void {
  app.use(apiPaths.ingestClaudeCode, async (c, next) => {
    if (c.req.header('origin') !== undefined) return c.json(err('Browsers may not post hook events'), 403);
    await next();
  });
}

export function mountClaudeCodeIngest(app: Hono, opts: IngestRouteOptions): void {
  const rate = opts.rate ?? { perSecond: 100, burst: 1000 };
  const limiter = new RateLimiter(rate.perSecond, rate.burst, opts.now ?? Date.now);

  app.post(
    apiPaths.ingestClaudeCode,
    bodyLimit({ maxSize: INGEST_BODY_LIMIT, onError: (c) => c.json(err('Request body over 1 MiB'), 413) }),
    async (c) => {
      if (!tokenMatches(opts.token, c.req.header(INGEST_TOKEN_HEADER))) return c.json(err('Missing or invalid ingest token'), 401);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(err('Invalid JSON body'), 400);
      }
      const envelopes = (body as { envelopes?: unknown } | null)?.envelopes;
      if (Array.isArray(envelopes)) {
        const unsupported = envelopes.find((e) => (e as { v?: unknown } | null)?.v !== 1);
        if (unsupported !== undefined && (unsupported as { v?: unknown } | null)?.v !== undefined) {
          return c.json({ error: 'Unsupported protocol version', supported: [...CLAUDE_CODE_PROTOCOLS] }, 400);
        }
      }
      const parsed = ClaudeCodeIngestRequestSchema.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return c.json(err(`Invalid request: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema'}`), 400);
      }
      const counts = new Map<string, number>();
      for (const e of parsed.data.envelopes) counts.set(e.hook.session_id, (counts.get(e.hook.session_id) ?? 0) + 1);
      if (!limiter.admit(counts)) return c.json(err('Too many events; retry later'), 429);
      const res: ClaudeCodeIngestResponse = opts.manager.ingest(parsed.data.envelopes);
      return c.json(res, 202);
    },
  );
}
