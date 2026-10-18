/**
 * TraceSessionManager: turns ingested Claude Code hook envelopes into traced
 * runs. Per envelope, synchronously and in arrival order:
 *   redact + slim (redactHook) → dedupe (trace_ingest) → mapHook (pure) → Recorder.recordBatch
 * The batch and its trace_ingest row commit in one transaction, so a retry
 * of an accepted delivery is always recognised as a duplicate.
 *
 * Each Claude Code session is one run per segment. Sessions do not use the
 * scripted run slot (RunManager), so they never conflict with the demo.
 */
import type { Db } from '../../store/db';
import type { Recorder } from '../../recorder';
import { ingestKey, redactHook, type HookEnvelope } from './hook-input';
import { DEFAULT_MAP_CONTEXT, initialSessionState, mapHook, sweep, type MapContext, type MapResult, type SessionState } from './mapper';

/** A session that delivered an accepted envelope (see TraceSessionManagerOptions.onSessionSeen). */
export interface SessionSeen {
  sessionId: string;
  /** The session's current (or just closed) run; null before its first run. */
  runId: string | null;
  /** The working directory Claude Code reported. Keep it in memory only (never store or return it). */
  cwd: string | null;
}

export interface TraceSessionManagerOptions {
  recorder: Recorder;
  db: Db;
  ctx?: Partial<MapContext>;
  /** Literal secrets to mask in hook payloads (the recorder masks them again). */
  secrets?: readonly string[];
  now?: () => Date;
  onError?: (err: unknown) => void;
  /**
   * Called for every accepted delivery, after mapping and before its events
   * are recorded, so a binding made here is in place when they are published.
   * It never changes what is recorded; a throw is reported to onError.
   */
  onSessionSeen?: (seen: SessionSeen) => void;
}

export interface IngestOutcome {
  accepted: number;
  duplicates: number;
  ignored: number;
}

export class TraceSessionManager {
  readonly ctx: MapContext;
  private readonly recorder: Recorder;
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;
  private readonly onSessionSeen: ((seen: SessionSeen) => void) | null;
  private readonly sessions = new Map<string, SessionState>();
  /** Wall-clock time each session last delivered an envelope (the idle sweep's clock; observedAt can be far older). */
  private readonly lastReceived = new Map<string, number>();
  private readonly secrets: readonly string[];
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: TraceSessionManagerOptions) {
    this.recorder = opts.recorder;
    this.db = opts.db;
    this.ctx = { ...DEFAULT_MAP_CONTEXT, ...opts.ctx };
    this.secrets = opts.secrets ?? [];
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? ((err) => console.error('[tracer]', err));
    this.onSessionSeen = opts.onSessionSeen ?? null;
  }

  /** Record a batch of envelopes in order. Never throws for a bad envelope: it is counted as ignored. */
  ingest(envelopes: readonly HookEnvelope[]): IngestOutcome {
    const out: IngestOutcome = { accepted: 0, duplicates: 0, ignored: 0 };
    for (const raw of envelopes) {
      const env: HookEnvelope = { ...raw, hook: redactHook(raw.hook, this.secrets) as HookEnvelope['hook'] };
      const sessionId = env.hook.session_id;
      const key = ingestKey(env.hook, env.deliveryId);
      this.lastReceived.set(sessionId, this.now().getTime());
      try {
        if (this.recorder.hasIngested(sessionId, key)) {
          out.duplicates++;
          continue;
        }
        const prev = this.load(sessionId);
        const result = mapHook(prev, env, this.ctx);
        const mark = { sessionId, key, hookEvent: env.hook.hook_event_name, observedAt: env.observedAt };
        if (result.batch || !result.ignored) this.notifySeen(result.state);
        if (result.batch) {
          this.apply(result, mark);
          out.accepted++;
        } else if (result.ignored) {
          out.ignored++;
        } else {
          this.recorder.markIngested(mark, result.state.runId);
          out.accepted++;
        }
        this.sessions.set(sessionId, result.state);
      } catch (err) {
        // The batch rolled back; the session state did not advance.
        out.ignored++;
        this.onError(err);
      }
    }
    return out;
  }

  /**
   * Close sessions that delivered nothing for `idleMinutes` of wall-clock time
   * (inferred, stamped at their last observed event). A spooled backlog keeps
   * its old observedAt, so idleness is measured from when envelopes arrived,
   * not from when Claude Code observed them. Returns the closed run ids.
   */
  sweepIdle(now: Date = this.now()): string[] {
    const idleMs = this.ctx.idleMinutes * 60_000;
    const closed: string[] = [];
    for (const [sessionId, state] of this.sessions) {
      const last = this.lastReceived.get(sessionId) ?? null;
      if (last === null || !state.lastObservedAt || now.getTime() - last < idleMs) continue;
      if (state.status !== 'open') {
        // Forget long-closed sessions; a later hook reloads them from the database.
        if (now.getTime() - last >= 2 * idleMs) {
          this.sessions.delete(sessionId);
          this.lastReceived.delete(sessionId);
        }
        continue;
      }
      try {
        const result = sweep(state, this.ctx, 'idle', state.lastObservedAt!);
        this.apply(result, null);
        this.sessions.set(sessionId, result.state);
        if (state.runId) closed.push(state.runId);
      } catch (err) {
        this.onError(err);
      }
    }
    return closed;
  }

  /**
   * Close a session's open run because Runloop stopped the process (a
   * dispatched session that was cancelled or timed out sends no SessionEnd).
   * Stamped now, all inferred; deliveries observed before now are late.
   * Returns the closed run id, or null when nothing was open.
   */
  closeStopped(sessionId: string, now: Date = this.now()): string | null {
    const state = this.sessions.get(sessionId);
    if (!state || state.status !== 'open' || !state.runId) return null;
    try {
      const result = sweep(state, this.ctx, 'stopped', now.toISOString());
      this.apply(result, null);
      this.sessions.set(sessionId, result.state);
      return state.runId;
    } catch (err) {
      this.onError(err);
      return null;
    }
  }

  /** Run the idle sweep every `intervalMs` (unref'd, so it never keeps the process alive). */
  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => this.sweepIdle(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Traced runs still open, newest first. */
  openRunIds(): string[] {
    const rows = this.db
      .prepare(`SELECT run_id FROM runs WHERE mode = 'traced' AND status = 'running' ORDER BY created_at DESC, rowid DESC`)
      .all() as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  /** In-memory state of a session (tests and diagnostics). */
  session(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  // ── internals ──────────────────────────────────────────────────────

  private notifySeen(state: SessionState): void {
    if (!this.onSessionSeen) return;
    try {
      this.onSessionSeen({ sessionId: state.sessionId, runId: state.runId, cwd: state.cwd ?? state.pending.cwd });
    } catch (err) {
      this.onError(err);
    }
  }

  private apply(result: MapResult, mark: Parameters<Recorder['markIngested']>[0] | null): void {
    const { batch } = result;
    if (!batch) return;
    this.recorder.recordBatch({
      runId: batch.runId,
      ...(batch.create ? { create: batch.create } : {}),
      drafts: batch.drafts,
      ...(mark ? { ingest: mark } : {}),
    });
  }

  /** Session state from memory, else from the latest recorded segment (after a restart). */
  private load(sessionId: string): SessionState {
    const known = this.sessions.get(sessionId);
    if (known) return known;
    const row = this.db
      .prepare(
        `SELECT run_id, segment, status, last_event_at FROM runs
         WHERE source_kind = 'claude-code' AND external_session_id = ? ORDER BY segment DESC LIMIT 1`,
      )
      .get(sessionId) as { run_id: string; segment: number; status: string; last_event_at: string | null } | undefined;
    if (!row) return initialSessionState(sessionId);
    // Its in-memory state is gone (e.g. evicted), so it cannot continue: close it like a restart would.
    if (row.status === 'running') this.recorder.interruptRun(row.run_id);
    const closedAt = (this.recorder.getRun(row.run_id)?.lastEventAt ?? row.last_event_at) || null;
    return initialSessionState(sessionId, { segment: row.segment, runId: row.run_id, closedAt, turnCount: this.turnCount(row.run_id) });
  }

  /** Highest turn number recorded in a run (turn ids continue across segments). */
  private turnCount(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(CAST(substr(task_id, 6) AS INTEGER)) AS n FROM events
         WHERE run_id = ? AND type = 'task.created' AND task_id LIKE 'turn-%'`,
      )
      .get(runId) as { n: number | null } | undefined;
    return row?.n ?? 0;
  }
}
