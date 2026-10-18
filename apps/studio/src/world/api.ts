/**
 * World and agent API calls (types: @runloop-world/events world-protocol.ts).
 * Errors carry the HTTP status and the runtime's message so the UI can say
 * what failed. 404 `world_disabled` and a missing /api/agents route are
 * reported as such, never as an empty world.
 */
import {
  worldApiPaths,
  type AgentDetailResponse,
  type ArrivalsResponse,
  type ClaimSessionResponse,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type ExplainResponse,
  type ListAgentsResponse,
  type WorldCommand,
  type WorldCommandResponse,
  type WorldEvent,
  type WorldEventsPageResponse,
  type WorldInfoResponse,
  type WorldProvenance,
  type WorldTownResponse,
} from '@runloop-world/events';
import { apiUrl } from '../lib/api';

export class WorldApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The runtime's machine-readable code (`world_disabled`, `cwd_unknown`, …) when it sent one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'WorldApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: 'no-store', ...init });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string') message = body.error;
      if (typeof body.code === 'string') code = body.code;
      else if (body.error === 'world_disabled') code = 'world_disabled';
    } catch {
      // not JSON
    }
    throw new WorldApiError(res.status, message, code);
  }
  return (await res.json()) as T;
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const getWorldInfo = (signal?: AbortSignal) => request<WorldInfoResponse>(worldApiPaths.world, signal ? { signal } : undefined);
export const getWorldTown = () => request<WorldTownResponse>(worldApiPaths.town);

export interface EventsQuery {
  after?: number;
  limit?: number;
  actor?: string;
  type?: string;
  prov?: WorldProvenance;
}

export function getWorldEvents(q: EventsQuery = {}): Promise<WorldEventsPageResponse> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return request<WorldEventsPageResponse>(`${worldApiPaths.events}?${p.toString()}`);
}

/** Events after `after`, page by page, up to `cap` events (the newest are dropped past it). */
export async function getWorldEventsSince(after: number, cap: number, q: Omit<EventsQuery, 'after' | 'limit'> = {}): Promise<{ events: WorldEvent[]; capped: boolean }> {
  const events: WorldEvent[] = [];
  for (let cursor = after; ; ) {
    const page = await getWorldEvents({ ...q, after: cursor, limit: 1000 });
    events.push(...page.events);
    if (events.length >= cap) return { events: events.slice(0, cap), capped: true };
    if (!page.hasMore || page.nextAfter <= cursor) return { events, capped: false };
    cursor = page.nextAfter;
  }
}

export function getExplanation(residentId: string, atSeq?: number): Promise<ExplainResponse> {
  const p = new URLSearchParams({ ref: `resident:${residentId}` });
  if (atSeq !== undefined) p.set('atSeq', String(atSeq));
  return request<ExplainResponse>(`${worldApiPaths.explain}?${p.toString()}`);
}

/** POST /api/world/commands: `{id, command}` only (the runtime sets source 'user'; P2). */
export function postWorldCommand(id: string, command: WorldCommand): Promise<WorldCommandResponse> {
  return request<WorldCommandResponse>(worldApiPaths.commands, postJson({ id, command }));
}

export const listAgents = () => request<ListAgentsResponse>(worldApiPaths.agents);
export const getAgent = (agentId: string) => request<AgentDetailResponse>(worldApiPaths.agent(agentId));
export const listArrivals = () => request<ArrivalsResponse>(worldApiPaths.arrivals);
export const createAgent = (body: CreateAgentRequest) => request<CreateAgentResponse>(worldApiPaths.agents, postJson(body));
export const claimSession = (agentId: string, sessionId: string) => request<ClaimSessionResponse>(worldApiPaths.claim(agentId), postJson({ sessionId }));

export const worldStreamUrl = (after: number | null) => apiUrl(after === null ? worldApiPaths.stream : `${worldApiPaths.stream}?after=${after}`);
