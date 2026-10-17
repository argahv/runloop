import type { ExecState } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent } from '@runloop-world/events';

/** What the inspector shows: the selected event, the selected agent's card, or the run summary. */
export type InspectorTab = 'event' | 'agent' | 'run';

const known = (exec: ExecState, id: string | null | undefined): string | null => (id && exec.agents[id] ? id : null);

/**
 * The registered agent an event is about: its actor, else the agent behind
 * its tool call, permission, artifact or task. Null for system events and
 * unknown ids. `exec` should be the latest state (ids only ever get added).
 */
export function agentOfEvent(e: AnyEvent, exec: ExecState): string | null {
  const actor = known(exec, e.actorId);
  const taskOwner = () => (e.taskId ? known(exec, exec.tasks[e.taskId]?.ownerId) : null);
  if (isUnknownEvent(e)) return actor ?? taskOwner();
  switch (e.type) {
    case 'tool.call_completed':
    case 'tool.call_failed':
      return known(exec, exec.toolCalls.get(e.payload.callId)?.agentId) ?? actor;
    case 'tool.permission_resolved':
      return known(exec, exec.permissions[e.payload.permissionId]?.agentId) ?? actor;
    case 'artifact.created': {
      const viaCall = e.payload.producedByCallId ? exec.toolCalls.get(e.payload.producedByCallId)?.agentId : null;
      return actor ?? known(exec, exec.artifacts[e.payload.artifactId]?.agentId) ?? known(exec, viaCall);
    }
    case 'task.created':
    case 'task.blocked':
    case 'task.completed':
    case 'task.failed': {
      // task.created's actor is the creator (e.g. the coordinator); the task is about its owner.
      const owner = known(exec, exec.tasks[e.payload.taskId]?.ownerId);
      return e.type === 'task.created' ? (actor ?? owner) : (owner ?? actor);
    }
    default:
      return actor ?? taskOwner();
  }
}

/** Sequence of the latest event about `agentId` at or before `uptoSeq`, or null. */
export function latestEventOf(events: readonly AnyEvent[], exec: ExecState, agentId: string, uptoSeq: number): number | null {
  for (let i = Math.min(uptoSeq, events.length) - 1; i >= 0; i--) {
    const e = events[i]!;
    if (agentOfEvent(e, exec) === agentId) return e.sequence;
  }
  return null;
}

/** Causal ancestors via parentEventId, nearest first (bounded, cycle-safe). */
export function parentChain(e: AnyEvent, byId: ReadonlyMap<string, AnyEvent>, max = 10): AnyEvent[] {
  const out: AnyEvent[] = [];
  const seen = new Set<string>([e.eventId]);
  for (let p = e.parentEventId ? byId.get(e.parentEventId) : undefined; p && out.length < max && !seen.has(p.eventId); ) {
    out.push(p);
    seen.add(p.eventId);
    p = p.parentEventId ? byId.get(p.parentEventId) : undefined;
  }
  return out;
}

/** Artifact ids an event points at (artifact.created, tool results, task results). */
export function artifactIdsOf(e: AnyEvent): string[] {
  if (isUnknownEvent(e)) return [];
  if (e.type === 'artifact.created') return [e.payload.artifactId];
  if (e.type === 'tool.call_completed') return e.payload.outputArtifactIds ?? [];
  if (e.type === 'task.completed') return e.payload.artifactIds;
  return [];
}

/** The tool call an event belongs to, if any. */
export function callIdOf(e: AnyEvent): string | null {
  if (isUnknownEvent(e)) return null;
  switch (e.type) {
    case 'tool.call_started':
    case 'tool.call_completed':
    case 'tool.call_failed':
      return e.payload.callId;
    case 'tool.permission_requested':
      return e.payload.callId ?? null;
    case 'artifact.created':
      return e.payload.producedByCallId ?? null;
    default:
      return null;
  }
}

/**
 * Event-level provenance, when the source sets one (tracer events carry
 * 'reported' or 'inferred'; events the runtime executed carry none).
 */
export function eventProvenance(e: AnyEvent): 'reported' | 'inferred' | null {
  const p = (e as { provenance?: unknown }).provenance;
  return p === 'reported' || p === 'inferred' ? p : null;
}

/**
 * The subagent an `Agent` call started: the owner of the delegated task whose
 * task.created points at the call's start (parentEventId). Null otherwise.
 */
export function subagentOfCall(events: readonly AnyEvent[], exec: ExecState, startedEventId: string): string | null {
  for (const e of events) {
    if (isUnknownEvent(e) || e.type !== 'task.created' || e.parentEventId !== startedEventId) continue;
    return known(exec, exec.tasks[e.payload.taskId]?.ownerId);
  }
  return null;
}

/** Tool category from tool.call_started (present on traced runs). */
export function categoryOfStart(e: AnyEvent): string | null {
  if (e.type !== 'tool.call_started') return null;
  const c = (e.payload as { category?: unknown } | null)?.category;
  return typeof c === 'string' && c ? c : null;
}
