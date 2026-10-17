import { isUnknownEvent, type AnyEvent, type RunEvent } from '@runloop-world/events';
import type { ExecState, FormattedEvent } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Milliseconds → "mm:ss" (92000 → "01:32"). Negative values clamp to 0; minutes may exceed 99. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** Milliseconds → "mm:ss.s" (21400 → "00:21.4"). */
function formatClockTenths(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  return `${formatClock(Math.floor(tenths / 10) * 1000)}.${tenths % 10}`;
}

/**
 * One text-trace line for an event (timeline rows, Logs, CLI output).
 * Text comes from payload fields only (never parsed tool output). `s` (the
 * state before or after folding `e`), when given, supplies the run start for
 * the clock, tool names for call results and task owners as actors.
 */
export function formatEvent(e: AnyEvent, s?: ExecState): FormattedEvent {
  // With a state, an event folded before anything else marks the run start itself.
  const startMs = s ? (s.runStartMs ?? Date.parse(e.timestamp)) : null;
  const clock = startMs === null ? '--:--.-' : formatClockTenths(Date.parse(e.timestamp) - startMs);
  const base = { seq: e.sequence, clock, type: e.type };

  if (isUnknownEvent(e)) {
    return {
      ...base,
      actor: e.actorId ?? 'system',
      label: `Unrecognised event (${e.reason.replace('_', ' ')})`,
      detail: e.error ?? null,
      severity: 'warn',
    };
  }
  const { label, detail = null, severity = 'info', actor } = describe(e, s);
  // Task lifecycle events often carry only a taskId: attribute them to the task's owner.
  const owner = e.taskId ? (s?.tasks[e.taskId]?.ownerId ?? undefined) : undefined;
  return { ...base, actor: e.actorId ?? actor ?? owner ?? 'system', label, detail, severity };
}

interface Described {
  label: string;
  detail?: string | null;
  severity?: FormattedEvent['severity'];
  actor?: string;
}

function describe(e: RunEvent, s?: ExecState): Described {
  switch (e.type) {
    case 'run.started':
      return { label: `Run started: ${e.payload.title}`, detail: e.payload.adapter.label };
    case 'run.paused':
      return { label: 'Run paused', detail: e.payload.reason ?? null, severity: 'warn' };
    case 'run.resumed':
      return { label: 'Run resumed' };
    case 'run.completed': {
      const o = e.payload.outcome;
      return {
        label: `Run ${o}`,
        detail: e.payload.summary ?? null,
        severity: o === 'succeeded' ? 'ok' : o === 'failed' ? 'error' : 'warn',
      };
    }
    case 'agent.registered': {
      const p = e.payload;
      const tools = p.tools.length ? `tools: ${p.tools.join(', ')}` : 'no tools';
      return { label: `Registered ${p.name} (${p.role})`, detail: p.embodied ? tools : `${tools}; no character` };
    }
    case 'agent.state_changed': {
      const p = e.payload;
      return {
        label: `State → ${p.state}`,
        detail: p.reason ?? null,
        severity: p.state === 'failed' ? 'error' : p.state === 'blocked' ? 'warn' : 'info',
      };
    }
    case 'agent.message_sent':
      return { label: `Message to ${e.payload.to}`, detail: e.payload.text };
    case 'task.created': {
      const p = e.payload;
      const deps = p.dependsOn.length ? `after ${p.dependsOn.join(', ')}` : null;
      return { label: `Created ${p.taskId} [${p.kind}]: ${p.title}`, detail: deps };
    }
    case 'task.assigned':
      return { label: `Assigned ${e.payload.taskId} to ${e.payload.agentId}` };
    case 'task.started':
      return { label: `Started ${e.payload.taskId}` };
    case 'task.blocked':
      return { label: `Blocked ${e.payload.taskId}`, detail: e.payload.reason, severity: 'warn' };
    case 'task.completed':
      return { label: `Completed ${e.payload.taskId}`, detail: e.payload.summary, severity: 'ok' };
    case 'task.failed':
      return { label: `Failed ${e.payload.taskId}`, detail: e.payload.reason, severity: 'error' };
    case 'tool.call_started':
      return { label: `${e.payload.tool} ${e.payload.inputSummary}`.trim() };
    case 'tool.call_completed': {
      const p = e.payload;
      const call = s?.toolCalls[p.callId];
      const counts = p.metrics ? ` · ${p.metrics.passed} passed, ${p.metrics.failed} failed` : '';
      return {
        label: `${call?.tool ?? p.callId} ${p.status}${counts}`,
        detail: `${p.outputSummary} (${Math.round(p.durationMs)} ms)`,
        severity: p.status === 'success' ? 'ok' : 'error',
        ...(call ? { actor: call.agentId } : {}),
      };
    }
    case 'tool.call_failed': {
      const p = e.payload;
      const call = s?.toolCalls[p.callId];
      return {
        label: `${call?.tool ?? p.callId} could not run (${p.errorType})`,
        detail: p.message,
        severity: 'error',
        ...(call ? { actor: call.agentId } : {}),
      };
    }
    case 'tool.permission_requested':
      return { label: `Permission requested: ${e.payload.action}`, detail: e.payload.scope, severity: 'warn' };
    case 'tool.permission_resolved': {
      const p = e.payload;
      return { label: `Permission ${p.decision} by ${p.by}`, severity: p.decision === 'approved' ? 'ok' : 'error' };
    }
    case 'artifact.created': {
      const p = e.payload;
      return { label: `Artifact ${p.name} (${p.kind}, ${p.bytes} B)`, detail: p.summary };
    }
  }
}
