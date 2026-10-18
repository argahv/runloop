import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/store/db';
import { MIGRATIONS } from '../src/store/migrations';
import { tempDir } from './helpers';

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

function insertWorld(db: DatabaseSync, id = 'w1') {
  db.prepare(
    `INSERT INTO worlds (world_id, town_id, content_hash, town_json, seed, sim_version, tick, last_seq, speed, prev_speed, created_at)
     VALUES (?, 'runloop-commons', '0123456789abcdef', '{}', 42, 1, 480, 0, 1, 1, '2026-10-18T08:00:00.000Z')`,
  ).run(id);
}

const insertEvent = (db: DatabaseSync, seq: number, prov: string, cmdId: string | null = null) =>
  db
    .prepare(`INSERT INTO world_events (world_id, seq, tick, type, prov, actor, cmd_id, ambient, body) VALUES ('w1', ?, 480, 't', ?, NULL, ?, 0, '{}')`)
    .run(seq, prov, cmdId);

describe('world and agent migrations (3 and 4)', () => {
  it('reserves the plan’s indexes: 3 = world tables, 4 = agent tables', () => {
    expect(MIGRATIONS).toHaveLength(5);
    expect(MIGRATIONS[3]).toMatch(/CREATE TABLE worlds/);
    expect(MIGRATIONS[4]).toMatch(/CREATE TABLE agents/);
  });

  it('creates every table on a fresh database', () => {
    const db = openDb(':memory:');
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'worlds',
        'world_events',
        'world_checkpoints',
        'agents',
        'workspaces',
        'workspace_roots',
        'agent_connections',
        'session_bindings',
        'org_policies',
        'audit_log',
        'dispatches',
      ]),
    );
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    db.close();
  });

  it('upgrades a database written at schema 3 and keeps its runs', () => {
    const file = path.join(tempDir('migrations'), 'runloop.db');
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
    old.exec('PRAGMA user_version = 3');
    old.prepare(
      `INSERT INTO runs (run_id, mission_id, world_id, title, adapter_label, status, manifest_json, created_at) VALUES ('r-old', 'm', 'research-campus', 'Old run', 'x', 'succeeded', '{}', '2026-10-01T00:00:00.000Z')`,
    ).run();
    old.close();
    const db = openDb(file);
    expect(tables(db)).toContain('world_events');
    expect(db.prepare("SELECT title FROM runs WHERE run_id = 'r-old'").get()).toEqual({ title: 'Old run' });
    migrate(db); // idempotent
    db.close();
  });

  it('accepts only the five provenances (P1) and each command id once', () => {
    const db = openDb(':memory:');
    insertWorld(db);
    for (const [i, prov] of ['simulation', 'user', 'external-agent', 'system', 'inferred'].entries()) insertEvent(db, i + 1, prov);
    expect(() => insertEvent(db, 6, 'llm')).toThrow(/CHECK/);
    insertEvent(db, 7, 'user', 'cmd-1');
    expect(() => insertEvent(db, 8, 'user', 'cmd-1')).toThrow(/UNIQUE/);
    insertEvent(db, 9, 'simulation', null);
    insertEvent(db, 10, 'simulation', null);
    expect(() => insertEvent(db, 10, 'user')).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });

  it('keeps world speeds to 0|1|4|16 and events attached to a world', () => {
    const db = openDb(':memory:');
    expect(() =>
      db
        .prepare(
          `INSERT INTO worlds (world_id, town_id, content_hash, town_json, seed, sim_version, tick, last_seq, speed, prev_speed, created_at)
           VALUES ('w2', 't', 'h', '{}', 1, 1, 0, 0, 5, 1, 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() => insertEvent(db, 1, 'user')).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('binds a workspace root to one workspace, an agent to one lot, and a session to one agent', () => {
    const db = openDb(':memory:');
    const agent = (id: string, lot: string | null) =>
      db.prepare(`INSERT INTO agents (agent_id, display_name, hue, org_id, lot_id, created_at) VALUES (?, 'A', '#5aa9f5', 'org_home', ?, 'now')`).run(id, lot);
    agent('agt_a', 'lot_agent_1');
    expect(() => agent('agt_b', 'lot_agent_1')).toThrow(/UNIQUE/);
    agent('agt_c', null);
    agent('agt_d', null);
    db.prepare(`INSERT INTO workspaces (workspace_id, agent_id, label, path_hint) VALUES ('wsp_a', 'agt_a', 'repo', '…/code/repo')`).run();
    const root = (ws: string, p: string) => db.prepare('INSERT INTO workspace_roots (workspace_id, root_realpath) VALUES (?, ?)').run(ws, p);
    root('wsp_a', '/tmp/a');
    expect(() => root('wsp_a', '/tmp/a')).toThrow(/UNIQUE|PRIMARY/);
    db.prepare(`INSERT INTO session_bindings (session_id, agent_id, method, bound_at) VALUES ('s1', 'agt_a', 'path', 'now')`).run();
    expect(() => db.prepare(`INSERT INTO session_bindings (session_id, agent_id, method, bound_at) VALUES ('s2', 'agt_a', 'pairing', 'now')`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO session_bindings (session_id, agent_id, method, bound_at) VALUES ('s3', 'agt_zz', 'path', 'now')`).run()).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
