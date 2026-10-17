import { formatEvent, type ExecState } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent, type TestMetrics } from '@runloop-world/events';
import { describeEvent, failureText, MARKER_GLYPH } from './labels';
import { categoryOfStart, eventProvenance } from './selection';

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
  /** Tool name for tool rows. */
  tool: string | null;
  /** Tool category, when the source reports one (traced runs). */
  category: string | null;
  /** Types of every event merged into the row (start, completion, artifacts). */
  types: string[];
  /** Sequences of every event merged into the row. */
  seqs: number[];
  /** Some merged event was reconstructed by Runloop rather than reported. */
  inferred: boolean;
  /** Sequence of the first merged event Runloop reconstructed (show the chip once the playhead reaches it). */
  inferredSeq: number | null;
  /**
   * The subagent this row hands work to: an `Agent` call's subagent, or the
   * owner of a delegated task (traced runs). Null otherwise.
   */
  delegateId: string | null;
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
  'agent.usage_reported': '¤',
};

/** Task kinds whose created / assigned / started events read best as one row (traced runs). */
const MERGED_TASK_KINDS = new Set(['turn', 'delegated']);

/** Agent state changes worth a Timeline row (the rest is in Logs). */
const NOTABLE_AGENT_STATES = new Set(['failed', 'blocked']);

/**
 * Turn the ordered event log into Timeline rows. A tool call's start and its
 * completion (or failure) become one row carrying the duration and status;
 * artifacts produced by a call attach to that row. In traced runs a turn's or
 * delegation's created / assigned / started events also share one row, and an
 * `Agent` call row links to the subagent it started. Rows are independent of
 * the playhead: use {@link rowStatusAt} / `row.seq > playheadSeq` when rendering.
 * `exec` (the latest state) supplies agent and task names for the wording.
 */
export function buildTimelineRows(events: readonly AnyEvent[], timeOfSeq: (seq: number) => number, exec?: ExecState): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const byCall = new Map<string, TimelineRow>();
  const taskOwner = new Map<string, string>();
  /** tool.call_started eventId → callId (delegations point at the call that started them). */
  const callOfStart = new Map<string, string>();
  /** Delegated taskId → the row of the call that delegated it. */
  const callRowOfTask = new Map<string, TimelineRow>();
  /** taskId → its merged task row (turns and delegations). */
  const taskRows = new Map<string, TimelineRow>();
  /** permissionId → the agent that asked. */
  const permAgent = new Map<string, string>();

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
    tool: null,
    category: null,
    types: [e.type],
    seqs: [e.sequence],
    inferred: eventProvenance(e) === 'inferred',
    inferredSeq: eventProvenance(e) === 'inferred' ? e.sequence : null,
    delegateId: null,
  });

  /** Fold a later event (completion, artifact) into an existing row. */
  const merge = (row: TimelineRow, e: AnyEvent) => {
    if (!row.types.includes(e.type)) row.types.push(e.type);
    row.seqs.push(e.sequence);
    if (eventProvenance(e) === 'inferred') {
      row.inferred = true;
      row.inferredSeq ??= e.sequence;
    }
  };

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
          tool: p.tool,
          category: categoryOfStart(e),
        };
        byCall.set(p.callId, row);
        callOfStart.set(e.eventId, p.callId);
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
        merge(row, e);
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
        merge(row, e);
        row.endSeq = e.sequence;
        row.status = 'error';
        row.icon = '✗';
        const what = failureText(p.errorType);
        row.detail = `${what.charAt(0).toUpperCase()}${what.slice(1)}: ${p.message}`;
        row.durationMs = p.durationMs;
        break;
      }
      case 'artifact.created': {
        const p = e.payload;
        const row = p.producedByCallId ? byCall.get(p.producedByCallId) : undefined;
        if (row) {
          merge(row, e);
          if (!row.artifactIds.includes(p.artifactId)) row.artifactIds.push(p.artifactId);
        } else {
          rows.push({ ...plain(base(e), e, exec), artifactIds: [p.artifactId] });
        }
        break;
      }
      case 'agent.state_changed':
        if (NOTABLE_AGENT_STATES.has(e.payload.state)) rows.push(plain(base(e), e, exec));
        break;
      case 'task.created': {
        const p = e.payload;
        const row = plain(base(e), e, exec);
        if (MERGED_TASK_KINDS.has(p.kind)) {
          taskRows.set(p.taskId, row);
          // A turn is about the agent that works it, not the user who opened it.
          if (p.kind === 'turn') row.actorId = exec?.tasks[p.taskId]?.ownerId ?? row.actorId;
        }
        const viaCall = e.parentEventId ? callOfStart.get(e.parentEventId) : undefined;
        if (p.kind === 'delegated' && viaCall) callRowOfTask.set(p.taskId, byCall.get(viaCall)!);
        rows.push(row);
        break;
      }
      case 'task.assigned':
      case 'task.started': {
        const p = e.payload;
        taskOwner.set(p.taskId, p.agentId);
        const callRow = callRowOfTask.get(p.taskId);
        if (callRow) callRow.delegateId = p.agentId;
        const taskRow = taskRows.get(p.taskId);
        // Merge only while nothing else happened in between (the row still reads as one moment).
        if (taskRow && rows.at(-1) === taskRow) {
          merge(taskRow, e);
          if (exec?.tasks[p.taskId]?.kind === 'delegated') taskRow.delegateId = p.agentId;
          break;
        }
        rows.push(plain(base(e), e, exec));
        break;
      }
      case 'tool.permission_requested':
        permAgent.set(e.payload.permissionId, e.payload.agentId);
        rows.push(plain(base(e), e, exec));
        break;
      case 'tool.permission_resolved': {
        const row = plain(base(e), e, exec);
        if (!e.actorId) row.actorId = permAgent.get(e.payload.permissionId) ?? row.actorId;
        rows.push(row);
        break;
      }
      case 'run.marker':
        rows.push({ ...plain(base(e), e, exec), icon: MARKER_GLYPH[e.payload.kind] ?? '⚑' });
        break;
      default:
        rows.push(plain(base(e), e, exec));
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

/** Index of the row that holds event `seq` (a tool row holds its start, result and artifacts). */
export function rowIndexOfSeq(rows: readonly TimelineRow[], seq: number | null): number {
  if (seq === null) return -1;
  return rows.findIndex((r) => r.seqs.includes(seq));
}

/** A row worded from payload fields only (studio labels when `exec` is given, else the core formatter). */
function plain(row: TimelineRow, e: AnyEvent, exec?: ExecState): TimelineRow {
  const f = exec ? describeEvent(e, exec) : formatEvent(e);
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

/** Index of the last row whose first event is at or before `seq` (rows are in sequence order), or -1. */
export function lastRowAtOrBefore(rows: readonly TimelineRow[], seq: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The row that holds each event sequence. */
export function rowIndexBySeq(rows: readonly TimelineRow[]): Map<number, TimelineRow> {
  const m = new Map<number, TimelineRow>();
  for (const r of rows) for (const seq of r.seqs) m.set(seq, r);
  return m;
}

/**
 * Which visible row to mark as selected. The selected event's own row; for an
 * event that is no row (a state change), the agent's latest visible row
 * before it. When the filters hide the event's row, no other row is marked:
 * `hiddenSeq` says so (the timeline must not contradict the inspector).
 */
export function selectedRow(
  rows: readonly TimelineRow[],
  rowOfSeq: ReadonlyMap<number, TimelineRow>,
  visibleRows: readonly TimelineRow[],
  selectedSeq: number | null,
  selectedAgentId: string | null,
): { index: number; hiddenSeq: number | null } {
  if (selectedSeq === null) return { index: -1, hiddenSeq: null };
  const own = rowOfSeq.get(selectedSeq);
  if (own) {
    const index = visibleRows === rows ? rows.indexOf(own) : visibleRows.indexOf(own);
    return index >= 0 ? { index, hiddenSeq: null } : { index: -1, hiddenSeq: selectedSeq };
  }
  if (selectedAgentId === null) return { index: -1, hiddenSeq: null };
  for (let i = lastRowAtOrBefore(visibleRows, selectedSeq); i >= 0; i--) {
    if (visibleRows[i]!.actorId === selectedAgentId) return { index: i, hiddenSeq: null };
  }
  return { index: -1, hiddenSeq: null };
}
