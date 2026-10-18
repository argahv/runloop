/**
 * The world host (plan §4.1): the one place that reads the clock for the
 * town. It boots the world from the database, runs due ticks every 50 ms,
 * applies commands, persists events in batches and publishes them only after
 * they are committed (the recorder.ts rule).
 *
 * - Ticking: due = anchorTick + floor((now − anchorWall)·speed/1000) − tick.
 *   At most 40 ticks per wake; when more are due the host reports `lagging`
 *   and drops them (re-anchors) rather than catching up.
 * - Commands apply as soon as they arrive, at the current tick (applyInputs),
 *   paused or not, and are committed before submit resolves.
 * - Persistence: one transaction every 250 ms or 500 events (events, tick,
 *   last_seq, speed). Checkpoints every 10 wall minutes, at sim midnight and
 *   on stop; retention keeps 24 plus one per day for 14 days, ambient events
 *   for 3 sim days.
 * - Boot: fold forward from the latest checkpoint, then append
 *   world.resumed_after_offline (and world.sim_upgraded on a new SIM_VERSION).
 *   The town stored with the world wins over the files on disk.
 *
 * Never imports dispatch (P11).
 */
import { randomInt } from 'node:crypto';
import {
  CommandEnvelopeSchema,
  CommandIdSchema,
  WorldCommandSchema,
  isSourceAllowed,
  parseWorldEvent,
  residentId,
  type CommandEnvelope,
  type Explanation,
  type WorldClockFrame,
  type WorldCommandResponse,
  type WorldEvent,
  type WorldEventDraft,
  type WorldEventsPageResponse,
  type WorldEventsQuery,
  type WorldInfoResponse,
  type WorldSnapshot,
  type WorldTownResponse,
} from '@runloop-world/events';
import {
  SIM_VERSION,
  WorldReplay,
  applyEvent,
  applyInputs,
  createWorld,
  explain,
  hashState,
  step,
  type SimState,
  type SimWorld,
} from '@runloop-world/sim';
import { loadTown, type CompiledTown } from '@runloop-world/town';
import type { Db } from '../store/db';
import { WorldStore } from './world-store';

export const MAX_TICKS_PER_WAKE = 40;
export const DAY_TICKS = 1440;

export interface TownFiles {
  town: unknown;
  interiors: Record<string, unknown>;
}

export interface WorldHostOptions {
  db: Db;
  /** The town files, used when the world is created (afterwards the stored copy wins). */
  town: TownFiles;
  /** Wall clock in ms since the epoch; the only clock the world reads. */
  now: () => number;
  /** For a new world (default: random). */
  seed?: number;
  /** Residents of a new world (default: the town's population.default). */
  population?: number;
  /** Default: the town id. */
  worldId?: string;
  /** Wake interval; 0 = no timer (tests call pump()). Default 50 ms. */
  tickMs?: number;
  flushMs?: number;
  flushEvents?: number;
  checkpointMs?: number;
  onError?: (err: unknown) => void;
}

export type WorldListener = (batch: readonly WorldEvent[]) => void;

export class WorldHost {
  readonly store: WorldStore;
  readonly worldId: string;
  readonly town: CompiledTown;
  readonly townFiles: TownFiles;
  readonly seed: number;
  readonly createdAt: string;
  private readonly world: SimWorld;
  private readonly opts: Required<Pick<WorldHostOptions, 'tickMs' | 'flushMs' | 'flushEvents' | 'checkpointMs'>> & WorldHostOptions;
  private s: SimState;
  /** The last tick the host ran (can be ahead of the last event's tick). */
  private hostTick: number;
  private anchorTick = 0;
  private anchorWall = 0;
  private running = false;
  private stopped = false;
  private failed: unknown = null;
  private lagging = false;
  private lastLagMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private pending: WorldEvent[] = [];
  private lastFlushWall: number;
  private lastCheckpointWall: number;
  private readonly listeners = new Set<WorldListener>();
  private readonly outcomes = new Map<string, WorldCommandResponse>();

  constructor(opts: WorldHostOptions) {
    this.opts = { tickMs: 50, flushMs: 250, flushEvents: 500, checkpointMs: 10 * 60_000, ...opts };
    this.store = new WorldStore(opts.db);
    const now = opts.now();
    this.lastFlushWall = now;
    this.lastCheckpointWall = now;
    const row = this.store.loadWorld(opts.worldId);
    if (row) {
      // Boot an existing world: its own town, checkpoint + fold, then the resume event.
      this.townFiles = JSON.parse(row.townJson) as TownFiles;
      this.town = loadTown(this.townFiles.town, this.townFiles.interiors);
      if (this.town.contentHash !== row.contentHash) throw new Error(`World ${row.worldId}: stored town hash ${this.town.contentHash} ≠ ${row.contentHash}`);
      this.worldId = row.worldId;
      this.seed = row.seed;
      this.createdAt = row.createdAt;
      this.world = { town: this.town, seed: row.seed };
      this.s = this.boot();
      this.hostTick = Math.max(row.tick, this.s.tick);
      const since = Date.parse(row.hostStoppedAt ?? row.createdAt);
      this.emit({ tick: this.hostTick, type: 'world.resumed_after_offline', prov: 'system', p: { offlineWallMs: Math.max(0, Math.round(now - since)) } });
      if (row.simVersion !== SIM_VERSION) {
        this.emit({ tick: this.hostTick, type: 'world.sim_upgraded', prov: 'system', p: { fromVersion: row.simVersion, toVersion: SIM_VERSION } });
        this.store.setSimVersion(this.worldId, SIM_VERSION);
      }
      this.flush();
    } else {
      this.townFiles = opts.town;
      this.town = loadTown(opts.town.town, opts.town.interiors);
      this.worldId = opts.worldId ?? this.town.def.id;
      this.seed = opts.seed ?? randomInt(2 ** 31);
      this.createdAt = new Date(now).toISOString();
      this.world = { town: this.town, seed: this.seed };
      const drafts = createWorld(this.town, { worldId: this.worldId, seed: this.seed, population: opts.population ?? this.town.def.population.default });
      const start = drafts[0]!.tick;
      this.store.createWorld({
        worldId: this.worldId,
        townId: this.town.def.id,
        contentHash: this.town.contentHash,
        townJson: JSON.stringify(opts.town),
        seed: this.seed,
        simVersion: SIM_VERSION,
        tick: start,
        lastSeq: 0,
        speed: 1,
        prevSpeed: 1,
        createdAt: this.createdAt,
        hostStoppedAt: null,
      });
      this.hostTick = start;
      this.s = null as unknown as SimState;
      for (const d of drafts) this.emit(d);
      this.flush();
      this.checkpoint();
    }
  }

  /** Latest checkpoint (hash-checked) plus the tail of the log. */
  private boot(): SimState {
    const cp = this.store.latestCheckpoint(this.worldId);
    if (cp && hashState(cp.state) !== cp.stateHash) throw new Error(`World ${this.worldId}: checkpoint at seq ${cp.seq} does not match its hash`);
    const tail = this.store.eventsAfter(this.worldId, cp?.seq ?? 0);
    const replay = new WorldReplay(tail, cp ? [{ seq: cp.seq, state: cp.state }] : [], this.town);
    const last = tail.at(-1)?.seq ?? cp?.seq;
    if (last === undefined) throw new Error(`World ${this.worldId} has no events`);
    return replay.stateAt(last);
  }

  /** Start ticking (the clock anchors now). */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.reanchor(this.opts.now());
    if (this.opts.tickMs > 0) {
      this.timer = setInterval(() => this.pump(), this.opts.tickMs);
      this.timer.unref();
    }
  }

  /** Stop ticking, flush, checkpoint and record the stop time. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.flush();
      this.checkpoint();
    } catch (err) {
      this.report(err);
    }
  }

  /** Run the ticks that are due now (the timer calls this every tickMs). */
  pump(): void {
    if (!this.running || this.failed) return;
    const now = this.opts.now();
    try {
      if (this.s.speed > 0) {
        const due = this.anchorTick + Math.floor(((now - this.anchorWall) * this.s.speed) / 1000) - this.hostTick;
        const run = Math.min(Math.max(due, 0), MAX_TICKS_PER_WAKE);
        for (let i = 0; i < run; i++) {
          this.hostTick++;
          step(this.s, this.world, this.hostTick, [], (d) => this.emit(d));
          if (this.hostTick % DAY_TICKS === 0) {
            this.flush();
            this.checkpoint();
          }
        }
        this.lagging = due > MAX_TICKS_PER_WAKE;
        this.lastLagMs = this.lagging ? Math.round(((due - MAX_TICKS_PER_WAKE) * 1000) / this.s.speed) : 0;
        if (this.lagging) this.reanchor(now); // drop what could not run
      }
      if (this.pending.length >= this.opts.flushEvents || now - this.lastFlushWall >= this.opts.flushMs) this.flush();
      if (now - this.lastCheckpointWall >= this.opts.checkpointMs) {
        this.flush();
        this.checkpoint();
      }
    } catch (err) {
      this.failed = err;
      this.report(err);
    }
  }

  /**
   * Apply a command now (validated by the sim; a rejection is logged too) and
   * resolve once it is committed. A command id is processed once: resubmitting
   * it returns the first outcome.
   */
  async submit(raw: CommandEnvelope): Promise<WorldCommandResponse> {
    if (this.stopped) throw new Error('The world host is stopped');
    const seen = this.outcome(raw?.id);
    if (seen) return seen;
    const parsed = CommandEnvelopeSchema.safeParse(raw);
    let env: CommandEnvelope;
    if (parsed.success) env = parsed.data;
    else {
      // A forbidden source is logged as such even when the envelope is incomplete (P3).
      const id = CommandIdSchema.safeParse(raw?.id);
      const cmd = WorldCommandSchema.safeParse(raw?.command);
      if (!id.success || !cmd.success || isSourceAllowed(cmd.data.type, raw.source)) return { ok: false, code: 'invalid' };
      env = { id: id.data, source: raw.source, command: cmd.data };
    }
    const [e] = applyInputs(this.s, this.world, this.hostTick, [env], (d) => this.emit(d));
    if (!e) throw new Error('applyInputs produced no event');
    if (e.type === 'world.clock_changed') this.reanchor(this.opts.now());
    this.flush();
    return this.outcome(env.id)!;
  }

  private outcome(id: unknown): WorldCommandResponse | null {
    if (typeof id !== 'string') return null;
    const known = this.outcomes.get(id);
    if (known) return known;
    const e = CommandIdSchema.safeParse(id).success ? this.store.findCommand(this.worldId, id) : null;
    if (!e) return null;
    const out: WorldCommandResponse = e.type === 'command.rejected' ? { ok: false, code: e.p.code } : { ok: true, seq: e.seq, tick: e.tick };
    this.outcomes.set(id, out);
    return out;
  }

  /** Assign the seq, check the truth rules, apply, queue for the next commit. */
  private emit(draft: WorldEventDraft): WorldEvent {
    const seq = (this.s?.seq ?? 0) + 1;
    const parsed = parseWorldEvent({ ...draft, seq });
    if (!parsed.ok) throw new Error(`The sim produced an invalid event: ${parsed.error}`);
    const e = parsed.event;
    this.s = applyEvent(this.s ?? null, e, this.town);
    this.pending.push(e);
    if (e.cmdId) {
      this.outcomes.set(e.cmdId, e.type === 'command.rejected' ? { ok: false, code: e.p.code } : { ok: true, seq: e.seq, tick: e.tick });
    }
    return e;
  }

  /** Commit pending events with the clock, then publish them. */
  flush(): void {
    const batch = this.pending;
    const now = this.opts.now();
    this.lastFlushWall = now;
    this.store.commit(this.worldId, batch, {
      tick: this.hostTick,
      lastSeq: this.s.seq,
      speed: this.s.speed,
      prevSpeed: this.s.prevSpeed,
      aliveAt: new Date(now).toISOString(),
    });
    this.pending = [];
    if (this.outcomes.size > 10_000) this.outcomes.clear();
    if (!batch.length) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(batch);
      } catch (err) {
        this.report(err);
      }
    }
  }

  /** A checkpoint of the committed state, then retention. */
  private checkpoint(): void {
    this.lastCheckpointWall = this.opts.now();
    this.store.writeCheckpoint(this.worldId, { seq: this.s.seq, tick: this.hostTick, simVersion: SIM_VERSION, stateHash: hashState(this.s), state: this.s });
    this.store.prune(this.worldId, { tick: this.hostTick, latest: 24, days: 14, ambientTicks: 3 * DAY_TICKS });
  }

  private reanchor(now: number): void {
    this.anchorTick = this.hostTick;
    this.anchorWall = now;
  }

  private report(err: unknown): void {
    (this.opts.onError ?? ((e) => console.error('[world]', e)))(err);
  }

  /** Listen to committed event batches (in seq order). */
  subscribe(fn: WorldListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The committed state (pending events are committed first). A copy. */
  snapshot(): WorldSnapshot {
    if (this.pending.length && !this.stopped) this.flush();
    return structuredClone(this.s);
  }

  /** The current state's hash (tests compare it with a client's fold). */
  stateHash(): string {
    return hashState(this.s);
  }

  get tick(): number {
    return this.hostTick;
  }

  get seq(): number {
    return this.s.seq;
  }

  /** How far behind the clock the last wake was (0 when on time). */
  lagMs(): number {
    return this.lastLagMs;
  }

  /** The error that stopped the ticking, if any. */
  get error(): unknown {
    return this.failed;
  }

  info(): WorldInfoResponse {
    return {
      worldId: this.worldId,
      townId: this.town.def.id,
      contentHash: this.town.contentHash,
      simVersion: this.s.simVersion,
      seed: this.seed,
      tick: this.hostTick,
      seq: this.s.seq,
      speed: this.s.speed,
      prevSpeed: this.s.prevSpeed,
      lagging: this.lagging,
      population: this.s.residents.length,
      createdAt: this.createdAt,
    };
  }

  townResponse(): WorldTownResponse {
    return { townId: this.town.def.id, contentHash: this.town.contentHash, town: this.townFiles.town, interiors: this.townFiles.interiors };
  }

  /** The SSE clock frame: when the current tick began, so Studio can interpolate. */
  clockFrame(): WorldClockFrame {
    const now = this.opts.now();
    const wallMs = this.s.speed > 0 && this.running ? this.anchorWall + Math.round(((this.hostTick - this.anchorTick) * 1000) / this.s.speed) : now;
    return { tick: this.hostTick, speed: this.s.speed, wallMs: Math.max(0, Math.min(wallMs, now)), lagging: this.lagging };
  }

  /** A page of committed events. */
  events(q: WorldEventsQuery): WorldEventsPageResponse {
    if (this.pending.length && !this.stopped) this.flush();
    const events = this.store.events(this.worldId, { after: q.after, limit: q.limit + 1, ...(q.actor ? { actor: q.actor } : {}), ...(q.type ? { type: q.type } : {}), ...(q.prov ? { prov: q.prov } : {}) });
    const page = events.slice(0, q.limit);
    return { events: page, nextAfter: page.at(-1)?.seq ?? q.after, hasMore: events.length > q.limit };
  }

  /** Why resident `idx` decided, as of world seq `atSeq` (default: now); null when no decision is stored. */
  explain(idx: number, atSeq?: number): Explanation | null {
    const r = this.s.residents[idx];
    if (!r) return null;
    if (this.pending.length && !this.stopped) this.flush();
    const e = this.store.latestDecision(this.worldId, residentId(idx), atSeq ?? this.s.seq);
    return e && e.type === 'resident.decided' ? explain(e, this.town, r.role) : null;
  }
}
