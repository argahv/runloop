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
  type RunStatus,
  type RunSummary,
} from '@runloop-world/events';
import { EventBus, type Listener, type Unsubscribe } from './bus';
import { tx, type Db } from './store/db';

export type RunManifest = PayloadOf<'run.started'>;

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
  };
}

/**
 * The single writer of the event log. `append` is synchronous and always:
 * redact → assign the next sequence → validate (strict) → persist in one
 * transaction → publish. Nothing is published that is not already durable.
 */
export class Recorder {
  readonly bus: EventBus;
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly secrets: readonly string[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Cached per-run write state; the DB is the source of truth on a cache miss. */
  private readonly runs = new Map<string, { lastSequence: number; status: RunStatus }>();

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
    const event = this.build(runId, 1, { type: 'run.started', payload: input.manifest, actorId: 'system' });
    if (event.type !== 'run.started') throw new EventValidationError('expected run.started');
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO runs (run_id, mission_id, world_id, title, adapter_label, status, paused, manifest_json, created_at, last_sequence)
           VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, 0)`,
        )
        .run(
          runId,
          event.payload.missionId,
          event.payload.worldId,
          event.payload.title,
          event.payload.adapter.label,
          JSON.stringify(event.payload),
          event.timestamp,
        );
      this.persist(event);
    });
    this.runs.set(runId, { lastSequence: 1, status: 'running' });
    this.bus.publish(event);
    return event;
  }

  append<T extends RunEvent['type']>(runId: string, draft: EventDraft<T>): EventOf<T>;
  append(runId: string, draft: EventDraft): RunEvent {
    return this.write(runId, draft, this.now());
  }

  private write(runId: string, draft: EventDraft, at: Date): RunEvent {
    if (draft.type === 'run.started') throw new EventValidationError('run.started is only emitted by createRun()');
    const state = this.state(runId);
    if (state.status !== 'running') throw new RunClosedError(runId, state.status);
    const event = this.build(runId, state.lastSequence + 1, draft, at);
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

  listRuns(): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC').all() as unknown as RunRow[];
    return rows.map(toSummary);
  }

  subscribe(runId: string, fn: Listener): Unsubscribe {
    return this.bus.subscribe(runId, fn);
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
    for (const { run_id: runId } of rows) {
      this.runs.delete(runId);
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
              errorType: 'runtime_restarted',
              message: 'The runtime stopped before this call finished',
              // Known running time only (up to the last recorded event).
              durationMs: Math.max(0, lastSeenMs - Date.parse(started.timestamp)),
            },
            actorId: started.payload.agentId,
            ...(started.payload.taskId ? { taskId: started.payload.taskId } : {}),
            parentEventId: started.eventId,
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
            summary: `The runtime stopped while this run was active (recovered at ${recoveredAt})`,
          },
          actorId: 'system',
        },
        at,
      );
    }
    return rows.map((r) => r.run_id);
  }

  // ── internals ───────────────────────────────────────────────────

  private build(runId: string, sequence: number, draft: EventDraft, at: Date = this.now()): RunEvent {
    const { event: d } = redactEvent(draft, { secrets: this.secrets });
    const raw = {
      eventId: this.newId(),
      runId,
      sequence,
      timestamp: at.toISOString(),
      type: d.type,
      schemaVersion: SCHEMA_VERSION,
      ...deriveRefs(d),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
      ...(d.taskId !== undefined ? { taskId: d.taskId } : {}),
      ...(d.parentEventId !== undefined ? { parentEventId: d.parentEventId } : {}),
      visibility: d.visibility ?? 'public',
      payload: d.payload,
    };
    const parsed = parseKnownEvent(raw);
    if (!parsed.ok) throw new EventValidationError(`Invalid ${draft.type} event: ${parsed.error}`);
    return parsed.event;
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
    this.db.prepare('UPDATE runs SET last_sequence = ? WHERE run_id = ?').run(e.sequence, e.runId);
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

  private state(runId: string): { lastSequence: number; status: RunStatus } {
    let s = this.runs.get(runId);
    if (!s) {
      const row = this.findRow(runId);
      if (!row) throw new UnknownRunError(runId);
      s = { lastSequence: row.last_sequence, status: row.status };
      this.runs.set(runId, s);
    }
    return s;
  }

  private artifactPath(runId: string, artifactId: string): string {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(artifactId)) throw new Error(`Unsafe artifact id: ${artifactId}`);
    return path.join(this.dataDir, 'artifacts', runId, artifactId);
  }
}
