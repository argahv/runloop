/**
 * Agent API (plan §4.5): GET|POST /api/agents, GET /api/agents/:id,
 * GET /api/agents/arrivals, POST /api/agents/:id/claim.
 *
 * Mount on the app from createApp, so every route goes through its guards
 * (loopback peer, localhost Host, CORS, JSON body and allowed Origin on POST).
 * No response carries a workspace's absolute path, nor does any error (P8).
 */
import {
  ClaimSessionRequestSchema,
  CreateAgentRequestSchema,
  worldApiPaths,
  type AgentDetailResponse,
  type ArrivalsResponse,
  type ClaimSessionResponse,
  type CreateAgentResponse,
  type ListAgentsResponse,
} from '@runloop-world/events';
import type { Context, Hono } from 'hono';
import type { AgentError, AgentService } from '../agents/service';

/** The part of a zod schema used here (the runtime does not depend on zod directly). */
interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

const errorJson = (c: Context, e: Pick<AgentError, 'status' | 'error' | 'code'>) => c.json({ error: e.error, code: e.code }, e.status);

/** Parse a JSON body with a strict schema; the issue names the field, never echoes values. */
async function parseBody<T>(c: Context, schema: Schema<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: 'Invalid JSON body', code: 'invalid' }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.map(String).join('.') : '(root)';
    return { ok: false, res: c.json({ error: `Invalid request: ${where}: ${issue?.message ?? 'schema'}`, code: 'invalid' }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/** `agents` null = the world is off (RUNLOOP_WORLD=off): every /api/agents route answers 404 `world_disabled`. */
export function mountAgentRoutes(app: Hono, agents: AgentService | null): void {
  if (!agents) {
    const off = (c: Context) => c.json({ error: 'The world is off in this runtime', code: 'world_disabled' }, 404);
    app.all(worldApiPaths.agents, off);
    app.all(`${worldApiPaths.agents}/*`, off);
    return;
  }
  app.get(worldApiPaths.agents, (c) => {
    const body: ListAgentsResponse = { agents: agents.list() };
    return c.json(body);
  });

  app.post(worldApiPaths.agents, async (c) => {
    const req = await parseBody(c, CreateAgentRequestSchema);
    if (!req.ok) return req.res;
    const r = await agents.createAgent(req.data);
    if (!r.ok) return errorJson(c, r);
    const body: CreateAgentResponse = { agent: r.agent };
    return c.json(body, 201);
  });

  // Before /api/agents/:id, so "arrivals" is never read as an agent id.
  app.get(worldApiPaths.arrivals, (c) => {
    const body: ArrivalsResponse = { arrivals: agents.arrivalList() };
    return c.json(body);
  });

  app.get('/api/agents/:id', (c) => {
    const agent = agents.summary(c.req.param('id'));
    if (!agent) return errorJson(c, { status: 404, error: 'No such agent', code: 'unknown_agent' });
    const body: AgentDetailResponse = { agent };
    return c.json(body);
  });

  app.post('/api/agents/:id/claim', async (c) => {
    const req = await parseBody(c, ClaimSessionRequestSchema);
    if (!req.ok) return req.res;
    const r = agents.claim(c.req.param('id'), req.data.sessionId);
    if (!r.ok) return errorJson(c, r);
    const body: ClaimSessionResponse = { agent: r.agent, backfilledRuns: r.backfilledRuns };
    return c.json(body);
  });
}
