import type { TaskKind } from '@runloop-world/events';
import type { AgentExec, ExecState, FlowChip, Incident, TaskExec, ToolCallExec } from './types';

/** Pending tasks whose dependencies have all completed (readiness is computed, never stored). */
export function selectReadyTasks(s: ExecState): TaskExec[] {
  return s.taskOrder
    .map((id) => s.tasks[id]!)
    .filter((t) => t.status === 'pending' && t.dependsOn.every((d) => s.tasks[d]?.status === 'completed'));
}

/** The agent's most recent tool calls, newest first. */
export function selectRecentActions(s: ExecState, agentId: string, n = 5): ToolCallExec[] {
  const out: ToolCallExec[] = [];
  for (let i = s.callOrder.length - 1; i >= 0 && out.length < n; i--) {
    const c = s.toolCalls[s.callOrder[i]!]!;
    if (c.agentId === agentId) out.push(c);
  }
  return out;
}

/**
 * Progress of a task in 0..1: finished tool calls of the current attempt over
 * `plannedSteps`. Completed → 1. `null` = indeterminate (no plannedSteps, or unknown task).
 */
export function selectTaskProgress(s: ExecState, taskId: string): number | null {
  const t = s.tasks[taskId];
  if (!t) return null;
  if (t.status === 'completed') return 1;
  if (t.plannedSteps === null) return null;
  return Math.min(1, t.stepsDoneThisAttempt / t.plannedSteps);
}

/**
 * One chip per task kind, in first-seen order. A chip is `current` while any of
 * its tasks is active (assigned / in progress / blocked), else `failed` if one
 * failed, else `done` when all completed, else `pending`.
 */
export function selectAgentFlow(s: ExecState): FlowChip[] {
  const byKind = new Map<TaskKind, TaskExec[]>();
  for (const id of s.taskOrder) {
    const t = s.tasks[id]!;
    const list = byKind.get(t.kind);
    if (list) list.push(t);
    else byKind.set(t.kind, [t]);
  }
  return [...byKind].map(([kind, tasks]) => {
    let status: FlowChip['status'] = 'pending';
    if (tasks.some((t) => t.status === 'assigned' || t.status === 'in_progress' || t.status === 'blocked')) status = 'current';
    else if (tasks.some((t) => t.status === 'failed')) status = 'failed';
    else if (tasks.every((t) => t.status === 'completed')) status = 'done';
    return { kind, status, taskIds: tasks.map((t) => t.id) };
  });
}

/** Agents that get a character in the world, in registration order. */
export function selectEmbodiedAgents(s: ExecState): AgentExec[] {
  return s.agentOrder.map((id) => s.agents[id]!).filter((a) => a.embodied);
}

/** Incidents whose task has not (yet) completed. */
export function selectOpenIncidents(s: ExecState): Incident[] {
  return s.incidents.filter((i) => i.resolvedSeq === null);
}
