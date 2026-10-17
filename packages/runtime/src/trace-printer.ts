import type { AnyEvent } from '@runloop-world/events';

function clock(ms: number): string {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const d = Math.floor((t % 1000) / 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}

function clip(text: string, max = 96): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * One text line per event, built from payload fields only, e.g.
 * `#036 00:21.4 tester     tool.call_completed  run_command error  12 tests: 10 passed, 2 failed`.
 * Keeps a little state (run start, call → tool, attempts) across events.
 */
export class TracePrinter {
  private startMs: number | null = null;
  private readonly tools = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  /** taskId → agent working on it, to name an actor for task.* events that carry none. */
  private readonly owners = new Map<string, string>();

  format(e: AnyEvent): string {
    const ts = Date.parse(e.timestamp);
    if (this.startMs === null || e.type === 'run.started') this.startMs = ts;
    if (!('unknown' in e) && (e.type === 'task.assigned' || e.type === 'task.started')) {
      this.owners.set(e.payload.taskId, e.payload.agentId);
    }
    const actor = e.actorId ?? (e.taskId ? this.owners.get(e.taskId) : undefined) ?? '-';
    const head = `#${String(e.sequence).padStart(3, '0')} ${clock(ts - this.startMs)} ${actor.padEnd(11)} ${e.type.padEnd(20)}`;
    const detail = this.detail(e);
    return detail ? `${head} ${detail}` : head.trimEnd();
  }

  private detail(e: AnyEvent): string {
    if ('unknown' in e) return `(unreadable event: ${e.reason})`;
    switch (e.type) {
      case 'run.started':
        return `"${e.payload.title}" · ${e.payload.adapter.label} · ${e.payload.workspace}`;
      case 'run.paused':
        return e.payload.reason ?? '';
      case 'run.resumed':
        return '';
      case 'run.completed':
        return `${e.payload.outcome.toUpperCase()}${e.payload.summary ? ` — ${e.payload.summary}` : ''}`;
      case 'agent.registered':
        return `${e.payload.name} (${e.payload.role})${e.payload.tools.length ? ` tools: ${e.payload.tools.join(', ')}` : ''}${e.payload.embodied ? '' : ' [not embodied]'}`;
      case 'agent.state_changed':
        return `${e.payload.agentId} → ${e.payload.state}${e.payload.reason ? ` (${e.payload.reason})` : ''}`;
      case 'agent.message_sent':
        return `→ ${e.payload.to}: ${clip(e.payload.text)}`;
      case 'task.created':
        return `${e.payload.taskId} ${e.payload.kind} "${e.payload.title}"${e.payload.dependsOn.length ? ` after ${e.payload.dependsOn.join(', ')}` : ''}`;
      case 'task.assigned':
        return `${e.payload.taskId} → ${e.payload.agentId}`;
      case 'task.started': {
        const n = (this.attempts.get(e.payload.taskId) ?? 0) + 1;
        this.attempts.set(e.payload.taskId, n);
        return `${e.payload.taskId} attempt ${n}`;
      }
      case 'task.blocked':
        return `${e.payload.taskId} ${e.payload.reason}${e.payload.blockedBy?.length ? ` (waiting on ${e.payload.blockedBy.join(', ')})` : ''}`;
      case 'task.completed':
        return `${e.payload.taskId} ${clip(e.payload.summary)}`;
      case 'task.failed':
        return `${e.payload.taskId} ${clip(e.payload.reason)}`;
      case 'tool.call_started':
        this.tools.set(e.payload.callId, e.payload.tool);
        return `${e.payload.tool} ${clip(e.payload.inputSummary, 60)}`;
      case 'tool.call_completed': {
        const tool = this.tools.get(e.payload.callId) ?? e.payload.callId;
        return `${tool} ${e.payload.status}  ${e.payload.outputSummary}  (${Math.round(e.payload.durationMs)} ms)`;
      }
      case 'tool.call_failed': {
        const tool = this.tools.get(e.payload.callId) ?? e.payload.callId;
        return `${tool} FAILED ${e.payload.errorType}: ${clip(e.payload.message)}`;
      }
      case 'tool.permission_requested':
        return `${e.payload.action} ${e.payload.scope}`;
      case 'tool.permission_resolved':
        return `${e.payload.permissionId} ${e.payload.decision} by ${e.payload.by}`;
      case 'artifact.created':
        return `${e.payload.artifactId} ${e.payload.kind} ${e.payload.path ?? e.payload.name} (${e.payload.bytes} B)`;
    }
  }
}
