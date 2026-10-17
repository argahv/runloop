import {
  formatClock,
  selectAgentFlow,
  type ExecState,
  type FlowChip,
  type RunExecStatus,
  type TaskStatus,
  type ToolCallStatus,
} from '@runloop-world/core';
import type { RunStatus, TaskKind } from '@runloop-world/events';
import type { Activity, CompiledWorld, PresentationState } from '@runloop-world/world-engine';

/** Every status is shown as icon + text (never colour alone); `tone` picks the colour. */
export interface StatusView {
  icon: string;
  text: string;
  tone: 'ok' | 'err' | 'warn' | 'info' | 'live' | 'muted';
}

export const KIND_LABEL: Record<TaskKind, string> = {
  research: 'Research',
  code: 'Code',
  test: 'Test',
  fix: 'Fix',
  approval: 'Approval',
  deploy: 'Deploy',
};

const FLOW_STATUS: Record<FlowChip['status'], StatusView> = {
  pending: { icon: '○', text: 'pending', tone: 'muted' },
  current: { icon: '◉', text: 'in progress', tone: 'live' },
  blocked: { icon: '⏳', text: 'blocked', tone: 'warn' },
  done: { icon: '✓', text: 'done', tone: 'ok' },
  failed: { icon: '✗', text: 'failed', tone: 'err' },
};

/** Work left open when the run ended (stopped, interrupted, failed): nothing is in progress any more. */
const UNFINISHED: StatusView = { icon: '■', text: 'unfinished', tone: 'muted' };

const RUN_ENDED: ReadonlySet<RunExecStatus> = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);

/** The run has a terminal status: nothing executes any more. */
export function runHasEnded(exec: ExecState): boolean {
  return RUN_ENDED.has(exec.run.status);
}

export interface FlowChipView extends FlowChip {
  label: string;
  view: StatusView;
}

/** Agent Flow chips (core selectAgentFlow) with labels and status icons. */
export function flowChips(exec: ExecState): FlowChipView[] {
  const ended = runHasEnded(exec);
  return selectAgentFlow(exec).map((c) => ({
    ...c,
    label: KIND_LABEL[c.kind],
    view: ended && (c.status === 'current' || c.status === 'blocked') ? UNFINISHED : FLOW_STATUS[c.status],
  }));
}

const RUN_STATUS: Record<RunStatus | RunExecStatus, StatusView> = {
  pending: { icon: '○', text: 'pending', tone: 'muted' },
  running: { icon: '●', text: 'running', tone: 'live' },
  paused: { icon: '⏸', text: 'paused', tone: 'warn' },
  succeeded: { icon: '✓', text: 'succeeded', tone: 'ok' },
  failed: { icon: '✗', text: 'failed', tone: 'err' },
  stopped: { icon: '■', text: 'stopped', tone: 'warn' },
  interrupted: { icon: '⚠', text: 'interrupted', tone: 'warn' },
};

export function runStatusView(status: RunStatus | RunExecStatus, paused = false): StatusView {
  return paused && status === 'running' ? RUN_STATUS.paused : RUN_STATUS[status];
}

const CHARACTER_STATUS: Record<PresentationState | Activity, StatusView> = {
  idle: { icon: '◌', text: 'idle', tone: 'muted' },
  moving: { icon: '➜', text: 'moving', tone: 'info' },
  working: { icon: '⚙', text: 'working', tone: 'live' },
  waiting: { icon: '…', text: 'waiting', tone: 'warn' },
  awaiting_approval: { icon: '🔒', text: 'awaiting approval', tone: 'warn' },
  succeeded: { icon: '✓', text: 'done', tone: 'ok' },
  failed: { icon: '✗', text: 'failed', tone: 'err' },
  paused: { icon: '⏸', text: 'paused', tone: 'warn' },
};

export function characterStatusView(state: PresentationState | Activity): StatusView {
  return CHARACTER_STATUS[state];
}

/** Scrubber clock: "mm:ss / mm:ss". */
export function formatClockPair(tMs: number, endMs: number): string {
  return `${formatClock(tMs)} / ${formatClock(Math.max(tMs, endMs))}`;
}

export interface AgentLook {
  name: string;
  /** CSS colour (the world's character preset colour for embodied agents). */
  color: string;
  embodied: boolean;
}

/** Display name and colour for an agent id ('system' and unknown ids included). */
export function agentLook(exec: ExecState, world: CompiledWorld | null, agentId: string): AgentLook {
  const a = exec.agents[agentId];
  if (!a) return { name: agentId === 'system' ? 'System' : agentId, color: 'var(--role-system)', embodied: false };
  if (!a.embodied || !world) return { name: a.name, color: 'var(--role-system)', embodied: a.embodied };
  const preset = (a.characterPreset ? world.presetsById[a.characterPreset] : undefined) ?? world.presetsById[world.def.defaultPreset];
  return { name: a.name, color: preset?.color ?? 'var(--role-system)', embodied: true };
}

const TASK_STATUS: Record<TaskStatus, StatusView> = {
  pending: { icon: '○', text: 'pending', tone: 'muted' },
  assigned: { icon: '→', text: 'assigned', tone: 'info' },
  in_progress: { icon: '◉', text: 'in progress', tone: 'live' },
  blocked: { icon: '⏳', text: 'blocked', tone: 'warn' },
  completed: { icon: '✓', text: 'completed', tone: 'ok' },
  failed: { icon: '✗', text: 'failed', tone: 'err' },
};

/** A task's status; open tasks of a run that has ended show as unfinished. */
export function taskStatusView(status: TaskStatus, runEnded = false): StatusView {
  if (runEnded && (status === 'assigned' || status === 'in_progress' || status === 'blocked')) return UNFINISHED;
  return TASK_STATUS[status];
}

const CALL_STATUS: Record<ToolCallStatus, StatusView> = {
  running: { icon: '⚙', text: 'running', tone: 'live' },
  success: { icon: '✓', text: 'success', tone: 'ok' },
  error: { icon: '✗', text: 'error', tone: 'err' },
  failed: { icon: '⊘', text: 'could not run', tone: 'err' },
};

export function callStatusView(status: ToolCallStatus): StatusView {
  return CALL_STATUS[status];
}
