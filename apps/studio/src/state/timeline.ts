import { formatEvent } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent, type TestMetrics } from '@runloop-world/events';

export type RowStatus = 'running' | 'ok' | 'error' | 'warn' | 'info';

/** One readable line of the Timeline. Text comes only from event payload fields. */
export interface TimelineRow {
  /** eventId of the row's first event. */
  key: string;
  type: string;
  /** Sequence of the first event (a tool row starts at tool.call_started). */
  seq: number;
  /** Sequence of the event that finished the row (tool completion/failure), if any. */
  endSeq: number | null;
  /** Ms since run start of `seq`. */
  tMs: number;
  /** Agent id, or 'system'. */
  actorId: string;
  icon: string;
  title: string;
  detail: string | null;
  /** Final status, once every merged event happened. */
  status: RowStatus;
  durationMs: number | null;
  /** Test counts exactly as the payload reported them. */
  metrics: TestMetrics | null;
  failingTests: string[];
  artifactIds: string[];
  taskId: string | null;
  callId: string | null;
}

const SEVERITY_TO_STATUS = { info: 'info', ok: 'ok', warn: 'warn', error: 'error' } as const;

const ICONS: Record<string, string> = {
  'run.started': '▶',
  'run.paused': '⏸',
  'run.resumed': '⏵',
  'run.completed': '■',
  'agent.registered': '＋',
  'agent.state_changed': '◐',
  'agent.message_sent': '✉',
  'task.created': '◇',
  'task.assigned': '→',
  'task.started': '◆',
  'task.blocked': '⏳',
  'task.completed': '✓',
  'task.failed': '✗',
  'tool.call_started': '⚙',
  'tool.permission_requested': '🔒',
  'tool.permission_resolved': '🔑',
  'artifact.created': '📄',
};

/** Agent state changes worth a Timeline row (the rest is in Logs). */
const NOTABLE_AGENT_STATES = new Set(['failed', 'blocked']);

/**
 * Turn the ordered event log into Timeline rows. A tool call's start and its
 * completion (or failure) become one row carrying the duration and status;
 * artifacts produced by a call attach to that row. Rows are independent of
 * the playhead: use {@link rowStatusAt} / `row.seq > playheadSeq` when rendering.
 */
export function buildTimelineRows(events: readonly AnyEvent[], timeOfSeq: (seq: number) => number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const byCall = new Map<string, TimelineRow>();
  const taskOwner = new Map<string, string>();

  const base = (e: AnyEvent): TimelineRow => ({
    key: e.eventId,
    type: e.type,
    seq: e.sequence,
    endSeq: null,
    tMs: timeOfSeq(e.sequence),
    actorId: e.actorId ?? (e.taskId ? taskOwner.get(e.taskId) : undefined) ?? 'system',
    icon: ICONS[e.type] ?? '•',
    title: e.type,
    detail: null,
    status: 'info',
    durationMs: null,
    metrics: null,
    failingTests: [],
    artifactIds: [],
    taskId: e.taskId ?? null,
    callId: null,
  });

  for (const e of events) {
    if (isUnknownEvent(e)) {
      const f = formatEvent(e);
      rows.push({ ...base(e), icon: '⚠', title: f.label, detail: f.detail ?? e.type, status: 'warn' });
      continue;
    }
    switch (e.type) {
      case 'tool.call_started': {
        const p = e.payload;
        const row: TimelineRow = {
          ...base(e),
          actorId: p.agentId,
          title: `${p.tool} ${p.inputSummary}`.trim(),
          status: 'running',
          taskId: p.taskId ?? null,
          callId: p.callId,
        };
        byCall.set(p.callId, row);
        rows.push(row);
        break;
      }
      case 'tool.call_completed': {
        const p = e.payload;
        const row = byCall.get(p.callId);
        if (!row) {
          rows.push(orphan(base(e), e));
          break;
        }
        row.endSeq = e.sequence;
        row.status = p.status === 'success' ? 'ok' : 'error';
        row.icon = p.status === 'success' ? '✓' : '✗';
        row.detail = p.outputSummary;
        row.durationMs = p.durationMs;
        row.metrics = p.metrics ?? null;
        row.failingTests = p.failingTests ?? [];
        for (const id of p.outputArtifactIds ?? []) if (!row.artifactIds.includes(id)) row.artifactIds.push(id);
        break;
      }
      case 'tool.call_failed': {
        const p = e.payload;
        const row = byCall.get(p.callId);
        if (!row) {
          rows.push(orphan(base(e), e));
          break;
        }
        row.endSeq = e.sequence;
        row.status = 'error';
        row.icon = '✗';
        row.detail = `Could not run (${p.errorType}): ${p.message}`;
        row.durationMs = p.durationMs;
        break;
      }
      case 'artifact.created': {
        const p = e.payload;
        const row = p.producedByCallId ? byCall.get(p.producedByCallId) : undefined;
        if (row) {
          if (!row.artifactIds.includes(p.artifactId)) row.artifactIds.push(p.artifactId);
        } else {
          rows.push({ ...plain(base(e), e), artifactIds: [p.artifactId] });
        }
        break;
      }
      case 'agent.state_changed':
        if (NOTABLE_AGENT_STATES.has(e.payload.state)) rows.push(plain(base(e), e));
        break;
      case 'task.assigned':
      case 'task.started':
        taskOwner.set(e.payload.taskId, e.payload.agentId);
        rows.push(plain(base(e), e));
        break;
      default:
        rows.push(plain(base(e), e));
    }
  }
  return rows;
}

/**
 * Status of a row as seen from the playhead: a tool call that started but has
 * not finished at the playhead shows as running. Rows after the playhead keep
 * their final status (the UI dims them).
 */
export function rowStatusAt(row: TimelineRow, playheadSeq: number): RowStatus {
  const started = row.seq <= playheadSeq;
  if (row.callId !== null && started && (row.endSeq === null || row.endSeq > playheadSeq)) return 'running';
  return row.status;
}

/** A row built from the core text formatter (payload fields only). */
function plain(row: TimelineRow, e: AnyEvent): TimelineRow {
  const f = formatEvent(e);
  return { ...row, title: f.label, detail: f.detail, status: SEVERITY_TO_STATUS[f.severity] };
}

/** A tool result whose start was never seen (shown on its own rather than dropped). */
function orphan(row: TimelineRow, e: AnyEvent): TimelineRow {
  const r = plain(row, e);
  return { ...r, icon: r.status === 'ok' ? '✓' : '✗' };
}

/** "380 ms", "1.4 s", "2 m 05 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  running: 'running',
  ok: 'success',
  error: 'error',
  warn: 'warning',
  info: 'info',
};
