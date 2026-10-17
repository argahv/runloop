import type {
  AdapterInfo,
  AgentRuntimeState,
  ArtifactKind,
  PayloadOf,
  TaskKind,
  TestMetrics,
  ToolFailureType,
} from '@runloop-world/events';

/** Layer 1 — execution truth, folded from recorded events only. */

export type RunExecStatus = 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';

export interface RunExec {
  status: RunExecStatus;
  title: string;
  missionId: string;
  worldId: string;
  seed: number;
  adapter: AdapterInfo | null;
  workspace: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
}

export interface AgentExec {
  id: string;
  name: string;
  role: string;
  model: string | null;
  tools: string[];
  embodied: boolean;
  characterPreset: string | null;
  state: AgentRuntimeState;
  stateReason: string | null;
  /** Task the agent currently owns and has not finished (assigned / in progress / blocked). */
  currentTaskId: string | null;
  /** Tool call in flight, if any. */
  activeCallId: string | null;
  pendingPermissionId: string | null;
  /** Most recent task outcome for this agent (drives brief success/failure reactions). */
  lastTaskOutcome: { taskId: string; status: 'completed' | 'failed'; seq: number } | null;
  registeredSeq: number;
}

export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export interface TaskExec {
  id: string;
  title: string;
  kind: TaskKind;
  dependsOn: string[];
  acceptance: string | null;
  plannedSteps: number | null;
  status: TaskStatus;
  ownerId: string | null;
  /** Number of task.started events seen. */
  attempts: number;
  createdSeq: number;
  /** Agent (or 'system') that created the task, from the envelope actorId. */
  createdBy: string | null;
  startedSeq: number | null;
  endedSeq: number | null;
  blockedReason: string | null;
  blockedBy: string[];
  failure: { reason: string; errorType: string | null } | null;
  summary: string | null;
  artifactIds: string[];
  /** Tool calls made for this task, in order (across attempts). */
  callIds: string[];
  /** Tool calls finished (any terminal status) during the current attempt. */
  stepsDoneThisAttempt: number;
}

export type ToolCallStatus = 'running' | 'success' | 'error' | 'failed';

export interface ToolCallExec {
  id: string;
  agentId: string;
  taskId: string | null;
  tool: string;
  inputSummary: string;
  status: ToolCallStatus;
  startedSeq: number;
  startedAt: string;
  startedEventId: string;
  endedSeq: number | null;
  endedAt: string | null;
  endedEventId: string | null;
  durationMs: number | null;
  exitCode: number | null;
  outputSummary: string | null;
  metrics: TestMetrics | null;
  failingTests: string[];
  outputArtifactIds: string[];
  /** tool.call_completed errorType, or tool.call_failed errorType. */
  errorType: string | ToolFailureType | null;
  /** tool.call_failed message. */
  message: string | null;
}

export interface PermissionExec {
  id: string;
  agentId: string;
  callId: string | null;
  action: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied';
  requestedSeq: number;
  resolvedSeq: number | null;
  resolvedBy: string | null;
}

export type ArtifactExec = PayloadOf<'artifact.created'> & {
  kind: ArtifactKind;
  seq: number;
  eventId: string;
  agentId: string | null;
  taskId: string | null;
  createdAt: string;
};

export type MessageExec = PayloadOf<'agent.message_sent'> & {
  seq: number;
  eventId: string;
  timestamp: string;
};

export type IncidentKind = 'tool_error' | 'tool_failed' | 'task_failed' | 'run_failed';

/** A failure worth marking in the world and the trace. */
export interface Incident {
  seq: number;
  eventId: string;
  kind: IncidentKind;
  /** callId, taskId or runId depending on kind. */
  refId: string;
  agentId: string | null;
  taskId: string | null;
  message: string;
  /** Sequence at which the related task later completed (marker greys out), if it did. */
  resolvedSeq: number | null;
}

/** Something in the log this version could not interpret or that contradicts earlier events. */
export interface Anomaly {
  seq: number;
  code:
    | 'unknown_event'
    | 'unknown_agent'
    | 'unknown_task'
    | 'unknown_call'
    | 'unknown_permission'
    | 'duplicate_id'
    | 'unknown_dependency'
    | 'dependency_cycle'
    | 'invalid_transition';
  detail: string;
}

export interface ExecState {
  /** Last folded sequence (0 = nothing folded). */
  lastSequence: number;
  runId: string | null;
  /** Timestamp (ms since epoch) of the first event folded (normally run.started). */
  runStartMs: number | null;
  run: RunExec;
  agents: Record<string, AgentExec>;
  agentOrder: string[];
  tasks: Record<string, TaskExec>;
  taskOrder: string[];
  toolCalls: Record<string, ToolCallExec>;
  callOrder: string[];
  permissions: Record<string, PermissionExec>;
  artifacts: Record<string, ArtifactExec>;
  artifactOrder: string[];
  messages: MessageExec[];
  incidents: Incident[];
  anomalies: Anomaly[];
}

/** A chip in the Agent Flow row, one per task kind in first-seen order. */
export interface FlowChip {
  kind: TaskKind;
  status: 'pending' | 'current' | 'done' | 'failed';
  taskIds: string[];
}

/** One line of the text trace / CLI output for an event. */
export interface FormattedEvent {
  seq: number;
  /** "mm:ss.s" since run start. */
  clock: string;
  actor: string;
  type: string;
  label: string;
  detail: string | null;
  severity: 'info' | 'ok' | 'warn' | 'error';
}
