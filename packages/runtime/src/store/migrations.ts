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
];
