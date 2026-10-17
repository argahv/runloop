import {
  apiPaths,
  type EventsPageResponse,
  type HealthResponse,
  type ListRunsResponse,
  type RunDetailResponse,
  type RunSummary,
  type StartRunResponse,
} from '@runloop-world/events';
import { apiBase } from './config';

/** An HTTP error with the runtime's `{ error }` message when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const apiUrl = (path: string) => `${apiBase()}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: 'no-store', ...init });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return (await res.json()) as T;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>(apiPaths.health, signal ? { signal } : undefined);
}

export async function listRuns(): Promise<RunSummary[]> {
  return (await request<ListRunsResponse>(apiPaths.runs)).runs;
}

export function getRun(runId: string): Promise<RunDetailResponse> {
  return request<RunDetailResponse>(apiPaths.run(runId));
}

export function getEventsPage(runId: string, after: number, limit = 500): Promise<EventsPageResponse> {
  return request<EventsPageResponse>(`${apiPaths.events(runId)}?after=${after}&limit=${limit}`);
}

/** Every event after `after`, following `hasMore` page by page. Events are raw JSON (parse them). */
export async function getAllEvents(runId: string, after = 0): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let cursor = after; ; ) {
    const page = await getEventsPage(runId, cursor);
    out.push(...page.events);
    if (!page.hasMore || page.nextAfter <= cursor) return out;
    cursor = page.nextAfter;
  }
}

/** Stop the active scripted run (the runtime records run.completed{stopped}). */
export function stopRun(runId: string): Promise<{ run: RunSummary }> {
  return request<{ run: RunSummary }>(apiPaths.stop(runId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export function startRun(missionId: string): Promise<StartRunResponse> {
  return request<StartRunResponse>(apiPaths.runs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ missionId }),
  });
}

/** Artifact content as text (the viewer only shows text; binary shows as replacement chars). */
export async function getArtifactText(runId: string, artifactId: string): Promise<string> {
  const res = await fetch(apiUrl(apiPaths.artifact(runId, artifactId)), { cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res.text();
}

export const streamUrl = (runId: string, after: number) => apiUrl(`${apiPaths.stream(runId)}?after=${after}`);
