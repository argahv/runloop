/**
 * HTTP + SSE contract between the local runtime and Studio. Studio imports
 * these types and never imports the runtime package itself.
 */
import type { RunMode, RunOutcome } from './payloads';

/** 4380, not 4317: 4317 is the OTLP/gRPC default (DL-005). */
export const DEFAULT_RUNTIME_PORT = 4380;
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
  /** Always set by this runtime; optional so older payloads still type-check. Absent = executed. */
  mode?: RunMode;
  /** Traced runs: where the run came from. null for executed runs. */
  source?: RunSourceSummary | null;
  /** Timestamp of the last recorded event (null before any). */
  lastEventAt?: string | null;
  /** When the run was pinned as a baseline (null = not pinned). Absent on older runtimes. */
  pinnedAt?: string | null;
}

export interface RunSourceSummary {
  kind: 'claude-code';
  sessionId: string;
  segment: number;
  projectLabel: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  /** The scripted (executed) run in progress. Traced runs never set it. */
  activeRunId: string | null;
  /** Traced runs that are still open, newest first. */
  tracedRunIds: string[];
  /** Ingest endpoints this runtime accepts; null when tracing is turned off. */
  ingest: { claudeCode: { protocol: 1 } } | null;
}

export interface ListRunsResponse {
  runs: RunSummary[];
}

/** `world` is a WorldDefinition JSON object; validate it with @runloop-world/world-engine. */
export interface RunDetailResponse {
  run: RunSummary;
  world: unknown;
  /** The task dispatch that started this run's session (null = none, or dispatch is off). */
  dispatch?: RunDispatchInfo | null;
}

/** A dispatched run's source report: what Claude Code's final `result` said for the session. */
export interface RunDispatchInfo {
  dispatchId: string;
  /** total_cost_usd for the whole session as Claude Code reported it (null = not reported yet, or never). */
  reportedCostUsd: number | null;
  /** Runs the session was recorded as: the cost covers all of them, so it is one run's cost only when this is 1. */
  sessionRuns: number;
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

/**
 * POST /api/runs/:id/baseline pins the run as a baseline (idempotent: an
 * already pinned run keeps its pinnedAt); DELETE unpins it. Both need
 * `Content-Type: application/json` (send `{}`), like every other write.
 */
export interface BaselineResponse {
  run: RunSummary;
}

export interface ErrorResponse {
  error: string;
}

/**
 * One Claude Code hook invocation as the plugin sends it (protocol v1). `hook`
 * is the hook's stdin JSON after the plugin slimmed and redacted it.
 */
export interface ClaudeCodeHookEnvelope {
  v: 1;
  /** Unique per hook invocation; spool retries reuse it, so ingest is idempotent. */
  deliveryId: string;
  /** When the hook process ran (ISO 8601). Used as the event time. */
  observedAt: string;
  /** Parent process id of the hook (the Claude Code process). */
  ppid?: number;
  plugin: { name: string; version: string };
  hook: Record<string, unknown>;
}

/** POST /api/ingest/claude-code, with the `X-Runloop-Token` header. 1–100 envelopes. */
export interface ClaudeCodeIngestRequest {
  envelopes: ClaudeCodeHookEnvelope[];
}

/** 202. accepted = recorded; duplicates = already seen; ignored = not mapped (unknown hook, late, invalid). */
export interface ClaudeCodeIngestResponse {
  accepted: number;
  duplicates: number;
  ignored: number;
}

/** Header carrying the per-user ingest token. */
export const INGEST_TOKEN_HEADER = 'X-Runloop-Token';

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
  baseline: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/baseline`,
  artifact: (runId: string, artifactId: string) =>
    `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
  ingestClaudeCode: '/api/ingest/claude-code',
} as const;
