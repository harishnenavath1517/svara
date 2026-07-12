import type { Hop, TraceEvent, TurnEvent } from "@svara/shared";
import { db } from "./client.js";

/**
 * The trace projection: `svara.traces` / `svara.turns` flattened into rows.
 *
 * Both writers upsert on the event's natural key, so the sink can be replayed
 * from offset 0 without duplicating anything. That matters more than it sounds:
 * it means a schema change is not a data-loss event — drop the table, re-run the
 * migration, replay the topic.
 */

export async function insertTrace(event: TraceEvent): Promise<void> {
  await db().query(
    `INSERT INTO traces (
       trace_id, session_id, turn_index, hop, lang, model, mode,
       input_ref, output_ref, text_in, text_out, rag_context_ids,
       latency_ms, ttfb_ms, config_hash, git_sha, ts, error_code, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (trace_id, hop) DO UPDATE SET
       lang = EXCLUDED.lang,
       text_out = EXCLUDED.text_out,
       input_ref = EXCLUDED.input_ref,
       output_ref = EXCLUDED.output_ref,
       latency_ms = EXCLUDED.latency_ms,
       ttfb_ms = EXCLUDED.ttfb_ms,
       error_code = EXCLUDED.error_code,
       error_message = EXCLUDED.error_message`,
    [
      event.trace_id,
      event.session_id,
      event.turn_index,
      event.hop,
      event.lang,
      event.model,
      event.mode,
      event.input_ref,
      event.output_ref,
      event.text_in,
      event.text_out,
      event.rag_context_ids,
      event.latency_ms,
      event.ttfb_ms,
      event.config_hash,
      event.git_sha,
      event.ts,
      event.error?.code ?? null,
      event.error?.message ?? null,
    ],
  );
}

export async function insertTurn(event: TurnEvent): Promise<void> {
  await db().query(
    `INSERT INTO turns (
       trace_id, session_id, turn_index, lang, total_latency_ms, first_audio_ms, ok
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (trace_id) DO UPDATE SET
       total_latency_ms = EXCLUDED.total_latency_ms,
       first_audio_ms = EXCLUDED.first_audio_ms,
       ok = EXCLUDED.ok`,
    [
      event.trace_id,
      event.session_id,
      event.turn_index,
      event.lang,
      event.total_latency_ms,
      event.first_audio_ms,
      event.ok,
    ],
  );
}

export interface TraceRow {
  trace_id: string;
  session_id: string;
  turn_index: number;
  hop: Hop;
  lang: string;
  model: string;
  mode: string | null;
  input_ref: string | null;
  output_ref: string | null;
  text_in: string | null;
  text_out: string | null;
  latency_ms: number;
  ttfb_ms: number | null;
  config_hash: string;
  git_sha: string;
  ts: string;
  error_code: string | null;
  error_message: string | null;
}

export interface TurnRow {
  trace_id: string;
  session_id: string;
  turn_index: number;
  lang: string;
  total_latency_ms: number;
  first_audio_ms: number | null;
  ok: boolean;
  ts: string;
}

/**
 * The turn list behind the trace drill-down. Turns are listed, not hops, because
 * a turn is the unit a human debugs: "that call where it answered in the wrong
 * language" is a turn, and its three hops are the explanation.
 *
 * Failed and cancelled turns are NOT filtered out. They are the most informative
 * rows in the table (docs/EVAL_STRATEGY.md §6) and the dashboard's job is to make
 * them easy to find, not to keep the list looking green.
 */
export async function listTurns(limit = 50): Promise<TurnRow[]> {
  const { rows } = await db().query<TurnRow>(
    `SELECT * FROM turns ORDER BY ts DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Every hop of one turn, in pipeline order, with the refs the player resolves. */
export async function traceDetail(
  traceId: string,
): Promise<{ turn: TurnRow | null; hops: TraceRow[] }> {
  const [turn, hops] = await Promise.all([
    db().query<TurnRow>(`SELECT * FROM turns WHERE trace_id = $1`, [traceId]),
    db().query<TraceRow>(
      `SELECT * FROM traces WHERE trace_id = $1
       ORDER BY array_position(ARRAY['stt','llm','tts'], hop)`,
      [traceId],
    ),
  ]);
  return { turn: turn.rows[0] ?? null, hops: hops.rows };
}

export interface HopLatency {
  hop: Hop;
  lang: string;
  n: number;
  ttfb_p50: number | null;
  ttfb_p95: number | null;
  ttfb_p99: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
  latency_p99: number | null;
}

/**
 * Latency percentiles over *live* traffic, per hop per language.
 *
 * Read the STT row with care. A live STT hop's wall clock spans the caller
 * actually speaking — Saaras emits nothing until the VAD endpoint triggers a
 * flush — so `latency_ms` there is roughly utterance duration, not model
 * latency, and the 5-6s we measured in Phase 1 is a person talking, not a slow
 * model. The offline eval times STT from audio-feed-start instead, which is the
 * number you can actually compare across runs. Only failed hops are excluded;
 * cancelled turns stay in, because a rising cancel rate is the signal
 * (docs/EVAL_STRATEGY.md §6).
 */
export async function hopLatencies(configHash?: string): Promise<HopLatency[]> {
  const { rows } = await db().query<HopLatency>(
    `SELECT hop, lang, COUNT(*)::int AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY ttfb_ms)     AS ttfb_p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfb_ms)     AS ttfb_p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY ttfb_ms)     AS ttfb_p99,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)  AS latency_p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)  AS latency_p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)  AS latency_p99
     FROM traces
     WHERE error_code IS NULL
       AND ($1::text IS NULL OR config_hash = $1)
     GROUP BY hop, lang
     ORDER BY hop, lang`,
    [configHash ?? null],
  );
  return rows;
}

export interface ErrorRate {
  hop: Hop;
  lang: string;
  error_code: string;
  n: number;
}

/**
 * Failure and cancellation counts. A rising `cancelled` rate means callers are
 * talking over the agent — it is too slow or too verbose — and no WER will ever
 * show you that. A rising `empty_transcript` rate means VAD is firing on noise.
 */
export async function errorRates(configHash?: string): Promise<ErrorRate[]> {
  const { rows } = await db().query<ErrorRate>(
    `SELECT hop, lang, error_code, COUNT(*)::int AS n
     FROM traces
     WHERE error_code IS NOT NULL
       AND ($1::text IS NULL OR config_hash = $1)
     GROUP BY hop, lang, error_code
     ORDER BY n DESC`,
    [configHash ?? null],
  );
  return rows;
}
