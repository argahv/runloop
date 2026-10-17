import { isUnknownEvent, type AnyEvent, type EventOf, type EventType } from '@runloop-world/events';
import { SequenceGapError } from './errors';
import type { AgentExec, Anomaly, ExecState, Incident, TaskExec, ToolCallExec } from './types';

export function initialExecState(): ExecState {
  return {
    lastSequence: 0,
    runId: null,
    runStartMs: null,
    run: {
      status: 'pending',
      title: '',
      missionId: '',
      worldId: '',
      seed: 0,
      adapter: null,
      workspace: '',
      startedAt: null,
      endedAt: null,
      summary: null,
    },
    agents: {},
    agentOrder: [],
    tasks: {},
    taskOrder: [],
    toolCalls: {},
    callOrder: [],
    permissions: {},
    artifacts: {},
    artifactOrder: [],
    messages: [],
    incidents: [],
    anomalies: [],
  };
}

/**
 * Fold one event into the execution state. Pure, with structural sharing:
 * untouched records keep their references.
 *
 * - `seq ≤ lastSequence` returns `s` itself (idempotent redelivery).
 * - `seq ≠ lastSequence + 1` throws {@link SequenceGapError} (order upstream with SequenceBuffer).
 * - Unknown/invalid events and contradictions become `anomalies`; the log is the truth, so this never throws for them.
 */
export function reduceExecution(s: ExecState, e: AnyEvent): ExecState {
  if (e.sequence <= s.lastSequence) return s;
  if (e.sequence !== s.lastSequence + 1) throw new SequenceGapError(s.lastSequence + 1, e.sequence);

  const base: ExecState = {
    ...s,
    lastSequence: e.sequence,
    runId: s.runId ?? e.runId,
    runStartMs: s.runStartMs ?? Date.parse(e.timestamp),
  };
  if (isUnknownEvent(e)) {
    return anomaly(base, e.sequence, 'unknown_event', `${e.type}: ${e.reason}${e.error ? ` (${e.error})` : ''}`);
  }
  const handler = handlers[e.type] as Handler<EventType>;
  return handler(base, e);
}

export function foldExecution(events: readonly AnyEvent[], from: ExecState = initialExecState()): ExecState {
  let s = from;
  for (const e of events) s = reduceExecution(s, e);
  return s;
}

// ── helpers ────────────────────────────────────────────────────────────

type Handler<T extends EventType> = (s: ExecState, e: EventOf<T>) => ExecState;

function anomaly(s: ExecState, seq: number, code: Anomaly['code'], detail: string): ExecState {
  return { ...s, anomalies: [...s.anomalies, { seq, code, detail }] };
}

function patchAgent(s: ExecState, id: string, patch: Partial<AgentExec>): ExecState {
  const a = s.agents[id];
  if (!a) return s;
  return { ...s, agents: { ...s.agents, [id]: { ...a, ...patch } } };
}

function patchTask(s: ExecState, id: string, patch: Partial<TaskExec>): ExecState {
  const t = s.tasks[id];
  if (!t) return s;
  return { ...s, tasks: { ...s.tasks, [id]: { ...t, ...patch } } };
}

function patchCall(s: ExecState, id: string, patch: Partial<ToolCallExec>): ExecState {
  const c = s.toolCalls[id];
  if (!c) return s;
  return { ...s, toolCalls: { ...s.toolCalls, [id]: { ...c, ...patch } } };
}

function addIncident(s: ExecState, incident: Omit<Incident, 'resolvedSeq'>): ExecState {
  return { ...s, incidents: [...s.incidents, { ...incident, resolvedSeq: null }] };
}

/** Clear `currentTaskId` on an agent if it points at `taskId`. */
function releaseTask(s: ExecState, agentId: string | null, taskId: string): ExecState {
  if (!agentId) return s;
  const a = s.agents[agentId];
  if (!a || a.currentTaskId !== taskId) return s;
  return patchAgent(s, agentId, { currentTaskId: null });
}

/** Make `agentId` the owner of `taskId`, detaching a previous owner. */
function takeTask(s: ExecState, taskId: string, agentId: string): ExecState {
  const t = s.tasks[taskId]!;
  let next = s;
  if (t.ownerId && t.ownerId !== agentId) next = releaseTask(next, t.ownerId, taskId);
  if (next.agents[agentId]) next = patchAgent(next, agentId, { currentTaskId: taskId });
  return next;
}

/** True when a dependency path leads from `taskId` back to itself. */
function hasCycle(tasks: Record<string, TaskExec>, taskId: string): boolean {
  const seen = new Set<string>();
  const stack = [...(tasks[taskId]?.dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks[id]?.dependsOn ?? []));
  }
  return false;
}

const TERMINAL_RUN = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);
const TERMINAL_TASK = new Set(['completed', 'failed']);

// ── handlers (one per known event type) ────────────────────────────────

const handlers: { [T in EventType]: Handler<T> } = {
  'run.started': (s, e) => {
    if (s.run.status !== 'pending') return anomaly(s, e.sequence, 'invalid_transition', `run.started while ${s.run.status}`);
    const p = e.payload;
    return {
      ...s,
      run: {
        ...s.run,
        status: 'running',
        title: p.title,
        missionId: p.missionId,
        worldId: p.worldId,
        seed: p.seed,
        adapter: p.adapter,
        workspace: p.workspace,
        startedAt: e.timestamp,
      },
    };
  },

  'run.paused': (s, e) => {
    if (s.run.status !== 'running') return anomaly(s, e.sequence, 'invalid_transition', `run.paused while ${s.run.status}`);
    return { ...s, run: { ...s.run, status: 'paused' } };
  },

  'run.resumed': (s, e) => {
    if (s.run.status !== 'paused') return anomaly(s, e.sequence, 'invalid_transition', `run.resumed while ${s.run.status}`);
    return { ...s, run: { ...s.run, status: 'running' } };
  },

  'run.completed': (s, e) => {
    if (TERMINAL_RUN.has(s.run.status)) {
      return anomaly(s, e.sequence, 'invalid_transition', `run.completed while ${s.run.status}`);
    }
    const p = e.payload;
    const next: ExecState = {
      ...s,
      run: { ...s.run, status: p.outcome, endedAt: e.timestamp, summary: p.summary ?? null },
    };
    if (p.outcome !== 'failed') return next;
    return addIncident(next, {
      seq: e.sequence,
      eventId: e.eventId,
      kind: 'run_failed',
      refId: e.runId,
      agentId: null,
      taskId: null,
      message: p.summary ?? 'Run failed',
    });
  },

  'agent.registered': (s, e) => {
    const p = e.payload;
    if (s.agents[p.agentId]) return anomaly(s, e.sequence, 'duplicate_id', `agent ${p.agentId} registered twice`);
    const agent: AgentExec = {
      id: p.agentId,
      name: p.name,
      role: p.role,
      model: p.model,
      tools: p.tools,
      embodied: p.embodied,
      characterPreset: p.characterPreset ?? null,
      state: 'idle',
      stateReason: null,
      currentTaskId: null,
      activeCallId: null,
      pendingPermissionId: null,
      lastTaskOutcome: null,
      registeredSeq: e.sequence,
    };
    return { ...s, agents: { ...s.agents, [p.agentId]: agent }, agentOrder: [...s.agentOrder, p.agentId] };
  },

  'agent.state_changed': (s, e) => {
    const p = e.payload;
    if (!s.agents[p.agentId]) return anomaly(s, e.sequence, 'unknown_agent', p.agentId);
    return patchAgent(s, p.agentId, { state: p.state, stateReason: p.reason ?? null });
  },

  'agent.message_sent': (s, e) => {
    const p = e.payload;
    const next: ExecState = {
      ...s,
      messages: [...s.messages, { ...p, seq: e.sequence, eventId: e.eventId, timestamp: e.timestamp }],
    };
    return s.agents[p.fromAgentId] ? next : anomaly(next, e.sequence, 'unknown_agent', p.fromAgentId);
  },

  'task.created': (s, e) => {
    const p = e.payload;
    if (s.tasks[p.taskId]) return anomaly(s, e.sequence, 'duplicate_id', `task ${p.taskId} created twice`);
    const task: TaskExec = {
      id: p.taskId,
      title: p.title,
      kind: p.kind,
      dependsOn: p.dependsOn,
      acceptance: p.acceptance ?? null,
      plannedSteps: p.plannedSteps ?? null,
      status: 'pending',
      ownerId: null,
      attempts: 0,
      createdSeq: e.sequence,
      createdBy: e.actorId ?? null,
      startedSeq: null,
      endedSeq: null,
      blockedReason: null,
      blockedBy: [],
      failure: null,
      summary: null,
      artifactIds: [],
      callIds: [],
      stepsDoneThisAttempt: 0,
    };
    let next: ExecState = { ...s, tasks: { ...s.tasks, [p.taskId]: task }, taskOrder: [...s.taskOrder, p.taskId] };
    for (const dep of p.dependsOn) {
      if (!s.tasks[dep] && dep !== p.taskId) next = anomaly(next, e.sequence, 'unknown_dependency', `${p.taskId} → ${dep}`);
    }
    if (hasCycle(next.tasks, p.taskId)) next = anomaly(next, e.sequence, 'dependency_cycle', p.taskId);
    return next;
  },

  'task.assigned': (s, e) => {
    const p = e.payload;
    const t = s.tasks[p.taskId];
    if (!t) return anomaly(s, e.sequence, 'unknown_task', p.taskId);
    if (t.status === 'completed') return anomaly(s, e.sequence, 'invalid_transition', `assign completed task ${p.taskId}`);
    let next = takeTask(s, p.taskId, p.agentId);
    next = patchTask(next, p.taskId, { status: 'assigned', ownerId: p.agentId, blockedReason: null, blockedBy: [] });
    return next.agents[p.agentId] ? next : anomaly(next, e.sequence, 'unknown_agent', p.agentId);
  },

  'task.started': (s, e) => {
    const p = e.payload;
    const t = s.tasks[p.taskId];
    if (!t) return anomaly(s, e.sequence, 'unknown_task', p.taskId);
    if (t.status === 'completed') return anomaly(s, e.sequence, 'invalid_transition', `start completed task ${p.taskId}`);
    let next = takeTask(s, p.taskId, p.agentId);
    next = patchTask(next, p.taskId, {
      status: 'in_progress',
      ownerId: p.agentId,
      attempts: t.attempts + 1,
      startedSeq: e.sequence,
      endedSeq: null,
      blockedReason: null,
      blockedBy: [],
      stepsDoneThisAttempt: 0,
    });
    return next.agents[p.agentId] ? next : anomaly(next, e.sequence, 'unknown_agent', p.agentId);
  },

  'task.blocked': (s, e) => {
    const p = e.payload;
    const t = s.tasks[p.taskId];
    if (!t) return anomaly(s, e.sequence, 'unknown_task', p.taskId);
    if (TERMINAL_TASK.has(t.status)) return anomaly(s, e.sequence, 'invalid_transition', `block ${t.status} task ${p.taskId}`);
    // The owner keeps currentTaskId: a blocked task is still theirs (the character waits).
    return patchTask(s, p.taskId, { status: 'blocked', blockedReason: p.reason, blockedBy: p.blockedBy ?? [] });
  },

  'task.completed': (s, e) => {
    const p = e.payload;
    const t = s.tasks[p.taskId];
    if (!t) return anomaly(s, e.sequence, 'unknown_task', p.taskId);
    if (t.status === 'completed') return anomaly(s, e.sequence, 'invalid_transition', `complete completed task ${p.taskId}`);
    let next = patchTask(s, p.taskId, {
      status: 'completed',
      endedSeq: e.sequence,
      summary: p.summary,
      artifactIds: p.artifactIds,
    });
    next = releaseTask(next, t.ownerId, p.taskId);
    if (t.ownerId && next.agents[t.ownerId]) {
      next = patchAgent(next, t.ownerId, { lastTaskOutcome: { taskId: p.taskId, status: 'completed', seq: e.sequence } });
    }
    if (next.incidents.some((i) => i.taskId === p.taskId && i.resolvedSeq === null)) {
      next = {
        ...next,
        incidents: next.incidents.map((i) =>
          i.taskId === p.taskId && i.resolvedSeq === null ? { ...i, resolvedSeq: e.sequence } : i,
        ),
      };
    }
    return next;
  },

  'task.failed': (s, e) => {
    const p = e.payload;
    const t = s.tasks[p.taskId];
    if (!t) return anomaly(s, e.sequence, 'unknown_task', p.taskId);
    if (TERMINAL_TASK.has(t.status)) return anomaly(s, e.sequence, 'invalid_transition', `fail ${t.status} task ${p.taskId}`);
    let next = patchTask(s, p.taskId, {
      status: 'failed',
      endedSeq: e.sequence,
      failure: { reason: p.reason, errorType: p.errorType ?? null },
    });
    next = releaseTask(next, t.ownerId, p.taskId);
    if (t.ownerId && next.agents[t.ownerId]) {
      next = patchAgent(next, t.ownerId, { lastTaskOutcome: { taskId: p.taskId, status: 'failed', seq: e.sequence } });
    }
    return addIncident(next, {
      seq: e.sequence,
      eventId: e.eventId,
      kind: 'task_failed',
      refId: p.taskId,
      agentId: t.ownerId,
      taskId: p.taskId,
      message: p.reason,
    });
  },

  'tool.call_started': (s, e) => {
    const p = e.payload;
    if (s.toolCalls[p.callId]) return anomaly(s, e.sequence, 'duplicate_id', `call ${p.callId} started twice`);
    const call: ToolCallExec = {
      id: p.callId,
      agentId: p.agentId,
      taskId: p.taskId ?? null,
      tool: p.tool,
      inputSummary: p.inputSummary,
      status: 'running',
      startedSeq: e.sequence,
      startedAt: e.timestamp,
      startedEventId: e.eventId,
      endedSeq: null,
      endedAt: null,
      endedEventId: null,
      durationMs: null,
      exitCode: null,
      outputSummary: null,
      metrics: null,
      failingTests: [],
      outputArtifactIds: [],
      errorType: null,
      message: null,
    };
    let next: ExecState = { ...s, toolCalls: { ...s.toolCalls, [p.callId]: call }, callOrder: [...s.callOrder, p.callId] };
    if (next.agents[p.agentId]) next = patchAgent(next, p.agentId, { activeCallId: p.callId });
    else next = anomaly(next, e.sequence, 'unknown_agent', p.agentId);
    if (p.taskId) {
      const t = next.tasks[p.taskId];
      if (t) next = patchTask(next, p.taskId, { callIds: [...t.callIds, p.callId] });
      else next = anomaly(next, e.sequence, 'unknown_task', p.taskId);
    }
    return next;
  },

  'tool.call_completed': (s, e) => {
    const p = e.payload;
    const c = s.toolCalls[p.callId];
    if (!c) return anomaly(s, e.sequence, 'unknown_call', p.callId);
    if (c.status !== 'running') return anomaly(s, e.sequence, 'invalid_transition', `call ${p.callId} already ${c.status}`);
    let next = patchCall(s, p.callId, {
      status: p.status,
      endedSeq: e.sequence,
      endedAt: e.timestamp,
      endedEventId: e.eventId,
      durationMs: p.durationMs,
      exitCode: p.exitCode ?? null,
      outputSummary: p.outputSummary,
      metrics: p.metrics ?? null,
      failingTests: p.failingTests ?? [],
      outputArtifactIds: p.outputArtifactIds ?? [],
      errorType: p.errorType ?? null,
    });
    next = finishCall(next, c);
    if (p.status !== 'error') return next;
    return addIncident(next, {
      seq: e.sequence,
      eventId: e.eventId,
      kind: 'tool_error',
      refId: p.callId,
      agentId: c.agentId,
      taskId: c.taskId,
      message: p.outputSummary,
    });
  },

  'tool.call_failed': (s, e) => {
    const p = e.payload;
    const c = s.toolCalls[p.callId];
    if (!c) return anomaly(s, e.sequence, 'unknown_call', p.callId);
    if (c.status !== 'running') return anomaly(s, e.sequence, 'invalid_transition', `call ${p.callId} already ${c.status}`);
    let next = patchCall(s, p.callId, {
      status: 'failed',
      endedSeq: e.sequence,
      endedAt: e.timestamp,
      endedEventId: e.eventId,
      durationMs: p.durationMs,
      errorType: p.errorType,
      message: p.message,
    });
    next = finishCall(next, c);
    return addIncident(next, {
      seq: e.sequence,
      eventId: e.eventId,
      kind: 'tool_failed',
      refId: p.callId,
      agentId: c.agentId,
      taskId: c.taskId,
      message: `${p.errorType}: ${p.message}`,
    });
  },

  'tool.permission_requested': (s, e) => {
    const p = e.payload;
    if (s.permissions[p.permissionId]) {
      return anomaly(s, e.sequence, 'duplicate_id', `permission ${p.permissionId} requested twice`);
    }
    const next: ExecState = {
      ...s,
      permissions: {
        ...s.permissions,
        [p.permissionId]: {
          id: p.permissionId,
          agentId: p.agentId,
          callId: p.callId ?? null,
          action: p.action,
          scope: p.scope,
          status: 'pending',
          requestedSeq: e.sequence,
          resolvedSeq: null,
          resolvedBy: null,
        },
      },
    };
    if (!next.agents[p.agentId]) return anomaly(next, e.sequence, 'unknown_agent', p.agentId);
    return patchAgent(next, p.agentId, { pendingPermissionId: p.permissionId });
  },

  'tool.permission_resolved': (s, e) => {
    const p = e.payload;
    const perm = s.permissions[p.permissionId];
    if (!perm) return anomaly(s, e.sequence, 'unknown_permission', p.permissionId);
    if (perm.status !== 'pending') {
      return anomaly(s, e.sequence, 'invalid_transition', `permission ${p.permissionId} already ${perm.status}`);
    }
    let next: ExecState = {
      ...s,
      permissions: {
        ...s.permissions,
        [p.permissionId]: { ...perm, status: p.decision, resolvedSeq: e.sequence, resolvedBy: p.by },
      },
    };
    if (next.agents[perm.agentId]?.pendingPermissionId === p.permissionId) {
      next = patchAgent(next, perm.agentId, { pendingPermissionId: null });
    }
    return next;
  },

  'artifact.created': (s, e) => {
    const p = e.payload;
    if (s.artifacts[p.artifactId]) return anomaly(s, e.sequence, 'duplicate_id', `artifact ${p.artifactId} created twice`);
    const call = p.producedByCallId ? s.toolCalls[p.producedByCallId] : undefined;
    const next: ExecState = {
      ...s,
      artifacts: {
        ...s.artifacts,
        [p.artifactId]: {
          ...p,
          seq: e.sequence,
          eventId: e.eventId,
          agentId: e.actorId ?? call?.agentId ?? null,
          taskId: e.taskId ?? call?.taskId ?? null,
          createdAt: e.timestamp,
        },
      },
      artifactOrder: [...s.artifactOrder, p.artifactId],
    };
    if (p.producedByCallId && !call) return anomaly(next, e.sequence, 'unknown_call', p.producedByCallId);
    return next;
  },
};

/** Bookkeeping shared by tool.call_completed / tool.call_failed. */
function finishCall(s: ExecState, call: ToolCallExec): ExecState {
  let next = s;
  if (next.agents[call.agentId]?.activeCallId === call.id) next = patchAgent(next, call.agentId, { activeCallId: null });
  const t = call.taskId ? next.tasks[call.taskId] : undefined;
  // Count the step only if the call belongs to the task's current attempt.
  if (t && t.startedSeq !== null && call.startedSeq >= t.startedSeq) {
    next = patchTask(next, t.id, { stepsDoneThisAttempt: t.stepsDoneThisAttempt + 1 });
  }
  return next;
}
