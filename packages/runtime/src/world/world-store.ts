/**
 * The world's tables (MIGRATIONS[3], plan §4.2): one row per world, its event
 * log and its checkpoints. Only the world host writes them. Event bodies are
 * the WorldEvent JSON; checkpoints are gzipped state JSON with its hash.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { isAmbientWorldEvent, type WorldEvent, type WorldProvenance, type WorldSpeed } from '@runloop-world/events';
import type { SimState } from '@runloop-world/sim';
import { tx, type Db } from '../store/db';

export interface WorldRow {
  worldId: string;
  townId: string;
  contentHash: string;
  /** `{town, interiors}` as created; wins over the files on disk. */
  townJson: string;
  seed: number;
  simVersion: number;
  /** The host's tick (it can be ahead of the last event's tick). */
  tick: number;
  lastSeq: number;
  speed: WorldSpeed;
  prevSpeed: Exclude<WorldSpeed, 0>;
  createdAt: string;
  /** When the host last persisted (its stop time after a clean stop). */
  hostStoppedAt: string | null;
}

interface RawWorldRow {
  world_id: string;
  town_id: string;
  content_hash: string;
  town_json: string;
  seed: number;
  sim_version: number;
  tick: number;
  last_seq: number;
  speed: number;
  prev_speed: number;
  created_at: string;
  host_stopped_at: string | null;
}

export interface CheckpointRecord {
  seq: number;
  tick: number;
  simVersion: number;
  stateHash: string;
  state: SimState;
}

export interface EventQuery {
  after: number;
  limit: number;
  actor?: string;
  type?: string;
  prov?: WorldProvenance;
}

const toRow = (r: RawWorldRow): WorldRow => ({
  worldId: r.world_id,
  townId: r.town_id,
  contentHash: r.content_hash,
  townJson: r.town_json,
  seed: r.seed,
  simVersion: r.sim_version,
  tick: r.tick,
  lastSeq: r.last_seq,
  speed: r.speed as WorldSpeed,
  prevSpeed: r.prev_speed as Exclude<WorldSpeed, 0>,
  createdAt: r.created_at,
  hostStoppedAt: r.host_stopped_at,
});

const parseBody = (r: { body: string }) => JSON.parse(r.body) as WorldEvent;

export class WorldStore {
  constructor(readonly db: Db) {}

  /** The world `worldId`, or (without an id) the most recently created one. */
  loadWorld(worldId?: string): WorldRow | null {
    const row = (
      worldId
        ? this.db.prepare('SELECT * FROM worlds WHERE world_id = ?').get(worldId)
        : this.db.prepare('SELECT * FROM worlds ORDER BY created_at DESC, world_id LIMIT 1').get()
    ) as RawWorldRow | undefined;
    return row ? toRow(row) : null;
  }

  createWorld(w: WorldRow): void {
    this.db
      .prepare(
        `INSERT INTO worlds (world_id, town_id, content_hash, town_json, seed, sim_version, tick, last_seq, speed, prev_speed, created_at, host_stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.worldId, w.townId, w.contentHash, w.townJson, w.seed, w.simVersion, w.tick, w.lastSeq, w.speed, w.prevSpeed, w.createdAt, w.hostStoppedAt);
  }

  /** Append events and the world's clock in one transaction (plan §4.1 persistence). */
  commit(worldId: string, events: readonly WorldEvent[], clock: { tick: number; lastSeq: number; speed: WorldSpeed; prevSpeed: number; aliveAt: string }): void {
    const insert = this.db.prepare(
      'INSERT INTO world_events (world_id, seq, tick, type, prov, actor, cmd_id, ambient, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const update = this.db.prepare('UPDATE worlds SET tick = ?, last_seq = ?, speed = ?, prev_speed = ?, host_stopped_at = ? WHERE world_id = ?');
    tx(this.db, () => {
      for (const e of events) {
        insert.run(worldId, e.seq, e.tick, e.type, e.prov, e.actor ?? null, e.cmdId ?? null, isAmbientWorldEvent(e.type) ? 1 : 0, JSON.stringify(e));
      }
      update.run(clock.tick, clock.lastSeq, clock.speed, clock.prevSpeed, clock.aliveAt, worldId);
    });
  }

  setSimVersion(worldId: string, version: number): void {
    this.db.prepare('UPDATE worlds SET sim_version = ? WHERE world_id = ?').run(version, worldId);
  }

  /** Every event after `after`, in seq order (boot fold). */
  eventsAfter(worldId: string, after: number): WorldEvent[] {
    return (this.db.prepare('SELECT body FROM world_events WHERE world_id = ? AND seq > ? ORDER BY seq').all(worldId, after) as { body: string }[]).map(parseBody);
  }

  /** A page of events, filtered (GET /api/world/events and SSE backfill). */
  events(worldId: string, q: EventQuery): WorldEvent[] {
    const where = ['world_id = ?', 'seq > ?'];
    const args: (string | number)[] = [worldId, q.after];
    if (q.actor) {
      where.push('actor = ?');
      args.push(q.actor);
    }
    if (q.type) {
      where.push('type = ?');
      args.push(q.type);
    }
    if (q.prov) {
      where.push('prov = ?');
      args.push(q.prov);
    }
    args.push(q.limit);
    return (this.db.prepare(`SELECT body FROM world_events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args) as { body: string }[]).map(parseBody);
  }

  /** The event a command id produced (its effect or rejection), if it was processed. */
  findCommand(worldId: string, cmdId: string): WorldEvent | null {
    const row = this.db.prepare('SELECT body FROM world_events WHERE world_id = ? AND cmd_id = ?').get(worldId, cmdId) as { body: string } | undefined;
    return row ? parseBody(row) : null;
  }

  /** A resident's latest `resident.decided` at or before `atSeq`. */
  latestDecision(worldId: string, actor: string, atSeq: number): WorldEvent | null {
    const row = this.db
      .prepare("SELECT body FROM world_events WHERE world_id = ? AND actor = ? AND type = 'resident.decided' AND seq <= ? ORDER BY seq DESC LIMIT 1")
      .get(worldId, actor, atSeq) as { body: string } | undefined;
    return row ? parseBody(row) : null;
  }

  /** The oldest seq still stored (ambient events are pruned after 3 sim days). */
  firstSeq(worldId: string): number {
    const row = this.db.prepare('SELECT MIN(seq) AS s FROM world_events WHERE world_id = ?').get(worldId) as { s: number | null };
    return row.s ?? 0;
  }

  writeCheckpoint(worldId: string, cp: Omit<CheckpointRecord, 'state'> & { state: SimState }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO world_checkpoints (world_id, seq, tick, sim_version, state_hash, state_gz) VALUES (?, ?, ?, ?, ?, ?)')
      .run(worldId, cp.seq, cp.tick, cp.simVersion, cp.stateHash, gzipSync(JSON.stringify(cp.state)));
  }

  latestCheckpoint(worldId: string): CheckpointRecord | null {
    const row = this.db
      .prepare('SELECT seq, tick, sim_version, state_hash, state_gz FROM world_checkpoints WHERE world_id = ? ORDER BY seq DESC LIMIT 1')
      .get(worldId) as { seq: number; tick: number; sim_version: number; state_hash: string; state_gz: Uint8Array } | undefined;
    if (!row) return null;
    return {
      seq: row.seq,
      tick: row.tick,
      simVersion: row.sim_version,
      stateHash: row.state_hash,
      state: JSON.parse(gunzipSync(row.state_gz).toString('utf8')) as SimState,
    };
  }

  checkpointSeqs(worldId: string): { seq: number; tick: number }[] {
    return this.db.prepare('SELECT seq, tick FROM world_checkpoints WHERE world_id = ? ORDER BY seq').all(worldId) as { seq: number; tick: number }[];
  }

  /**
   * Retention (plan §4.1): keep the latest `latest` checkpoints plus the last
   * one of each of the most recent `days` sim days; drop ambient events older
   * than `ambientTicks` that the latest checkpoint already covers.
   */
  prune(worldId: string, opts: { tick: number; latest: number; days: number; ambientTicks: number }): void {
    const cps = this.checkpointSeqs(worldId);
    const keep = new Set(cps.slice(-opts.latest).map((c) => c.seq));
    const today = Math.floor(opts.tick / 1440);
    const lastOfDay = new Map<number, number>();
    for (const c of cps) {
      const day = Math.floor(c.tick / 1440);
      if (today - day < opts.days) lastOfDay.set(day, c.seq);
    }
    for (const seq of lastOfDay.values()) keep.add(seq);
    const drop = cps.filter((c) => !keep.has(c.seq));
    const latestSeq = cps.at(-1)?.seq ?? 0;
    tx(this.db, () => {
      const del = this.db.prepare('DELETE FROM world_checkpoints WHERE world_id = ? AND seq = ?');
      for (const c of drop) del.run(worldId, c.seq);
      this.db
        .prepare('DELETE FROM world_events WHERE world_id = ? AND ambient = 1 AND tick < ? AND seq <= ?')
        .run(worldId, opts.tick - opts.ambientTicks, latestSeq);
    });
  }
}
