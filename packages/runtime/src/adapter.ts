import type { AdapterInfo, EventOf, EventType, PayloadOf, TestMetrics } from '@runloop-world/events';
import type { Mission } from './mission';

/**
 * Event types an adapter may emit itself. run.*, tool.* and artifact.* are
 * produced only by the runtime (run manager and tool invoker), so an adapter
 * cannot fabricate a tool result or an outcome.
 */
export type AdapterEventType = Exclude<EventType, `run.${string}` | `tool.${string}` | `artifact.${string}`>;

export function isAdapterEventType(type: string): type is AdapterEventType {
  return !/^(run|tool|artifact)\./.test(type);
}

export type ToolCall =
  | { tool: 'list_files'; path?: string }
  | { tool: 'read_file'; path: string }
  /** `summary` is the agent's description of the change; it labels the file artifact. */
  | { tool: 'write_file'; path: string; content: string; summary?: string }
  | { tool: 'run_command'; argv: string[] };

export type ToolName = ToolCall['tool'];

export interface ToolResult {
  callId: string;
  /**
   * success / error: the tool ran (tool.call_completed; a failing test run is "error").
   * failed: the tool could not run at all (tool.call_failed).
   */
  status: 'success' | 'error' | 'failed';
  durationMs: number;
  /** The outputSummary that was recorded (for "failed": the failure message). */
  outputSummary: string;
  errorType?: string;
  exitCode?: number;
  metrics?: TestMetrics;
  failingTests?: string[];
  artifactIds: string[];
  /** Raw tool output for the agent's next decision (file content, listing, stdout). Not recorded. */
  output?: string;
}

export interface RunContext {
  readonly runId: string;
  /** Aborted when the run is stopped. */
  readonly signal: AbortSignal;
  /** Pacing multiplier; 0 = no delays. */
  readonly speed: number;
  emit<T extends AdapterEventType>(
    type: T,
    payload: PayloadOf<T>,
    meta?: { actorId?: string; taskId?: string },
  ): EventOf<T>;
  readonly tools: {
    /** Emits tool.call_started → artifact.created* → tool.call_completed | tool.call_failed. */
    invoke(agentId: string, taskId: string, call: ToolCall): Promise<ToolResult>;
  };
  /** Wait `ms / speed` (abortable), then wait while the run is paused. */
  pace(ms: number): Promise<void>;
}

export interface AdapterResult {
  outcome: 'succeeded' | 'failed';
  summary: string;
}

export interface AgentAdapter {
  readonly info: AdapterInfo;
  run(ctx: RunContext, mission: Mission): Promise<AdapterResult>;
}

/** The error thrown by ctx.pace / ctx.emit / tools.invoke once the run is stopped. */
export function abortError(): Error {
  return new DOMException('The run was stopped', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
