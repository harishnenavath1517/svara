import { db } from "./client.js";

/**
 * Versioned eval runs and their scores. Every run records the `config_hash` and
 * `git_sha` it ran under, so a metric that moved can be attributed to a specific
 * change rather than argued about (docs/EVAL_STRATEGY.md).
 */

export interface EvalRunRow {
  run_id: string;
  git_sha: string;
  config_hash: string;
  started_at: string;
  finished_at: string | null;
  golden_set_version: string;
  records_scored: number;
  notes: string | null;
}

export interface EvalScoreRow {
  run_id: string;
  lang: string;
  hop: string;
  metric: string;
  slice: string;
  value: number;
  n: number;
}

export interface EvalSampleRow {
  run_id: string;
  record_id: string;
  lang: string;
  hop: string;
  metric: string;
  value: number | null;
  expected: string | null;
  actual: string | null;
  rationale: string | null;
  error_code: string | null;
}

export async function startRun(
  run: Omit<EvalRunRow, "finished_at" | "records_scored">,
): Promise<void> {
  await db().query(
    `INSERT INTO eval_runs (run_id, git_sha, config_hash, started_at, golden_set_version, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [run.run_id, run.git_sha, run.config_hash, run.started_at, run.golden_set_version, run.notes],
  );
}

/**
 * `records_scored` is written here and nowhere else. A run that scored nothing
 * stays at 0 and is visibly hollow rather than quietly green.
 */
export async function finishRun(runId: string, recordsScored: number): Promise<void> {
  await db().query(
    `UPDATE eval_runs SET finished_at = now(), records_scored = $2 WHERE run_id = $1`,
    [runId, recordsScored],
  );
}

export async function insertScores(scores: EvalScoreRow[]): Promise<void> {
  if (scores.length === 0) return;
  // One multi-row statement: a run writes a few hundred scores and a round trip
  // each would dominate the runner's wall time.
  const values: unknown[] = [];
  const tuples = scores.map((s, i) => {
    const o = i * 7;
    values.push(s.run_id, s.lang, s.hop, s.metric, s.slice, s.value, s.n);
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
  });
  await db().query(
    `INSERT INTO eval_scores (run_id, lang, hop, metric, slice, value, n)
     VALUES ${tuples.join(",")}
     ON CONFLICT (run_id, lang, hop, metric, slice) DO UPDATE
       SET value = EXCLUDED.value, n = EXCLUDED.n`,
    values,
  );
}

export async function insertSamples(samples: EvalSampleRow[]): Promise<void> {
  if (samples.length === 0) return;
  const values: unknown[] = [];
  const tuples = samples.map((s, i) => {
    const o = i * 10;
    values.push(
      s.run_id,
      s.record_id,
      s.lang,
      s.hop,
      s.metric,
      s.value,
      s.expected,
      s.actual,
      s.rationale,
      s.error_code,
    );
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
  });
  await db().query(
    `INSERT INTO eval_samples
       (run_id, record_id, lang, hop, metric, value, expected, actual, rationale, error_code)
     VALUES ${tuples.join(",")}
     ON CONFLICT (run_id, record_id, hop, metric) DO UPDATE
       SET value = EXCLUDED.value, actual = EXCLUDED.actual, rationale = EXCLUDED.rationale`,
    values,
  );
}

export async function latestRun(): Promise<EvalRunRow | null> {
  const { rows } = await db().query<EvalRunRow>(
    // A run that scored nothing is not a run you can diff against.
    `SELECT * FROM eval_runs WHERE records_scored > 0 ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function getRun(runId: string): Promise<EvalRunRow | null> {
  const { rows } = await db().query<EvalRunRow>(`SELECT * FROM eval_runs WHERE run_id = $1`, [
    runId,
  ]);
  return rows[0] ?? null;
}

export async function scoresFor(runId: string): Promise<EvalScoreRow[]> {
  const { rows } = await db().query<EvalScoreRow>(
    `SELECT * FROM eval_scores WHERE run_id = $1 ORDER BY hop, lang, metric, slice`,
    [runId],
  );
  return rows;
}

export interface ScoreDelta {
  lang: string;
  hop: string;
  metric: string;
  slice: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

/**
 * The deliverable. A FULL OUTER JOIN, deliberately: a metric that exists in only
 * one of the two runs is itself the finding — a scorer was added, or a language
 * stopped being scored and nobody noticed.
 */
export async function diffRuns(baseRunId: string, headRunId: string): Promise<ScoreDelta[]> {
  const { rows } = await db().query<ScoreDelta>(
    `SELECT
       COALESCE(a.lang, b.lang)     AS lang,
       COALESCE(a.hop, b.hop)       AS hop,
       COALESCE(a.metric, b.metric) AS metric,
       COALESCE(a.slice, b.slice)   AS slice,
       a.value AS before,
       b.value AS after,
       b.value - a.value AS delta
     FROM (SELECT * FROM eval_scores WHERE run_id = $1) a
     FULL OUTER JOIN (SELECT * FROM eval_scores WHERE run_id = $2) b
       ON a.lang = b.lang AND a.hop = b.hop AND a.metric = b.metric AND a.slice = b.slice
     ORDER BY 2, 1, 3, 4`,
    [baseRunId, headRunId],
  );
  return rows;
}
