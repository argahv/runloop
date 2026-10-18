import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  deriveRefs,
  parseKnownEvent,
  redactEvent,
  redactText,
  type EventDraft,
  type EventOf,
  type PayloadOf,
  type RunEvent,
  type RunMode,
  type RunStatus,
  type RunSummary,
} from '@runloop-world/events';
import { EventBus, type Listener, type Unsubscribe } from './bus';
import { tx, type Db } from './store/db';

export type RunManifest = PayloadOf<'run.started'>;

/** A draft for recordBatch; `parentCallId` links it (parentEventId) to that call's tool.call_started. */
export type BatchDraft = EventDraft & { parentCallId?: string };

export interface RecordBatchInput {
  runId: string;
  /** Create the run first (run.started from this manifest is sequence 1). */
  create?: { manifest: RunManifest; timestamp?: string; provenance?: 'reported' | 'inferred' };
  drafts: readonly BatchDraft[];
  /** Mark a hook delivery as processed, in the same transaction (see trace_ingest). */
  ingest?: IngestMark;
}

export interface IngestMark {
  sessionId: string;
  key: string;
  hookEvent: string;
  observedAt: string | null;
}

export interface RecorderOptions {
  db: Db;
  /** Root of the runtime data dir; artifact bytes go to `<dataDir>/artifacts/<runId>/<artifactId>`. */
  dataDir: string;
  bus?: EventBus;
  /** Literal secret values to mask everywhere (see collectEnvSecrets). */
  secrets?: readonly string[];
  now?: () => Date;
  newId?: () => string;
}

export interface StoredArtifact {
  runId: string;
  artifactId: string;
  kind: string;
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  content: Buffer;
}

export class UnknownRunError extends Error {
  constructor(readonly runId: string) {
    super(`Unknown run: ${runId}`);
  }
}

export class RunClosedError extends Error {
  constructor(readonly runId: string, status: RunStatus) {
    super(`Run ${runId} is already ${status}; no more events can be appended`);
  }
}

/** The draft did not produce a valid known event. No sequence number was consumed. */
export class EventValidationError extends Error {}

/** Stored artifact bytes no longer match the sha256 recorded in their artifact.created event. */
export class ArtifactIntegrityError extends Error {
  constructor(
    readonly runId: string,
    readonly artifactId: string,
  ) {
    super(`Artifact ${artifactId} was modified after it was recorded (sha256 mismatch); refusing to serve it`);
  }
}

interface RunRow {
  run_id: string;
  mission_id: string;
  world_id: string;
  title: string;
  adapter_label: string;
  status: RunStatus;
  paused: number;
  created_at: string;
  ended_at: string | null;
  last_sequence: number;
  mode: RunMode;
  source_kind: string | null;
  external_session_id: string | null;
  segment: number | null;
  project_label: string | null;
  last_event_at: string | null;
  pinned_at: string | null;
}

/** Cached per-run write state. */
interface RunWriteState {
  lastSequence: number;
  status: RunStatus;
  mode: RunMode;
  /** Timestamp of run.started (traced timestamps are clamped to it). */
  startedMs: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function toSummary(r: RunRow): RunSummary {
  return {
    runId: r.run_id,
    title: r.title,
    missionId: r.mission_id,
    worldId: r.world_id,
    status: r.status,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    lastSequence: r.last_sequence,
    adapterLabel: r.adapter_label,
    paused: r.paused === 1,
    mode: r.mode,
    source:
      r.source_kind === 'claude-code' && r.external_session_id
        ? { kind: 'claude-code', sessionId: r.external_session_id, segment: r.segment ?? 1, projectLabel: r.project_label ?? '' }
        : null,
    lastEventAt: r.last_event_at,
    pinnedAt: r.pinned_at,
  };
}

/**
 * The single writer of the event log. `append` is synchronous and always:
 * redact → assign the next sequence → validate (strict) → persist in one
 * transaction → publish. Nothing is published that is not already durable.
 *
 * Run modes: executed runs get runtime timestamps and no provenance (the
 * runtime observed everything itself). Traced runs carry the source's time
 * (clamped to [run.started, now]) and a provenance, required on tool.* events,
 * so `tool.*` in an executed run still means "Runloop ran it".
 */
export class Recorder {
  readonly bus: EventBus;
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly secrets: readonly string[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Cached per-run write state; the DB is the source of truth on a cache miss. */
  private readonly runs = new Map<string, RunWriteState>();
  /** Open traced runs: callId → eventId of its tool.call_started (for parentCallId). */
  private readonly callStarts = new Map<string, Map<string, string>>();

  constructor(opts: RecorderOptions) {
    this.db = opts.db;
    this.dataDir = opts.dataDir;
    this.bus = opts.bus ?? new EventBus();
    this.secrets = opts.secrets ?? [];
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? randomUUID;
  }

  /** Mask secrets in arbitrary text (used for artifact bodies and error messages). */
  redact(text: string): string {
    return redactText(text, { secrets: this.secrets });
  }

  /** Create the run row and its `run.started` event (sequence 1) in one transaction. */
  createRun(input: { runId?: string; manifest: RunManifest }): EventOf<'run.started'> {
    const runId = input.runId ?? this.newId();
    if (this.findRow(runId)) throw new Error(`Run ${runId} already exists`);
    const event = this.buildStarted(runId, { type: 'run.started', payload: input.manifest, actorId: 'system' });
    tx(this.db, () => {
      this.insertRun(event);
      this.persist(event);
    });
    this.runs.set(runId, this.writeStateOf(event));
    this.bus.publish(event);
    return event;
  }

  /**
   * Record several drafts (optionally creating the run first, optionally
   * marking a hook delivery as ingested) in ONE transaction: all of them, or
   * none if any draft is invalid. Events are published after the commit.
   */
  recordBatch(input: RecordBatchInput): RunEvent[] {
    const { runId } = input;
    const events: RunEvent[] = [];
    let state: RunWriteState;
    if (input.create) {
      if (this.findRow(runId)) throw new Error(`Run ${runId} already exists`);
      const { manifest, timestamp, provenance } = input.create;
      const started = this.buildStarted(runId, {
        type: 'run.started',
        payload: manifest,
        actorId: 'system',
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(provenance !== undefined ? { provenance } : {}),
      });
      events.push(started);
      state = this.writeStateOf(started);
    } else {
      state = { ...this.state(runId) };
    }
    const batchStarts = new Map<string, string>();
    for (const { parentCallId, ...draft } of input.drafts) {
      if (draft.type === 'run.started') throw new EventValidationError('run.started is only emitted when creating a run');
      if (state.status !== 'running') throw new RunClosedError(runId, state.status);
      if (parentCallId !== undefined) {
        const parent = batchStarts.get(parentCallId) ?? this.findCallStart(runId, parentCallId);
        if (parent) draft.parentEventId = parent;
      }
      const e = this.build(runId, state.lastSequence + 1, draft as EventDraft, state);
      events.push(e);
      state.lastSequence = e.sequence;
      if (e.type === 'run.completed') state.status = e.payload.outcome;
      if (e.type === 'tool.call_started') batchStarts.set(e.payload.callId, e.eventId);
    }
    tx(this.db, () => {
      for (const e of events) {
        if (e.type === 'run.started') this.insertRun(e);
        this.persist(e);
      }
      if (input.ingest) this.insertIngest(input.ingest, runId);
    });
    this.runs.set(runId, state);
    if (state.mode === 'traced') {
      if (state.status === 'running') {
        let map = this.callStarts.get(runId);
        if (!map) this.callStarts.set(runId, (map = new Map()));
        for (const [callId, eventId] of batchStarts) map.set(callId, eventId);
      } else this.callStarts.delete(runId);
    }
    for (const e of events) this.bus.publish(e);
    return events;
  }

  /** Mark a hook delivery as processed when it produced no events (e.g. SessionStart before any prompt). */
  markIngested(mark: IngestMark, runId: string | null): void {
    tx(this.db, () => this.insertIngest(mark, runId));
  }

  /** Whether a hook delivery with this key was already processed for the session. */
  hasIngested(sessionId: string, key: string): boolean {
    return this.db.prepare('SELECT 1 FROM trace_ingest WHERE session_id = ? AND ingest_key = ?').get(sessionId, key) !== undefined;
  }

  append<T extends RunEvent['type']>(runId: string, draft: EventDraft<T>): EventOf<T>;
  append(runId: string, draft: EventDraft): RunEvent {
    return this.write(runId, draft, this.now());
  }

  private write(runId: string, draft: EventDraft, at: Date): RunEvent {
    if (draft.type === 'run.started') throw new EventValidationError('run.started is only emitted by createRun()');
    const state = this.state(runId);
    if (state.status !== 'running') throw new RunClosedError(runId, state.status);
    const event = this.build(runId, state.lastSequence + 1, draft, state, at);
    tx(this.db, () => this.persist(event));
    state.lastSequence = event.sequence;
    if (event.type === 'run.completed') state.status = event.payload.outcome;
    this.bus.publish(event);
    return event;
  }

  list(runId: string, opts: { after?: number; limit?: number } = {}): RunEvent[] {
    const rows = this.db
      .prepare('SELECT envelope_json FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(runId, opts.after ?? 0, opts.limit ?? 500) as { envelope_json: string }[];
    return rows.map((r) => JSON.parse(r.envelope_json) as RunEvent);
  }

  /** Every event of a run, in order. */
  listAll(runId: string): RunEvent[] {
    const out: RunEvent[] = [];
    for (;;) {
      const page = this.list(runId, { after: out.at(-1)?.sequence ?? 0, limit: 1000 });
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  getRun(runId: string): RunSummary | null {
    const row = this.findRow(runId);
    return row ? toSummary(row) : null;
  }

  /**
   * Pin a run as a baseline, or unpin it. Pinning is idempotent (an already
   * pinned run keeps its time). Works on runs in any state; it never touches
   * the event log. Throws UnknownRunError for an unknown run.
   */
  setPinned(runId: string, pinned: boolean): RunSummary {
    const row = this.findRow(runId);
    if (!row) throw new UnknownRunError(runId);
    const pinnedAt = pinned ? (row.pinned_at ?? this.now().toISOString()) : null;
    if (pinnedAt !== row.pinned_at) this.db.prepare('UPDATE runs SET pinned_at = ? WHERE run_id = ?').run(pinnedAt, runId);
    return toSummary({ ...row, pinned_at: pinnedAt });
  }

  listRuns(): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC').all() as unknown as RunRow[];
    return rows.map(toSummary);
  }

  subscribe(runId: string, fn: Listener): Unsubscribe {
    return this.bus.subscribe(runId, fn);
  }

  /** Every run's events, after each commit and in publish order (the world projector). */
  subscribeAll(fn: Listener): Unsubscribe {
    return this.bus.subscribeAll(fn);
  }

  /**
   * Store artifact bytes (text is redacted first) before the matching
   * `artifact.created` event is appended. Returns the size and hash to put in it.
   */
  putArtifactContent(runId: string, artifactId: string, content: string | Uint8Array): { bytes: number; sha256: string } {
    this.state(runId);
    const file = this.artifactPath(runId, artifactId);
    const buf = typeof content === 'string' ? Buffer.from(this.redact(content), 'utf8') : Buffer.from(content);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
    return { bytes: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  /** Whether `artifact.created` for this artifact id was recorded in the run. */
  hasArtifact(runId: string, artifactId: string): boolean {
    return this.db.prepare('SELECT 1 FROM artifacts WHERE run_id = ? AND artifact_id = ?').get(runId, artifactId) !== undefined;
  }

  /**
   * The artifact's metadata and bytes, or null if unknown. Throws
   * ArtifactIntegrityError if the bytes on disk no longer match the recorded
   * sha256 (they were changed after the fact).
   */
  getArtifact(runId: string, artifactId: string): StoredArtifact | null {
    if (!SAFE_ID.test(artifactId)) return null;
    const row = this.db
      .prepare('SELECT kind, name, media_type, byte_size, sha256 FROM artifacts WHERE run_id = ? AND artifact_id = ?')
      .get(runId, artifactId) as
      | { kind: string; name: string; media_type: string; byte_size: number; sha256: string }
      | undefined;
    if (!row) return null;
    let content: Buffer;
    try {
      content = readFileSync(this.artifactPath(runId, artifactId));
    } catch {
      return null;
    }
    if (createHash('sha256').update(content).digest('hex') !== row.sha256) {
      throw new ArtifactIntegrityError(runId, artifactId);
    }
    return {
      runId,
      artifactId,
      kind: row.kind,
      name: row.name,
      mediaType: row.media_type,
      bytes: row.byte_size,
      sha256: row.sha256,
      content,
    };
  }

  /**
   * Boot recovery: any run still marked `running` belonged to a runtime that
   * died. Each tool call without a terminal event gets
   * `tool.call_failed{runtime_restarted}`, then the run gets
   * `run.completed{interrupted}`. Returns the recovered run ids.
   *
   * Traced runs are different: Runloop did not run their calls, which may well
   * have finished while it was down. Their open calls close as `unobserved`
   * and both events are marked inferred. The next hook for the session opens
   * a continuation run.
   *
   * The crash time is unknown, so these events are stamped with the run's last
   * recorded activity (the last moment it is known to have been alive), not
   * the restart time: otherwise a replay would span the whole downtime. The
   * actual recovery time is kept in the run summary.
   */
  recoverInterrupted(): string[] {
    const rows = this.db.prepare(`SELECT run_id FROM runs WHERE status = 'running' ORDER BY created_at`).all() as {
      run_id: string;
    }[];
    const recoveredAt = this.now().toISOString();
    for (const { run_id: runId } of rows) this.interruptRun(runId, recoveredAt);
    return rows.map((r) => r.run_id);
  }

  /** Close one running run as interrupted (see recoverInterrupted). No-op if it is not running. */
  interruptRun(runId: string, recoveredAt: string = this.now().toISOString()): void {
    this.runs.delete(runId);
    this.callStarts.delete(runId);
    const row = this.findRow(runId);
    if (!row || row.status !== 'running') return;
    const traced = row.mode === 'traced';
    const open = new Map<string, EventOf<'tool.call_started'>>();
    let lastSeenMs = 0;
    for (const e of this.listAll(runId)) {
      lastSeenMs = Math.max(lastSeenMs, Date.parse(e.timestamp));
      if (e.type === 'tool.call_started') open.set(e.payload.callId, e);
      else if (e.type === 'tool.call_completed' || e.type === 'tool.call_failed') open.delete(e.payload.callId);
    }
    const at = new Date(lastSeenMs);
    for (const started of open.values()) {
      this.write(
        runId,
        {
          type: 'tool.call_failed',
          payload: {
            callId: started.payload.callId,
            errorType: traced ? 'unobserved' : 'runtime_restarted',
            message: traced
              ? 'Runloop was not running when this call finished (inferred)'
              : 'The runtime stopped before this call finished',
            // Known running time only (up to the last recorded event).
            durationMs: Math.max(0, lastSeenMs - Date.parse(started.timestamp)),
          },
          actorId: started.payload.agentId,
          ...(started.payload.taskId ? { taskId: started.payload.taskId } : {}),
          parentEventId: started.eventId,
          ...(traced ? { provenance: 'inferred' as const } : {}),
        },
        at,
      );
    }
    this.write(
      runId,
      {
        type: 'run.completed',
        payload: {
          outcome: 'interrupted',
          summary: traced
            ? `Runloop stopped while this session was being traced (recovered at ${recoveredAt}); later events open a continuation run`
            : `The runtime stopped while this run was active (recovered at ${recoveredAt})`,
        },
        actorId: 'system',
        ...(traced ? { provenance: 'inferred' as const } : {}),
      },
      at,
    );
  }

  // ── internals ───────────────────────────────────────────────────

  /**
   * Redact, stamp and strictly validate one draft. `run` is the run's write
   * state (null for its run.started, whose manifest decides the mode).
   */
  private build(runId: string, sequence: number, draft: EventDraft, run: RunWriteState | null, at: Date = this.now()): RunEvent {
    const { event: d } = redactEvent(draft, { secrets: this.secrets });
    const mode: RunMode = run?.mode ?? (d.type === 'run.started' ? (d.payload.mode ?? 'executed') : 'executed');
    let timestamp = at.toISOString();
    if (mode === 'executed') {
      if (d.provenance !== undefined || d.timestamp !== undefined) {
        throw new EventValidationError(`Invalid ${d.type} event: provenance and timestamp are only allowed on traced runs`);
      }
    } else {
      if (/^tool\./.test(d.type) && d.provenance === undefined) {
        throw new EventValidationError(`Invalid ${d.type} event: traced tool events need a provenance`);
      }
      if (d.timestamp !== undefined) {
        const ms = Date.parse(d.timestamp);
        if (!Number.isFinite(ms)) throw new EventValidationError(`Invalid ${d.type} event: bad timestamp ${d.timestamp}`);
        timestamp = new Date(Math.min(at.getTime(), Math.max(run?.startedMs ?? -Infinity, ms))).toISOString();
      }
    }
    const raw = {
      eventId: this.newId(),
      runId,
      sequence,
      timestamp,
      type: d.type,
      schemaVersion: SCHEMA_VERSION,
      ...deriveRefs(d),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
      ...(d.taskId !== undefined ? { taskId: d.taskId } : {}),
      ...(d.parentEventId !== undefined ? { parentEventId: d.parentEventId } : {}),
      visibility: d.visibility ?? 'public',
      ...(d.provenance !== undefined ? { provenance: d.provenance } : {}),
      payload: d.payload,
    };
    const parsed = parseKnownEvent(raw);
    if (!parsed.ok) throw new EventValidationError(`Invalid ${draft.type} event: ${parsed.error}`);
    return parsed.event;
  }

  private buildStarted(runId: string, draft: EventDraft<'run.started'>): EventOf<'run.started'> {
    const event = this.build(runId, 1, draft, null);
    if (event.type !== 'run.started') throw new EventValidationError('expected run.started');
    return event;
  }

  private writeStateOf(started: EventOf<'run.started'>): RunWriteState {
    return { lastSequence: 1, status: 'running', mode: started.payload.mode ?? 'executed', startedMs: Date.parse(started.timestamp) };
  }

  /** Insert the run row for its run.started event. Call inside tx(). */
  private insertRun(e: EventOf<'run.started'>): void {
    const p = e.payload;
    this.db
      .prepare(
        `INSERT INTO runs (run_id, mission_id, world_id, title, adapter_label, status, paused, manifest_json, created_at, last_sequence,
                           mode, source_kind, external_session_id, segment, project_label)
         VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.runId,
        p.missionId,
        p.worldId,
        p.title,
        p.adapter.label,
        JSON.stringify(p),
        e.timestamp,
        p.mode ?? 'executed',
        p.source?.kind ?? null,
        p.source?.sessionId ?? null,
        p.source?.segment ?? null,
        p.source?.projectLabel ?? null,
      );
  }

  private insertIngest(mark: IngestMark, runId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO trace_ingest (session_id, ingest_key, run_id, hook_event, observed_at, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(mark.sessionId, mark.key, runId, mark.hookEvent, mark.observedAt, this.now().toISOString());
  }

  /** eventId of a call's tool.call_started in this run (cache, then the log). */
  private findCallStart(runId: string, callId: string): string | undefined {
    const cached = this.callStarts.get(runId)?.get(callId);
    if (cached) return cached;
    const row = this.db
      .prepare(
        `SELECT event_id FROM events WHERE run_id = ? AND type = 'tool.call_started' AND json_extract(envelope_json, '$.payload.callId') = ? LIMIT 1`,
      )
      .get(runId, callId) as { event_id: string } | undefined;
    return row?.event_id;
  }

  /** Insert the event and apply its effect on the run row. Call inside tx(). */
  private persist(e: RunEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (run_id, sequence, event_id, type, timestamp, actor_id, task_id, parent_event_id, visibility, envelope_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.runId,
        e.sequence,
        e.eventId,
        e.type,
        e.timestamp,
        e.actorId ?? null,
        e.taskId ?? null,
        e.parentEventId ?? null,
        e.visibility,
        JSON.stringify(e),
      );
    this.db.prepare('UPDATE runs SET last_sequence = ?, last_event_at = ? WHERE run_id = ?').run(e.sequence, e.timestamp, e.runId);
    switch (e.type) {
      case 'run.completed':
        this.db
          .prepare('UPDATE runs SET status = ?, ended_at = ?, paused = 0 WHERE run_id = ?')
          .run(e.payload.outcome, e.timestamp, e.runId);
        break;
      case 'run.paused':
      case 'run.resumed':
        this.db.prepare('UPDATE runs SET paused = ? WHERE run_id = ?').run(e.type === 'run.paused' ? 1 : 0, e.runId);
        break;
      case 'artifact.created':
        this.db
          .prepare(
            `INSERT INTO artifacts (run_id, artifact_id, kind, name, media_type, byte_size, sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            e.runId,
            e.payload.artifactId,
            e.payload.kind,
            e.payload.name,
            e.payload.mediaType,
            e.payload.bytes,
            e.payload.sha256,
            e.timestamp,
          );
        break;
      default:
        break;
    }
  }

  private findRow(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
  }

  private state(runId: string): RunWriteState {
    let s = this.runs.get(runId);
    if (!s) {
      const row = this.findRow(runId);
      if (!row) throw new UnknownRunError(runId);
      s = { lastSequence: row.last_sequence, status: row.status, mode: row.mode, startedMs: Date.parse(row.created_at) };
      this.runs.set(runId, s);
    }
    return s;
  }

  private artifactPath(runId: string, artifactId: string): string {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(artifactId)) throw new Error(`Unsafe artifact id: ${artifactId}`);
    return path.join(this.dataDir, 'artifacts', runId, artifactId);
  }
}
