-- svara eval-plane schema. Contract: docs/DATA_CONTRACTS.md — change both together.
--
-- Applied idempotently by `pnpm db:migrate` (packages/db/src/migrate.ts). This runs
-- against the `svara` database in infra/docker-compose.yml, which is a separate
-- database from the ones Temporal auto-creates for itself in the same Postgres.
--
-- Everything here is derived from `svara.traces` / `svara.turns`. The bus is the
-- source of truth; these tables are a queryable projection of it. That's why the
-- sink can be replayed from offset 0 without duplicating rows (see the ON CONFLICT
-- clauses in traces.ts) — Postgres holds no state the event stream doesn't.

CREATE TABLE IF NOT EXISTS traces (
  trace_id        UUID        NOT NULL,
  session_id      UUID        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  hop             TEXT        NOT NULL CHECK (hop IN ('stt', 'llm', 'tts')),
  lang            TEXT        NOT NULL,
  model           TEXT        NOT NULL,
  mode            TEXT,
  input_ref       TEXT,
  output_ref      TEXT,
  text_in         TEXT,
  text_out        TEXT,
  rag_context_ids TEXT[]      NOT NULL DEFAULT '{}',
  latency_ms      INTEGER     NOT NULL,
  ttfb_ms         INTEGER,
  config_hash     TEXT        NOT NULL,
  git_sha         TEXT        NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  -- One event per hop per turn (docs/DATA_CONTRACTS.md), which makes the sink
  -- naturally idempotent: a replayed partition upserts onto the same row.
  PRIMARY KEY (trace_id, hop)
);

CREATE INDEX IF NOT EXISTS traces_session_idx ON traces (session_id, turn_index);
CREATE INDEX IF NOT EXISTS traces_ts_idx      ON traces (ts DESC);
-- The dashboard's hot query: "this hop, this language, this config" — and the
-- latency percentiles are computed over exactly that slice.
CREATE INDEX IF NOT EXISTS traces_slice_idx   ON traces (hop, lang, config_hash);
-- Failed and cancelled turns are the most informative rows in the set
-- (docs/EVAL_STRATEGY.md §6), so they get their own index rather than a seq scan.
CREATE INDEX IF NOT EXISTS traces_error_idx   ON traces (error_code) WHERE error_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS turns (
  trace_id         UUID        PRIMARY KEY,
  session_id       UUID        NOT NULL,
  turn_index       INTEGER     NOT NULL,
  lang             TEXT        NOT NULL,
  total_latency_ms INTEGER     NOT NULL,
  -- Mic close -> first audio at the caller. The number the <800ms budget refers to.
  first_audio_ms   INTEGER,
  ok               BOOLEAN     NOT NULL,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id, turn_index);

CREATE TABLE IF NOT EXISTS eval_runs (
  run_id             UUID        PRIMARY KEY,
  git_sha            TEXT        NOT NULL,
  -- Identical across every hop of a run, so a metric move attributes to one exact
  -- configuration. Computed in packages/orchestrator/src/config.ts.
  config_hash        TEXT        NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  finished_at        TIMESTAMPTZ,
  golden_set_version TEXT        NOT NULL,
  -- A run that scored nothing must never look like a run that scored well.
  records_scored     INTEGER     NOT NULL DEFAULT 0,
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS eval_runs_started_idx ON eval_runs (started_at DESC);

-- Intentionally tall (one row per metric per language per hop per run) so the
-- dashboard can pivot without a schema change when a metric is added.
CREATE TABLE IF NOT EXISTS eval_scores (
  run_id UUID   NOT NULL REFERENCES eval_runs (run_id) ON DELETE CASCADE,
  lang   TEXT   NOT NULL,
  hop    TEXT   NOT NULL,
  metric TEXT   NOT NULL,
  -- Free-form: "clean" / "code-mixed" / "noisy" / "numbers", or "all". Keeps the
  -- code-mixed cell reportable separately (docs/EVAL_STRATEGY.md §1) without
  -- inventing a column per tag.
  slice  TEXT   NOT NULL DEFAULT 'all',
  value  DOUBLE PRECISION NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, lang, hop, metric, slice)
);

-- Per-record detail behind the aggregates: what the judge actually said, which
-- utterance blew the WER. Without this a regression tells you a number moved but
-- not which caller it moved for.
CREATE TABLE IF NOT EXISTS eval_samples (
  run_id       UUID  NOT NULL REFERENCES eval_runs (run_id) ON DELETE CASCADE,
  record_id    TEXT  NOT NULL,
  lang         TEXT  NOT NULL,
  hop          TEXT  NOT NULL,
  metric       TEXT  NOT NULL,
  value        DOUBLE PRECISION,
  expected     TEXT,
  actual       TEXT,
  -- The judge's reasoning, kept because a score without a rationale can't be
  -- argued with (docs/EVAL_STRATEGY.md §2).
  rationale    TEXT,
  error_code   TEXT,
  PRIMARY KEY (run_id, record_id, hop, metric)
);

CREATE INDEX IF NOT EXISTS eval_samples_run_idx ON eval_samples (run_id, lang, hop);
