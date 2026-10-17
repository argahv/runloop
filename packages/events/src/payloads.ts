import * as z from 'zod';

const id = z.string().min(1);

export const AgentRuntimeStateSchema = z.enum(['idle', 'working', 'waiting', 'blocked', 'failed', 'done']);
export type AgentRuntimeState = z.infer<typeof AgentRuntimeStateSchema>;

export const TaskKindSchema = z.enum(['research', 'code', 'test', 'fix', 'approval', 'deploy']);
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
]);
export type ToolFailureType = z.infer<typeof ToolFailureTypeSchema>;

export const ArtifactKindSchema = z.enum(['file', 'diff', 'log', 'test_report']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const AdapterInfoSchema = z.object({
  id,
  kind: z.enum(['scripted', 'llm']),
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

/** Payload schemas keyed by event type. */
export const payloadSchemas = {
  // ── Run lifecycle ────────────────────────────────────────────────
  'run.started': z.object({
    title: z.string(),
    missionId: id,
    worldId: id,
    seed: z.int(),
    adapter: AdapterInfoSchema,
    /** Workspace path relative to the runtime data dir (never an absolute host path). */
    workspace: z.string(),
  }),
  'run.paused': z.object({ reason: z.string().optional() }),
  'run.resumed': z.object({}),
  'run.completed': z.object({
    outcome: RunOutcomeSchema,
    summary: z.string().optional(),
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
    inputSummary: z.string(),
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
