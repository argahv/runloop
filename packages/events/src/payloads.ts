import * as z from 'zod';

const id = z.string().min(1);

export const AgentRuntimeStateSchema = z.enum(['idle', 'working', 'waiting', 'blocked', 'failed', 'done']);
export type AgentRuntimeState = z.infer<typeof AgentRuntimeStateSchema>;

/** `turn` and `delegated` come from traced sessions (a user turn; work handed to a subagent). */
export const TaskKindSchema = z.enum(['research', 'code', 'test', 'fix', 'approval', 'deploy', 'turn', 'delegated']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const RunOutcomeSchema = z.enum(['succeeded', 'failed', 'stopped', 'interrupted']);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const ToolFailureTypeSchema = z.enum([
  'timeout',
  'denied',
  'aborted',
  'spawn_error',
  'exception',
  'runtime_restarted',
  /** Traced runs: the source never reported how the call ended (Runloop closed it, inferred). */
  'unobserved',
]);
export type ToolFailureType = z.infer<typeof ToolFailureTypeSchema>;

export const ArtifactKindSchema = z.enum(['file', 'diff', 'log', 'test_report']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const AdapterInfoSchema = z.object({
  id,
  /** `external`: the agent ran outside Runloop and Runloop only recorded it (traced runs). */
  kind: z.enum(['scripted', 'llm', 'external']),
  /** Human-readable label shown in the UI, e.g. "Scripted adapter — deterministic decisions, real tools". */
  label: z.string(),
});
export type AdapterInfo = z.infer<typeof AdapterInfoSchema>;

export const TestMetricsSchema = z.object({
  tests: z.int().min(0),
  passed: z.int().min(0),
  failed: z.int().min(0),
});
export type TestMetrics = z.infer<typeof TestMetricsSchema>;

/** executed: Runloop's runtime ran the tools. traced: Runloop recorded what an external agent reported. */
export const RunModeSchema = z.enum(['executed', 'traced']);
export type RunMode = z.infer<typeof RunModeSchema>;

/** Where a traced run came from. Paths are never stored: only the project's base name. */
export const TraceSourceSchema = z.object({
  kind: z.literal('claude-code'),
  sessionId: id,
  /** 1 for the first run of a session; a continuation after a restart or idle close is n+1. */
  segment: z.int().min(1),
  projectLabel: z.string().max(200),
  /** null = the source did not report it. */
  model: z.string().nullable().optional(),
  permissionMode: z.string().optional(),
  /** SessionStart `source` (startup, resume, clear, compact). */
  startSource: z.string().optional(),
  pluginVersion: z.string().optional(),
  continuesRunId: z.uuid().optional(),
});
export type TraceSource = z.infer<typeof TraceSourceSchema>;

/** Coarse kind of a tool call; the world maps categories to stations. */
export const ToolCategorySchema = z.enum([
  'read',
  'search',
  'web',
  'edit',
  'execute',
  'test',
  'deploy',
  'mcp',
  'delegate',
  'plan',
  'other',
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

export const RunMarkerKindSchema = z.enum(['compaction', 'notification', 'api_error', 'session_resumed', 'model_switch', 'other']);
export type RunMarkerKind = z.infer<typeof RunMarkerKindSchema>;

const runStartedSchema = z
  .object({
    title: z.string(),
    missionId: id,
    worldId: id,
    /** Executed runs only. */
    seed: z.int().optional(),
    adapter: AdapterInfoSchema,
    /** Workspace path relative to the runtime data dir (never an absolute host path). Executed runs only. */
    workspace: z.string().optional(),
    /**
     * Executed runs: the scripted adapter's pacing multiplier (1 = normal,
     * 0 = no delays). Durations of runs at different paces are not comparable.
     * Absent = not recorded (logs before 2026-10-18, and traced runs).
     */
    speed: z.number().min(0).optional(),
    /** Absent means executed. */
    mode: RunModeSchema.optional(),
    /** Traced runs only. */
    source: TraceSourceSchema.optional(),
  })
  .superRefine((p, ctx) => {
    const traced = p.mode === 'traced';
    if (traced !== (p.source !== undefined) || traced !== (p.adapter.kind === 'external')) {
      ctx.addIssue({
        code: 'custom',
        message: "mode 'traced' requires a source and an external adapter (and only traced runs have them)",
        path: ['mode'],
      });
    }
    if (!traced && (p.seed === undefined || p.workspace === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'executed runs need a seed and a workspace', path: ['seed'] });
    }
  });

/** Payload schemas keyed by event type. */
export const payloadSchemas = {
  // ── Run lifecycle ────────────────────────────────────────────────
  'run.started': runStartedSchema,
  'run.paused': z.object({ reason: z.string().optional() }),
  'run.resumed': z.object({}),
  'run.completed': z.object({
    outcome: RunOutcomeSchema,
    summary: z.string().optional(),
  }),
  /** A notable moment that is not a task or a tool call (compaction, a notification, an API error). */
  'run.marker': z.object({
    kind: RunMarkerKindSchema,
    label: z.string(),
    detail: z.string().optional(),
    agentId: id.optional(),
  }),

  // ── Agents ───────────────────────────────────────────────────────
  'agent.registered': z.object({
    agentId: id,
    name: z.string(),
    role: z.string(),
    model: z.string().nullable(),
    tools: z.array(z.string()),
    /** false = no character in the world (e.g. the coordinator). */
    embodied: z.boolean(),
    characterPreset: id.optional(),
  }),
  'agent.state_changed': z.object({
    agentId: id,
    state: AgentRuntimeStateSchema,
    reason: z.string().optional(),
  }),
  'agent.message_sent': z.object({
    messageId: id,
    fromAgentId: id,
    /** An agentId, or 'all'. */
    to: id,
    text: z.string(),
  }),
  /**
   * Token usage as reported by the source (never estimated). Absent fields
   * were not reported; an agent without this event has no reported usage.
   */
  'agent.usage_reported': z.object({
    agentId: id,
    /** Model the source says it used; null = not reported. */
    model: z.string().nullable(),
    inputTokens: z.int().min(0),
    outputTokens: z.int().min(0),
    cacheReadTokens: z.int().min(0).optional(),
    cacheCreationTokens: z.int().min(0).optional(),
    totalTokens: z.int().min(0).optional(),
    durationMs: z.number().min(0).optional(),
    toolUseCount: z.int().min(0).optional(),
    /** The call whose result carried the report (e.g. the delegating Agent call). */
    callId: id.optional(),
    /** Where the numbers come from, e.g. 'claude-code.agent_result'. */
    source: z.string().min(1),
  }),

  // ── Tasks ────────────────────────────────────────────────────────
  'task.created': z.object({
    taskId: id,
    title: z.string(),
    kind: TaskKindSchema,
    dependsOn: z.array(id),
    acceptance: z.string().optional(),
    /** Number of tool calls the task is expected to take; enables a progress bar. */
    plannedSteps: z.int().min(1).optional(),
  }),
  'task.assigned': z.object({ taskId: id, agentId: id }),
  /** Each task.started counts as one attempt. */
  'task.started': z.object({ taskId: id, agentId: id }),
  'task.blocked': z.object({
    taskId: id,
    reason: z.string(),
    blockedBy: z.array(id).optional(),
  }),
  'task.completed': z.object({
    taskId: id,
    summary: z.string(),
    artifactIds: z.array(id),
  }),
  'task.failed': z.object({
    taskId: id,
    reason: z.string(),
    errorType: z.string().optional(),
  }),

  // ── Tools ────────────────────────────────────────────────────────
  'tool.call_started': z.object({
    callId: id,
    agentId: id,
    taskId: id.optional(),
    tool: id,
    /** Traced runs: the coarse kind of call (drives the station in the world). */
    category: ToolCategorySchema.optional(),
    inputSummary: z.string(),
    /**
     * What the call acts on, when the source names it: a file or directory
     * path (relative to the project/workspace when inside it, otherwise
     * shortened like inputSummary) or a command's first word. Absent = not
     * reported. Compare uses it for "files touched" (DL-008).
     */
    target: z.string().min(1).max(300).optional(),
  }),
  /** The tool ran. A failing test run is status "error" with real metrics. */
  'tool.call_completed': z.object({
    callId: id,
    status: z.enum(['success', 'error']),
    durationMs: z.number().min(0),
    exitCode: z.int().optional(),
    outputSummary: z.string(),
    metrics: TestMetricsSchema.optional(),
    failingTests: z.array(z.string()).optional(),
    outputArtifactIds: z.array(id).optional(),
    errorType: z.string().optional(),
  }),
  /** The tool could not run at all (denied, timed out, aborted, ...). */
  'tool.call_failed': z.object({
    callId: id,
    errorType: ToolFailureTypeSchema,
    message: z.string(),
    durationMs: z.number().min(0),
  }),
  'tool.permission_requested': z.object({
    permissionId: id,
    agentId: id,
    callId: id.optional(),
    action: z.string(),
    scope: z.string(),
  }),
  'tool.permission_resolved': z.object({
    permissionId: id,
    decision: z.enum(['approved', 'denied']),
    by: z.string(),
  }),

  // ── Artifacts ────────────────────────────────────────────────────
  'artifact.created': z.object({
    artifactId: id,
    kind: ArtifactKindSchema,
    name: z.string(),
    mediaType: z.string(),
    bytes: z.int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Path inside the run workspace, when the artifact mirrors a workspace file. */
    path: z.string().optional(),
    producedByCallId: id.optional(),
    summary: z.string(),
  }),
} as const;

export type PayloadSchemas = typeof payloadSchemas;
export type EventType = keyof PayloadSchemas;
export type PayloadOf<T extends EventType> = z.infer<PayloadSchemas[T]>;

export const EVENT_TYPES = Object.keys(payloadSchemas) as EventType[];
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(type: string): type is EventType {
  return EVENT_TYPE_SET.has(type);
}
