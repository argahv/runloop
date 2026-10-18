/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    run_id        TEXT PRIMARY KEY,
    mission_id    TEXT NOT NULL,
    world_id      TEXT NOT NULL,
    title         TEXT NOT NULL,
    adapter_label TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'stopped', 'interrupted')),
    paused        INTEGER NOT NULL DEFAULT 0,
    manifest_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    ended_at      TEXT,
    last_sequence INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE events (
    run_id          TEXT NOT NULL REFERENCES runs (run_id),
    sequence        INTEGER NOT NULL,
    event_id        TEXT NOT NULL UNIQUE,
    type            TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    actor_id        TEXT,
    task_id         TEXT,
    parent_event_id TEXT,
    visibility      TEXT NOT NULL,
    envelope_json   TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
  ) WITHOUT ROWID;

  -- Artifact ids (art-N) are unique per run. Bytes live at artifacts/<run_id>/<artifact_id>.
  CREATE TABLE artifacts (
    run_id      TEXT NOT NULL REFERENCES runs (run_id),
    artifact_id TEXT NOT NULL,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    media_type  TEXT NOT NULL,
    byte_size   INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (run_id, artifact_id)
  ) WITHOUT ROWID;
  `,
  // 1: traced runs (Claude Code tracer) and idempotent hook ingest.
  `
  ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'executed';
  ALTER TABLE runs ADD COLUMN source_kind TEXT;
  ALTER TABLE runs ADD COLUMN external_session_id TEXT;
  ALTER TABLE runs ADD COLUMN segment INTEGER;
  ALTER TABLE runs ADD COLUMN project_label TEXT;
  ALTER TABLE runs ADD COLUMN last_event_at TEXT;
  CREATE INDEX runs_by_external_session ON runs (source_kind, external_session_id, segment);

  -- One row per accepted hook delivery, written in the same transaction as its events.
  CREATE TABLE trace_ingest (
    session_id  TEXT NOT NULL,
    ingest_key  TEXT NOT NULL,
    run_id      TEXT REFERENCES runs (run_id),
    hook_event  TEXT NOT NULL,
    observed_at TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY (session_id, ingest_key)
  ) WITHOUT ROWID;
  `,
  // 2: baselines (Milestone C). A pinned run is a baseline to compare others against.
  `
  ALTER TABLE runs ADD COLUMN pinned_at TEXT;
  `,
  // 3: the world (plan §4.2). One row per world; its event log and checkpoints.
  // town_json is the town as created, and wins over the file on disk.
  `
  CREATE TABLE worlds (
    world_id        TEXT PRIMARY KEY,
    town_id         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    town_json       TEXT NOT NULL,
    seed            INTEGER NOT NULL,
    sim_version     INTEGER NOT NULL,
    tick            INTEGER NOT NULL,
    last_seq        INTEGER NOT NULL,
    speed           INTEGER NOT NULL CHECK (speed IN (0, 1, 4, 16)),
    prev_speed      INTEGER NOT NULL CHECK (prev_speed IN (1, 4, 16)),
    created_at      TEXT NOT NULL,
    host_stopped_at TEXT
  );

  -- body is the WorldEvent JSON. ambient = movement and decisions (kept 3 sim days).
  CREATE TABLE world_events (
    world_id TEXT NOT NULL REFERENCES worlds (world_id),
    seq      INTEGER NOT NULL,
    tick     INTEGER NOT NULL,
    type     TEXT NOT NULL,
    prov     TEXT NOT NULL CHECK (prov IN ('simulation', 'user', 'external-agent', 'system', 'inferred')),
    actor    TEXT,
    cmd_id   TEXT,
    ambient  INTEGER NOT NULL CHECK (ambient IN (0, 1)),
    body     TEXT NOT NULL,
    PRIMARY KEY (world_id, seq)
  ) WITHOUT ROWID;
  -- A command id is applied (or rejected) once.
  CREATE UNIQUE INDEX world_cmd_once ON world_events (world_id, cmd_id) WHERE cmd_id IS NOT NULL;
  CREATE INDEX world_events_by_actor ON world_events (world_id, actor, seq);

  CREATE TABLE world_checkpoints (
    world_id    TEXT NOT NULL REFERENCES worlds (world_id),
    seq         INTEGER NOT NULL,
    tick        INTEGER NOT NULL,
    sim_version INTEGER NOT NULL,
    state_hash  TEXT NOT NULL,
    state_gz    BLOB NOT NULL,
    PRIMARY KEY (world_id, seq)
  ) WITHOUT ROWID;
  `,
  // 4: real agents (plan §4.2–4.4). Absolute paths live only in workspace_roots,
  // which only agents/local-roots.ts reads; nothing else stores or returns them (P8).
  `
  CREATE TABLE agents (
    agent_id     TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    hue          TEXT NOT NULL,
    org_id       TEXT NOT NULL,
    lot_id       TEXT UNIQUE,
    housed       INTEGER NOT NULL DEFAULT 0 CHECK (housed IN (0, 1)),
    created_at   TEXT NOT NULL
  );

  CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL UNIQUE REFERENCES agents (agent_id),
    label        TEXT NOT NULL,
    path_hint    TEXT NOT NULL
  );

  CREATE TABLE workspace_roots (
    workspace_id  TEXT NOT NULL REFERENCES workspaces (workspace_id),
    root_realpath TEXT NOT NULL UNIQUE,
    PRIMARY KEY (workspace_id, root_realpath)
  ) WITHOUT ROWID;

  CREATE TABLE agent_connections (
    agent_id         TEXT PRIMARY KEY REFERENCES agents (agent_id),
    first_event_at   TEXT,
    last_envelope_at TEXT,
    dispatch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_enabled IN (0, 1))
  );

  -- Fixed per session id; continuation segments inherit it.
  CREATE TABLE session_bindings (
    session_id TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL REFERENCES agents (agent_id),
    method     TEXT NOT NULL CHECK (method IN ('dispatch', 'path', 'claimed')),
    bound_at   TEXT NOT NULL
  );
  CREATE INDEX session_bindings_by_agent ON session_bindings (agent_id);

  CREATE TABLE org_policies (
    org_id        TEXT PRIMARY KEY,
    dispatch_json TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );

  -- task_redacted is stored redacted; cost_usd is as reported by Claude Code.
  CREATE TABLE dispatches (
    dispatch_id        TEXT PRIMARY KEY,
    agent_id           TEXT NOT NULL REFERENCES agents (agent_id),
    session_id         TEXT NOT NULL UNIQUE,
    argv_template_json TEXT NOT NULL,
    task_redacted      TEXT NOT NULL,
    status             TEXT NOT NULL,
    pid                INTEGER,
    exit_code          INTEGER,
    cost_usd           REAL,
    outcome            TEXT,
    created_at         TEXT NOT NULL,
    ended_at           TEXT
  );
  CREATE INDEX dispatches_by_agent ON dispatches (agent_id);
  `,
];
