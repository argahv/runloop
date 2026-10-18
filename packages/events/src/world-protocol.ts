/**
 * HTTP + SSE contract for the world, agents and dispatch (plan §4.5).
 * Request bodies are zod schemas (the runtime enforces them); responses are
 * types, with schemas for what Studio validates (snapshot, events, frames).
 *
 * Truth rules carried here:
 * - P2: a command body is `{id, command}` only; a body naming `source` or
 *   `prov` (or anything else) fails to parse and gets 400. HTTP commands are
 *   always source 'user'.
 * - P8: no response carries a workspace's absolute path; only `label` (base
 *   name) and `pathHint` (e.g. "…/code/runloop").
 */
import * as z from 'zod';
import type { RunStatus } from './protocol';
import {
  CommandIdSchema,
  WorldCommandSchema,
  WorldEventSchema,
  WorldProvenanceSchema,
  WorldSpeedSchema,
  TickSchema,
  type AgentAttention,
  type ConnectionHealth,
  type DispatchOutcome,
  type Explanation,
  type RejectCode,
  type RunningSpeed,
  type WorldEvent,
  type WorldSnapshot,
  type WorldSpeed,
} from './world';

// ── World ────────────────────────────────────────────────────────────

/** GET /api/world. When the world is off (RUNLOOP_WORLD=off) every /api/world route answers 404 `{error: 'world_disabled'}`. */
export interface WorldInfoResponse {
  worldId: string;
  townId: string;
  contentHash: string;
  simVersion: number;
  seed: number;
  tick: number;
  seq: number;
  speed: WorldSpeed;
  prevSpeed: RunningSpeed;
  /** The host dropped ticks it could not run in time (plan §4.1). */
  lagging: boolean;
  population: number;
  createdAt: string;
}

/** GET /api/world/town. Validate `town` and `interiors` with @runloop-world/town. */
export interface WorldTownResponse {
  townId: string;
  contentHash: string;
  town: unknown;
  /** Interior definitions by id. */
  interiors: Record<string, unknown>;
}

/** GET /api/world/snapshot */
export type WorldSnapshotResponse = WorldSnapshot;

/** GET /api/world/events query. `after` is exclusive. */
export const WorldEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  actor: z.string().min(1).max(100).optional(),
  type: z.string().min(1).max(60).optional(),
  prov: WorldProvenanceSchema.optional(),
});
export type WorldEventsQuery = z.infer<typeof WorldEventsQuerySchema>;

/** Events in seq order; continue with `after = nextAfter` while `hasMore`. */
export interface WorldEventsPageResponse {
  events: WorldEvent[];
  nextAfter: number;
  hasMore: boolean;
}

/** GET /api/world/explain?ref=resident:res_0012&atSeq=812 (atSeq absent = the latest decision). */
export const ExplainQuerySchema = z.object({
  ref: z.string().regex(/^resident:res_\d{4,}$/),
  atSeq: z.coerce.number().int().min(1).optional(),
});
export interface ExplainResponse {
  explanation: Explanation;
}

/** POST /api/world/commands body (strict: P2). */
export const WorldCommandRequestSchema = z.strictObject({ id: CommandIdSchema, command: WorldCommandSchema });
export type WorldCommandRequest = z.infer<typeof WorldCommandRequestSchema>;

/**
 * 202 once the command was processed (applied or rejected; both are logged).
 * Resubmitting an id returns the first outcome. 400 for an invalid body.
 */
export type WorldCommandResponse = { ok: true; seq: number; tick: number } | { ok: false; code: RejectCode };

/**
 * SSE `GET /api/world/stream` (pattern of http/sse.ts):
 * 1. a `snapshot` event with a WorldSnapshot (also sent again when the client
 *    is more than WORLD_STREAM_RESNAPSHOT events behind);
 * 2. default `message` events with {@link WorldEventsFrame}, `id: <last seq>`;
 * 3. a `clock` event at 1 Hz with {@link WorldClockFrame}.
 * Resume with `Last-Event-ID` (a world seq).
 */
export const WORLD_SSE_SNAPSHOT_EVENT = 'snapshot';
export const WORLD_SSE_CLOCK_EVENT = 'clock';
export const WORLD_STREAM_RESNAPSHOT = 5000;

export const WorldEventsFrameSchema = z.object({ events: z.array(WorldEventSchema).min(1) });
export type WorldEventsFrame = z.infer<typeof WorldEventsFrameSchema>;

export const WorldClockFrameSchema = z.object({
  tick: TickSchema,
  speed: WorldSpeedSchema,
  /** Wall time (ms since epoch) at which `tick` was current; Studio interpolates from it. */
  wallMs: z.int().min(0),
  lagging: z.boolean(),
});
export type WorldClockFrame = z.infer<typeof WorldClockFrameSchema>;

// ── Agents ───────────────────────────────────────────────────────────

export const CAPABILITIES = ['observe', 'inspect', 'submit_task', 'cancel', 'message', 'control'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityState = 'available' | 'needs_setup' | 'unsupported' | 'blocked_by_policy';
/** `reason` says why a capability is not available (null when it is). */
export interface CapabilityStatus {
  state: CapabilityState;
  reason: string | null;
}

/** How a session was bound to an agent (plan §0 Binding). */
export type BindingMethod = 'dispatch' | 'path' | 'claimed';

export interface WorkspaceSummary {
  workspaceId: string;
  /** The root's base name. */
  label: string;
  /** A shortened hint such as "…/code/runloop", never the absolute path (P8). */
  pathHint: string;
}

/** One traced run (session segment) bound to an agent. */
export interface AgentSessionSummary {
  runId: string;
  sessionId: string;
  segment: number;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  bindingMethod: BindingMethod;
}

/** GET /api/agents (list), GET /api/agents/:id */
export interface AgentSummary {
  agentId: string;
  kind: 'claude-code';
  displayName: string;
  hue: string;
  orgId: string;
  lotId: string | null;
  /** The agent's building in the town (null until housed). */
  buildingId: string | null;
  housed: boolean;
  health: ConnectionHealth;
  attention: AgentAttention;
  /** The last hook envelope received for a bound session (null = none yet). */
  lastEventAt: string | null;
  capabilities: Record<Capability, CapabilityStatus>;
  workspace: WorkspaceSummary | null;
  sessions: AgentSessionSummary[];
}

export interface ListAgentsResponse {
  agents: AgentSummary[];
}

export interface AgentDetailResponse {
  agent: AgentSummary;
}

/**
 * POST /api/agents. The workspace is a typed path (it must exist, sit outside
 * the data dir and not be bound yet) or an Arrival's session id. The path is
 * stored only in workspace_roots and never echoed back.
 */
export const CreateAgentRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(60),
  lotId: z.string().regex(/^lot_[a-z0-9_]+$/),
  hue: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  workspace: z.union([
    z.strictObject({ path: z.string().min(1).max(4096) }),
    z.strictObject({ fromSessionId: z.string().min(1).max(200) }),
  ]),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** 201 */
export interface CreateAgentResponse {
  agent: AgentSummary;
}

/** A traced Claude Code session that no agent's workspace contains (GET /api/agents/arrivals). */
export interface ArrivalSummary {
  sessionId: string;
  /** Base name of the session's project. */
  projectLabel: string;
  pathHint: string | null;
  runIds: string[];
  firstSeenAt: string;
  lastEventAt: string | null;
}

export interface ArrivalsResponse {
  arrivals: ArrivalSummary[];
}

/** POST /api/agents/:id/claim: bind the session (and its earlier activity) to the agent. */
export const ClaimSessionRequestSchema = z.strictObject({ sessionId: z.string().min(1).max(200) });
export type ClaimSessionRequest = z.infer<typeof ClaimSessionRequestSchema>;

export interface ClaimSessionResponse {
  agent: AgentSummary;
  /** Runs of the session whose activity was replayed into the world. */
  backfilledRuns: number;
}

// ── Dispatch (S4) ────────────────────────────────────────────────────

/** Tool allowlists for `--permission-mode dontAsk` (plan §4.4). */
export const DISPATCH_PRESETS = {
  read_only: ['Read', 'Grep', 'Glob'],
  edit_test: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(pnpm test:*)'],
} as const;
export type DispatchPreset = keyof typeof DISPATCH_PRESETS;

export const DISPATCH_DEFAULTS = {
  model: 'haiku',
  maxBudgetUsd: 0.25,
  maxBudgetCapUsd: 1,
  timeoutMin: 10,
  nonceTtlMs: 5 * 60_000,
  outputCapBytes: 1024 * 1024,
  cancelGraceMs: 10_000,
} as const;

/** Copy the dialog must show (plan §4.4). */
export const DISPATCH_COPY = {
  billing: 'Billed to your Anthropic account',
  edits: 'Edits land in your working tree',
  done: 'Claude Code reports done',
} as const;

/** POST /api/agents/:id/dispatches/preview */
export const DispatchPreviewRequestSchema = z.strictObject({
  /** Passed as one argv element (no shell); a leading "-" would read as an option, so it is refused. */
  task: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .refine((t) => !t.startsWith('-'), { message: 'a task cannot start with "-" (Claude Code would read it as an option)' }),
  preset: z.enum(['read_only', 'edit_test']),
  model: z
    .string()
    .regex(/^[a-z][a-z0-9.-]{0,63}$/)
    .optional(),
  maxBudgetUsd: z.number().positive().max(DISPATCH_DEFAULTS.maxBudgetCapUsd).optional(),
  timeoutMin: z.int().min(1).max(60).optional(),
});
export type DispatchPreviewRequest = z.infer<typeof DispatchPreviewRequestSchema>;

/**
 * The organisation's dispatch policy (org_policies.dispatch_json for org_home).
 * Requests are checked against it at preview and again at approval.
 */
export interface DispatchPolicy {
  /** Off = Assign task is `blocked_by_policy`. */
  enabled: boolean;
  /** Models a request may name; the first is the default. */
  models: string[];
  defaultBudgetUsd: number;
  /** Hard cap on `--max-budget-usd` (never above DISPATCH_DEFAULTS.maxBudgetCapUsd). */
  maxBudgetUsd: number;
  defaultTimeoutMin: number;
  maxTimeoutMin: number;
  presets: DispatchPreset[];
  /** Dispatches running at once: per agent and in total. */
  maxRunningPerAgent: number;
  maxRunningTotal: number;
}

/** GET /api/dispatches/policy: the policy and the `claude` CLI probe. */
export interface DispatchPolicyResponse {
  policy: DispatchPolicy;
  cli: {
    state: 'unprobed' | 'missing' | 'ok';
    /** `claude --version` as printed (null = unknown). */
    version: string | null;
    /** Why the CLI cannot be used (null when ok). */
    reason: string | null;
  };
}

/** Machine codes of refused dispatch requests (`{error, code}` bodies). */
export type DispatchErrorCode =
  | 'invalid'
  | 'dispatch_disabled'
  | 'unknown_agent'
  | 'unknown_dispatch'
  | 'not_housed'
  | 'no_workspace'
  | 'workspace_moved'
  | 'cli_unavailable'
  | 'blocked_by_policy'
  | 'model_not_allowed'
  | 'preset_not_allowed'
  | 'budget_over_cap'
  | 'timeout_over_cap'
  | 'dispatch_running'
  | 'origin_required'
  | 'bad_nonce'
  | 'nonce_used'
  | 'nonce_expired'
  | 'preview_unknown'
  | 'preview_changed'
  | 'not_running'
  | 'spawn_failed';

/** Exactly what would run. The nonce is single use, valid until `expiresAt`, bound to sha256(argv + cwd + envKeys). */
export interface DispatchPreview {
  previewId: string;
  agentId: string;
  /** The exact argv (`claude -p <task> --session-id … --permission-mode dontAsk …`). */
  argv: string[];
  /** The program argv[0] resolves to (from PATH, at the last CLI probe). */
  executable: string;
  /** `claude --version` at the last probe. */
  cliVersion: string | null;
  /** The pre-assigned session id (`--session-id`): hooks from it bind to this agent. */
  sessionId: string;
  preset: DispatchPreset;
  /** The workspace label the process runs in (the path itself is not returned). */
  workspaceLabel: string;
  /** Names (never values) of the environment variables passed through. */
  envKeys: string[];
  model: string;
  maxBudgetUsd: number;
  timeoutMin: number;
  permissionMode: 'dontAsk';
  allowedTools: string[];
  /** True when `--plugin-dir` is passed (the workspace has never sent a hook). */
  usesPluginDir: boolean;
  approvalNonce: string;
  expiresAt: string;
}

export interface DispatchPreviewResponse {
  preview: DispatchPreview;
}

/** POST /api/dispatches (allowed Origin, JSON, valid nonce; otherwise 403 or 409). */
export const DispatchCreateRequestSchema = z.strictObject({
  previewId: z.string().min(1).max(100),
  approvalNonce: z.string().min(16).max(200),
});
export type DispatchCreateRequest = z.infer<typeof DispatchCreateRequestSchema>;

/** orphaned = after a restart its process is still alive (Stop is offered). */
export type DispatchStatus = 'running' | 'orphaned' | 'finished';

export interface DispatchSummary {
  dispatchId: string;
  agentId: string;
  sessionId: string;
  /** The traced run the session produced (null until its first hook). */
  runId: string | null;
  status: DispatchStatus;
  outcome: DispatchOutcome | null;
  exitCode: number | null;
  /** As reported by Claude Code's final result (null = not reported). */
  reportedCostUsd: number | null;
  /** Turns, as reported by the final result (null = not reported). */
  reportedTurns: number | null;
  /**
   * The final result's text, as reported (redacted; null = not reported, or
   * the runtime restarted since: it is kept in memory only).
   */
  resultText: string | null;
  model: string;
  allowedTools: string[];
  maxBudgetUsd: number;
  timeoutMin: number;
  /** A cancel was requested (by the user or the timeout) and the process is being stopped. */
  stopping: boolean;
  /** Output past the 1 MiB cap was dropped from the stream (the result is still read). */
  outputTruncated: boolean;
  /** Redacted task text, possibly truncated. */
  taskPreview: string;
  startedAt: string;
  endedAt: string | null;
}

/** 201 for POST /api/dispatches; also GET /api/dispatches/:id and POST …/cancel. */
export interface DispatchResponse {
  dispatch: DispatchSummary;
}

/** GET /api/dispatches?agentId=…: newest first (at most 50). */
export interface ListDispatchesResponse {
  dispatches: DispatchSummary[];
}

/**
 * SSE `GET /api/dispatches/:id/stream`: `message` events with one output line
 * each ({@link DispatchOutputFrame}, `id` = its index; resume with
 * Last-Event-ID), then an `end` event (SSE_END_EVENT) with {@link DispatchEndData}.
 * Lines are redacted and the workspace path in them is shortened to its hint
 * (P8). Output is kept in memory only, so after a restart only `end` is sent.
 */
export interface DispatchOutputFrame {
  at: string;
  /** stdout lines are Claude Code's stream-json; stderr lines are plain text. */
  stream: 'stdout' | 'stderr';
  line: string;
}
export interface DispatchEndData {
  status: DispatchStatus;
  outcome: DispatchOutcome | null;
}

// ── Paths ────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export const worldApiPaths = {
  world: '/api/world',
  town: '/api/world/town',
  snapshot: '/api/world/snapshot',
  events: '/api/world/events',
  stream: '/api/world/stream',
  explain: '/api/world/explain',
  commands: '/api/world/commands',
  agents: '/api/agents',
  agent: (agentId: string) => `/api/agents/${enc(agentId)}`,
  arrivals: '/api/agents/arrivals',
  claim: (agentId: string) => `/api/agents/${enc(agentId)}/claim`,
  dispatchPreview: (agentId: string) => `/api/agents/${enc(agentId)}/dispatches/preview`,
  dispatches: '/api/dispatches',
  dispatchPolicy: '/api/dispatches/policy',
  dispatch: (dispatchId: string) => `/api/dispatches/${enc(dispatchId)}`,
  dispatchStream: (dispatchId: string) => `/api/dispatches/${enc(dispatchId)}/stream`,
  dispatchCancel: (dispatchId: string) => `/api/dispatches/${enc(dispatchId)}/cancel`,
} as const;
