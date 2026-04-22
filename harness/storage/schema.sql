-- Benchburner SQLite schema. SPEC §4.
-- One database per run, at `results/<run_id>/state.db`.
-- All statements are idempotent so opening an existing DB is safe.

CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  orchestrator_model  TEXT NOT NULL,
  orchestrator_config TEXT NOT NULL,            -- JSON
  subagent_roster     TEXT NOT NULL,            -- JSON array of model ids
  seed                INTEGER NOT NULL,
  bitburner_commit    TEXT NOT NULL,
  start_time          TEXT NOT NULL,            -- ISO-8601
  end_time            TEXT,                     -- ISO-8601, null until finalized
  final_money         INTEGER,                  -- null until finalized
  final_stats         TEXT,                     -- JSON, null until finalized
  status              TEXT NOT NULL,            -- in_progress | completed | failed
  failure_reason      TEXT,                     -- null unless status=failed
  attribution_mode    TEXT NOT NULL             -- public | anonymous
);

CREATE TABLE IF NOT EXISTS delegations (
  delegation_id   TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  cycle_number    INTEGER NOT NULL,
  action          TEXT NOT NULL,                -- JSON orchestrator action
  subagent_id     TEXT NOT NULL,
  instruction_id  TEXT NOT NULL,
  result          TEXT,                         -- JSON, null while pending
  timestamp       TEXT NOT NULL                 -- ISO-8601
);

CREATE INDEX IF NOT EXISTS idx_delegations_run_cycle
  ON delegations(run_id, cycle_number);

CREATE TABLE IF NOT EXISTS scripts (
  script_id         TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(run_id),
  subagent_id       TEXT NOT NULL,
  instruction_id    TEXT NOT NULL,
  code              TEXT NOT NULL,
  executed_in_game  INTEGER NOT NULL DEFAULT 0, -- SQLite boolean 0|1
  execution_result  TEXT,                       -- JSON, null until run
  tokens_used       INTEGER NOT NULL,
  timestamp         TEXT NOT NULL               -- ISO-8601
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id  TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  hour         INTEGER NOT NULL,                -- 0..24
  game_state   TEXT NOT NULL,                   -- JSON
  timestamp    TEXT NOT NULL                    -- ISO-8601
);

CREATE INDEX IF NOT EXISTS idx_snapshots_run_hour
  ON snapshots(run_id, hour);
