import { isUnknownEvent, type AnyEvent, type EventOf, type EventType } from '@runloop-world/events';
import { SequenceGapError } from './errors';
import { IdMap } from './id-map';
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
      seed: null,
      adapter: null,
      workspace: null,
      speed: null,
      mode: 'executed',
      source: null,
      startedAt: null,
      endedAt: null,
      summary: null,
    },
    agents: {},
    agentOrder: [],
    tasks: {},
    taskOrder: [],
    toolCalls: IdMap.empty(),
    callOrder: [],
    permissions: {},
    artifacts: {},
    artifactOrder: [],
    messages: [],
    markers: [],
    usageReports: [],
    incidents: [],
    openFailures: {},
    anomalies: [],
  };
}

/**
 * Fold one event into the execution state. Pure, with structural sharing:
 * untouched records keep their references. Inside {@link transient} the
 * collections a fold creates are updated in place, so folding many events
 * costs O(1) per event instead of copying every record each time.
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
  return transient(() => {
    let s = from;
    for (const e of events) s = reduceExecution(s, e);
    return s;
  });
}

// ── batch folds ────────────────────────────────────────────────────────

/**
 * Collections (records and arrays) created by the batch fold in progress.
 * Nothing outside the batch can hold them yet, so they may change in place.
 */
let owned: WeakSet<object> | null = null;

/**
 * Run a fold of several events with in-place updates of the collections it
 * creates. Only the state `fn` returns is published: states produced inside
 * `fn` before its last event must not be kept (they share those collections).
 * States from before the batch are never changed. Results equal the plain fold.
 */
export function transient<T>(fn: () => T): T {
  const outer = owned;
  owned = new WeakSet();
  try {
    return fn();
  } finally {
    owned = outer;
  }
}

function own<T extends object>(x: T): T {
  owned?.add(x);
  return x;
}

/** `rec` with `key` set: in place when this batch created `rec`, else a copy. */
function setKey<V>(rec: Record<string, V>, key: string, value: V): Record<string, V> {
  if (owned?.has(rec)) {
    rec[key] = value;
    return rec;
  }
  return own({ ...rec, [key]: value });
}

/** `arr` plus `item`: in place when this batch created `arr`, else a copy. */
function append<V>(arr: V[], item: V): V[] {
  if (owned?.has(arr)) {
    arr.push(item);
    return arr;
  }
  return own([...arr, item]);
}

// ── helpers ────────────────────────────────────────────────────────────

type Handler<T extends EventType> = (s: ExecState, e: EventOf<T>) => ExecState;

function anomaly(s: ExecState, seq: number, code: Anomaly['code'], detail: string): ExecState {
  return { ...s, anomalies: append(s.anomalies, { seq, code, detail }) };
}

function patchAgent(s: ExecState, id: string, patch: Partial<AgentExec>): ExecState {
  const a = s.agents[id];
  if (!a) return s;
  return { ...s, agents: setKey(s.agents, id, { ...a, ...patch }) };
}

function patchTask(s: ExecState, id: string, patch: Partial<TaskExec>): ExecState {
  const t = s.tasks[id];
  if (!t) return s;
  return { ...s, tasks: setKey(s.tasks, id, { ...t, ...patch }) };
}

function patchCall(s: ExecState, id: string, patch: Partial<ToolCallExec>): ExecState {
  const c = s.toolCalls.get(id);
  if (!c) return s;
  return { ...s, toolCalls: s.toolCalls.set(id, { ...c, ...patch }, owned) };
}

function addIncident(s: ExecState, incident: Omit<Incident, 'resolvedSeq' | 'resolution'>, call?: ToolCallExec): ExecState {
  const index = s.incidents.length;
  const next: ExecState = { ...s, incidents: append(s.incidents, { ...incident, resolvedSeq: null, resolution: null }) };
  if (!call || s.run.mode !== 'traced') return next;
  const key = resolutionKey(call);
  return { ...next, openFailures: setKey(next.openFailures, key, append(next.openFailures[key] ?? [], index)) };
}

/** Mark the open incidents at `indexes` (or those `match` accepts) as resolved at `seq`. */
function resolveIncidents(
  s: ExecState,
  seq: number,
  resolution: NonNullable<Incident['resolution']>,
  which: readonly number[] | ((i: Incident) => boolean),
): ExecState {
  let incidents = s.incidents;
  const indexes = typeof which === 'function' ? incidents.flatMap((i, k) => (which(i) ? [k] : [])) : which;
  for (const k of indexes) {
    const i = incidents[k];
    if (!i || i.resolvedSeq !== null) continue;
    if (!owned?.has(incidents)) incidents = own([...incidents]);
    incidents[k] = { ...i, resolvedSeq: seq, resolution };
  }
  return incidents === s.incidents ? s : { ...s, incidents };
}

/**
 * Traced runs: what a later success must share with a failed call to show it
 * was dealt with. Any passing test run resolves earlier failing ones (same
 * tool); other calls need the same tool and input. Runloop infers this; the
 * source never says a failure was fixed.
 */
function resolutionKey(call: ToolCallExec): string {
  return call.category === 'test' ? `test\u0000${call.tool}` : `same\u0000${call.tool}\u0000${call.inputSummary}`;
}

/** Traced runs: resolve the open failures a successful call answers (a test run only counts with no reported failures). */
function resolveBySuccess(s: ExecState, seq: number, ok: ToolCallExec): ExecState {
  if (ok.category === 'test' && ok.metrics !== null && ok.metrics.failed > 0) return s;
  const key = resolutionKey(ok);
  const open = s.openFailures[key];
  if (!open || open.length === 0) return s;
  const next = resolveIncidents(s, seq, 'later_success', open);
  return { ...next, openFailures: setKey(next.openFailures, key, []) };
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
        seed: p.seed ?? null,
        adapter: p.adapter,
        workspace: p.workspace ?? null,
        speed: p.speed ?? null,
        mode: p.mode ?? 'executed',
        source: p.source ?? null,
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

  'run.marker': (s, e) => {
    const p = e.payload;
    const next: ExecState = {
      ...s,
      markers: append(s.markers, {
        seq: e.sequence,
        eventId: e.eventId,
        timestamp: e.timestamp,
        kind: p.kind,
        label: p.label,
        detail: p.detail ?? null,
        agentId: p.agentId ?? null,
        provenance: e.provenance ?? null,
      }),
    };
    return p.agentId && !s.agents[p.agentId] ? anomaly(next, e.sequence, 'unknown_agent', p.agentId) : next;
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
      lastCategory: null,
      usage: null,
      registeredSeq: e.sequence,
    };
    return { ...s, agents: setKey(s.agents, p.agentId, agent), agentOrder: append(s.agentOrder, p.agentId) };
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
      messages: append(s.messages, { ...p, seq: e.sequence, eventId: e.eventId, timestamp: e.timestamp }),
    };
    return s.agents[p.fromAgentId] ? next : anomaly(next, e.sequence, 'unknown_agent', p.fromAgentId);
  },

  'agent.usage_reported': (s, e) => {
    const p = e.payload;
    const report = { ...p, seq: e.sequence, eventId: e.eventId, provenance: e.provenance ?? null };
    const next: ExecState = { ...s, usageReports: append(s.usageReports, report) };
    if (!s.agents[p.agentId]) return anomaly(next, e.sequence, 'unknown_agent', p.agentId);
    return patchAgent(next, p.agentId, { usage: report });
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
    let next: ExecState = { ...s, tasks: setKey(s.tasks, p.taskId, task), taskOrder: append(s.taskOrder, p.taskId) };
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
    // Executed runs: a task that finished after a failure dealt with it. A traced turn
    // "completes" whenever Claude stops (or the session ends), which says nothing about its failures.
    if (s.run.mode !== 'traced' && e.provenance !== 'inferred' && next.incidents.some((i) => i.taskId === p.taskId && i.resolvedSeq === null)) {
      next = resolveIncidents(next, e.sequence, 'task_completed', (i) => i.taskId === p.taskId);
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
    if (s.toolCalls.has(p.callId)) return anomaly(s, e.sequence, 'duplicate_id', `call ${p.callId} started twice`);
    const call: ToolCallExec = {
      id: p.callId,
      agentId: p.agentId,
      taskId: p.taskId ?? null,
      tool: p.tool,
      category: p.category ?? null,
      inputSummary: p.inputSummary,
      target: p.target ?? null,
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
      startProvenance: e.provenance ?? null,
      endProvenance: null,
    };
    let next: ExecState = { ...s, toolCalls: s.toolCalls.set(p.callId, call, owned), callOrder: append(s.callOrder, p.callId) };
    if (next.agents[p.agentId]) {
      next = patchAgent(next, p.agentId, {
        activeCallId: p.callId,
        ...(p.category ? { lastCategory: { category: p.category, taskId: p.taskId ?? null } } : {}),
      });
    } else next = anomaly(next, e.sequence, 'unknown_agent', p.agentId);
    if (p.taskId) {
      const t = next.tasks[p.taskId];
      if (t) next = patchTask(next, p.taskId, { callIds: append(t.callIds, p.callId) });
      else next = anomaly(next, e.sequence, 'unknown_task', p.taskId);
    }
    return next;
  },

  'tool.call_completed': (s, e) => {
    const p = e.payload;
    const c = s.toolCalls.get(p.callId);
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
      endProvenance: e.provenance ?? null,
    });
    next = finishCall(next, c);
    if (p.status !== 'error') return next.run.mode === 'traced' ? resolveBySuccess(next, e.sequence, next.toolCalls.get(p.callId)!) : next;
    return addIncident(
      next,
      { seq: e.sequence, eventId: e.eventId, kind: 'tool_error', refId: p.callId, agentId: c.agentId, taskId: c.taskId, message: p.outputSummary },
      c,
    );
  },

  'tool.call_failed': (s, e) => {
    const p = e.payload;
    const c = s.toolCalls.get(p.callId);
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
      endProvenance: e.provenance ?? null,
    });
    next = finishCall(next, c);
    return addIncident(
      next,
      { seq: e.sequence, eventId: e.eventId, kind: 'tool_failed', refId: p.callId, agentId: c.agentId, taskId: c.taskId, message: `${p.errorType}: ${p.message}` },
      c,
    );
  },

  'tool.permission_requested': (s, e) => {
    const p = e.payload;
    if (s.permissions[p.permissionId]) {
      return anomaly(s, e.sequence, 'duplicate_id', `permission ${p.permissionId} requested twice`);
    }
    const next: ExecState = {
      ...s,
      permissions: setKey(s.permissions, p.permissionId, {
        id: p.permissionId,
        agentId: p.agentId,
        callId: p.callId ?? null,
        action: p.action,
        scope: p.scope,
        status: 'pending',
        requestedSeq: e.sequence,
        requestedAt: e.timestamp,
        resolvedSeq: null,
        resolvedAt: null,
        resolvedBy: null,
        resolvedProvenance: null,
      }),
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
      permissions: setKey(s.permissions, p.permissionId, {
        ...perm,
        status: p.decision,
        resolvedSeq: e.sequence,
        resolvedAt: e.timestamp,
        resolvedBy: p.by,
        resolvedProvenance: e.provenance ?? null,
      }),
    };
    if (next.agents[perm.agentId]?.pendingPermissionId === p.permissionId) {
      next = patchAgent(next, perm.agentId, { pendingPermissionId: null });
    }
    return next;
  },

  'artifact.created': (s, e) => {
    const p = e.payload;
    if (s.artifacts[p.artifactId]) return anomaly(s, e.sequence, 'duplicate_id', `artifact ${p.artifactId} created twice`);
    const call = p.producedByCallId ? s.toolCalls.get(p.producedByCallId) : undefined;
    const next: ExecState = {
      ...s,
      artifacts: setKey(s.artifacts, p.artifactId, {
        ...p,
        seq: e.sequence,
        eventId: e.eventId,
        agentId: e.actorId ?? call?.agentId ?? null,
        taskId: e.taskId ?? call?.taskId ?? null,
        createdAt: e.timestamp,
      }),
      artifactOrder: append(s.artifactOrder, p.artifactId),
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
