import type { ExecState } from '@runloop-world/core';
import type { TaskKind } from '@runloop-world/events';
import type { ActivityRule, StationKind } from './definition';
import type { Activity, CompiledWorld } from './types';

export interface Intent {
  activity: Activity;
  taskId: string | null;
  /** Station kind to go to; null = home (or stay, for 'failed'). */
  stationKind: StationKind | null;
}

const IDLE: Intent = { activity: 'idle', taskId: null, stationKind: null };

/**
 * First matching activity rule. Rules with `permission: true` only apply to a
 * pending permission request, and other rules only apply to work.
 */
export function matchActivityRule(
  rules: readonly ActivityRule[],
  ctx: { taskKind: TaskKind | null; permission: boolean },
): StationKind | null {
  for (const r of rules) {
    if (Boolean(r.when.permission) !== ctx.permission) continue;
    if (r.when.taskKind && (!ctx.taskKind || !r.when.taskKind.includes(ctx.taskKind))) continue;
    return r.stationKind;
  }
  return null;
}

/**
 * What the world wants an agent's character to do, from Layer-1 state only.
 * Priority: failed → awaiting_approval → waiting (blocked) → working →
 * succeeded (last task completed, nothing current) → idle.
 */
export function deriveIntent(exec: ExecState, agentId: string, world: CompiledWorld): Intent {
  const agent = exec.agents[agentId];
  if (!agent) return IDLE;
  const task = agent.currentTaskId ? (exec.tasks[agent.currentTaskId] ?? null) : null;
  const last = agent.lastTaskOutcome;
  const rules = world.def.activityRules;

  const lastFailed = !task && last?.status === 'failed' && exec.tasks[last.taskId]?.status === 'failed';
  if (agent.state === 'failed' || task?.status === 'failed' || lastFailed) {
    return { activity: 'failed', taskId: task?.id ?? last?.taskId ?? null, stationKind: null };
  }

  const perm = agent.pendingPermissionId ? exec.permissions[agent.pendingPermissionId] : undefined;
  if (perm?.status === 'pending') {
    return {
      activity: 'awaiting_approval',
      taskId: task?.id ?? null,
      stationKind: matchActivityRule(rules, { taskKind: task?.kind ?? null, permission: true }),
    };
  }

  if (task?.status === 'blocked') return { activity: 'waiting', taskId: task.id, stationKind: null };

  if (task && (task.status === 'assigned' || task.status === 'in_progress')) {
    return {
      activity: 'working',
      taskId: task.id,
      stationKind: matchActivityRule(rules, { taskKind: task.kind, permission: false }),
    };
  }

  if (!task && last?.status === 'completed') return { activity: 'succeeded', taskId: last.taskId, stationKind: null };
  return IDLE;
}
