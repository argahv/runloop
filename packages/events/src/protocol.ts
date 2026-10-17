/**
 * HTTP + SSE contract between the local runtime and Studio. Studio imports
 * these types and never imports the runtime package itself.
 */
import type { RunOutcome } from './payloads';

export const DEFAULT_RUNTIME_PORT = 4317;
export const DEFAULT_RUNTIME_HOST = '127.0.0.1';

export type RunStatus = 'running' | RunOutcome;

export interface RunSummary {
  runId: string;
  title: string;
  missionId: string;
  worldId: string;
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  lastSequence: number;
  adapterLabel: string;
  paused: boolean;
}

export interface HealthResponse {
  ok: true;
  version: string;
  activeRunId: string | null;
}

export interface ListRunsResponse {
  runs: RunSummary[];
}

/** `world` is a WorldDefinition JSON object; validate it with @runloop-world/world-engine. */
export interface RunDetailResponse {
  run: RunSummary;
  world: unknown;
}

/** `events` are RunEvent JSON objects; parse them with parseEvent(). */
export interface EventsPageResponse {
  events: unknown[];
  nextAfter: number;
  hasMore: boolean;
}

export interface StartRunRequest {
  missionId: string;
  /** Playback pacing multiplier for the scripted adapter; 0 = no delays. */
  speed?: number;
}

export interface StartRunResponse {
  runId: string;
}

export interface ErrorResponse {
  error: string;
}

/**
 * SSE stream (`GET /api/runs/:id/stream`):
 * - default `message` events carry one RunEvent JSON each, with `id: <sequence>`;
 * - resume with the `Last-Event-ID` header (or `?after=<sequence>`);
 * - an `end` event carries {@link StreamEndData} once the run is terminal, then the server closes.
 *   Clients must call `EventSource.close()` on `end`, or the browser reconnects forever.
 */
export interface StreamEndData {
  status: RunStatus;
  lastSequence: number;
}

export const SSE_END_EVENT = 'end';

export const apiPaths = {
  health: '/api/health',
  runs: '/api/runs',
  run: (runId: string) => `/api/runs/${encodeURIComponent(runId)}`,
  events: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  stream: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/stream`,
  stop: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/stop`,
  pause: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/pause`,
  resume: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/resume`,
  artifact: (runId: string, artifactId: string) =>
    `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
} as const;
