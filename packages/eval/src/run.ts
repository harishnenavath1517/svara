import { randomUUID } from "node:crypto";
import { createConfig } from "@svara/sarvam";
import { CONFIG_HASH, GIT_SHA } from "@svara/orchestrator";
import type { Hop, LanguageCode } from "@svara/shared";
import {
  finishRun,
  insertSamples,
  insertScores,
  startRun,
  type EvalSampleRow,
  type EvalScoreRow,
} from "@svara/db";
import { GOLDEN_SET_VERSION, loadGolden, type GoldenRecord, type Tag } from "./golden.js";
import {
  addToConfusion,
  classifyIntent,
  emptyConfusion,
  INTENT_PROMPT_VERSION,
  type ConfusionMatrix,
} from "./intent.js";
import { JUDGE_RUBRIC_VERSION, judgeTranslation, type JudgeVerdict } from "./judge.js";
import { pearson, spearman } from "./metrics/agreement.js";
import { chrf } from "./metrics/chrf.js";
import { percentiles } from "./metrics/latency.js";
import { NORMALIZER_VERSION } from "./metrics/normalize.js";
import { aggregateErrorRate, characterErrorRate, wordErrorRate } from "./metrics/wer.js";
import { replay, type ReplayResult } from "./pipeline.js";

/**
 * The eval run: replay the golden set, score every hop per language, persist a
 * versioned run you can diff.
 *
 * The run is only ever "green" if it actually scored something. `records_scored`
 * is written from the count of records that produced a score, and the CLI exits
 * non-zero when that count is zero — a green eval run that scored nothing is
 * strictly worse than no eval run, because it is a lie you will act on.
 */

export interface RunOptions {
  languages: LanguageCode[];
  hops: Hop[] | null;
  notes: string | null;
  /** Skip the judge (it is the slow, expensive part) — for a quick latency-only pass. */
  skipJudge: boolean;
}

export interface RunSummary {
  runId: string;
  recordsScored: number;
  scores: EvalScoreRow[];
  confusion: Map<LanguageCode, ConfusionMatrix>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Paces the replay loop. Hammering Saaras returns empty transcripts, not errors. */
const RECORD_PACING_MS = 400;

export async function runEval(opts: RunOptions): Promise<RunSummary> {
  const runId = randomUUID();
  const config = createConfig();
  const controller = new AbortController();

  // The scorers are as capable of moving a number as the models are. A normalizer
  // that starts stripping a character, a reworded judge rubric, a changed intent
  // prompt — each shifts every score in the table while every model stays
  // identical, which is the most confusing possible way to see a "regression".
  // Stamping their versions on the run means two runs that scored differently can
  // never both claim to have been the same configuration.
  const scorerVersions =
    `normalizer=v${NORMALIZER_VERSION} judge=v${JUDGE_RUBRIC_VERSION} intent=v${INTENT_PROMPT_VERSION}`;

  await startRun({
    run_id: runId,
    git_sha: GIT_SHA,
    // Shared with the runtime plane, so an eval score and a live trace can be
    // attributed to the same exact configuration.
    config_hash: CONFIG_HASH,
    started_at: new Date().toISOString(),
    golden_set_version: GOLDEN_SET_VERSION,
    notes: opts.notes === null ? scorerVersions : `${opts.notes} | ${scorerVersions}`,
  });

  const scores: EvalScoreRow[] = [];
  const samples: EvalSampleRow[] = [];
  const confusion = new Map<LanguageCode, ConfusionMatrix>();
  let recordsScored = 0;

  for (const lang of opts.languages) {
    const records = await loadGolden(lang);
    if (records.length === 0) {
      console.warn(`[eval] ${lang}: no usable golden records — skipping`);
      continue;
    }

    console.log(`\n[eval] ${lang}: replaying ${records.length} records`);
    const results: ReplayResult[] = [];
    const verdicts = new Map<string, JudgeVerdict>();
    const langConfusion = emptyConfusion();

    for (const [index, record] of records.entries()) {
      if (index > 0) await sleep(RECORD_PACING_MS);

      const result = await replay(record, config, controller.signal);
      results.push(result);
      recordsScored += 1;

      // Intent is classified from the transcript STT actually produced, so the
      // number reflects the accuracy the live system would really have.
      const intent = await classifyIntent(result.stt.value, config, controller.signal);
      addToConfusion(langConfusion, record.expected_intent, intent.predicted);

      if (!opts.skipJudge) {
        const verdict = await judgeTranslation(
          record.reference_translation,
          result.translation.value,
          config,
          controller.signal,
        );
        verdicts.set(record.id, verdict);
      }

      const sttWer = wordErrorRate(record.expected_transcript, result.stt.value).rate;
      process.stdout.write(
        `  ${record.id}  wer ${sttWer.toFixed(2)}  ` +
          `intent ${intent.predicted === record.expected_intent ? "ok " : "MISS"}  ` +
          `ttfb stt ${fmt(result.stt.ttfb_ms)} llm ${fmt(result.reply.ttfb_ms)}\n`,
      );

      samples.push(...sampleRows(runId, record, result, verdicts.get(record.id)));
    }

    confusion.set(lang, langConfusion);
    scores.push(...scoreLanguage(runId, lang, records, results, verdicts, langConfusion));
  }

  await insertScores(scores);
  await insertSamples(samples);
  await finishRun(runId, recordsScored);

  return { runId, recordsScored, scores, confusion };
}

function fmt(ms: number | null): string {
  return ms === null ? " -- " : `${String(ms).padStart(4)}`;
}

/** Every metric, for one language: overall, then broken out by tag. */
function scoreLanguage(
  runId: string,
  lang: LanguageCode,
  records: GoldenRecord[],
  results: ReplayResult[],
  verdicts: Map<string, JudgeVerdict>,
  confusion: ConfusionMatrix,
): EvalScoreRow[] {
  const rows: EvalScoreRow[] = [];
  const add = (hop: Hop, metric: string, slice: string, value: number, n: number): void => {
    if (!Number.isFinite(value)) return;
    rows.push({ run_id: runId, lang, hop, metric, slice, value, n });
  };

  // --- STT ---------------------------------------------------------------
  // Scored over the whole set, then per tag. The `code-mixed` slice is the cell
  // that matters: it is where ASR is weakest and where Sarvam claims to win.
  for (const slice of ["all", ...tagsPresent(records)] as const) {
    const subset = results.filter((r) => inSlice(r.record, slice));
    if (subset.length === 0) continue;

    const wers = subset.map((r) => wordErrorRate(r.record.expected_transcript, r.stt.value));
    const cers = subset.map((r) => characterErrorRate(r.record.expected_transcript, r.stt.value));
    add("stt", "wer", slice, aggregateErrorRate(wers).rate, subset.length);
    add("stt", "cer", slice, aggregateErrorRate(cers).rate, subset.length);

    // The script-invariant cross-check. On code-mixed records this diverges hard
    // from `wer` above, and the divergence is the finding, not a bug: Saaras hears
    // "Aadhaar card" correctly and writes it in Devanagari, which naive WER scores
    // as a substitution. Reporting only one of these two numbers misleads.
    const romanized = subset.map((r) =>
      wordErrorRate(r.record.expected_romanized, r.sttRomanized.value),
    );
    add("stt", "wer_romanized", slice, aggregateErrorRate(romanized).rate, subset.length);

    const empty = subset.filter((r) => r.stt.value.trim().length === 0).length;
    add("stt", "empty_transcript_rate", slice, empty / subset.length, subset.length);
  }

  // --- Translation: metric AND judge, plus their agreement -----------------
  const chrfScores: number[] = [];
  const judgeScores: number[] = [];
  for (const result of results) {
    const score = chrf(result.record.reference_translation, result.translation.value);
    chrfScores.push(score);
    const verdict = verdicts.get(result.record.id);
    if (verdict !== undefined && Number.isFinite(verdict.score)) judgeScores.push(verdict.score);
  }

  if (chrfScores.length > 0) {
    add("llm", "chrf", "all", mean(chrfScores), chrfScores.length);
  }
  if (judgeScores.length > 0) {
    const adequacies = [...verdicts.values()].map((v) => v.adequacy).filter(Number.isFinite);
    const fluencies = [...verdicts.values()].map((v) => v.fluency).filter(Number.isFinite);
    add("llm", "judge_adequacy", "all", mean(adequacies), adequacies.length);
    add("llm", "judge_fluency", "all", mean(fluencies), fluencies.length);

    // The judge that failed to answer is counted, not silently averaged away.
    const failed = [...verdicts.values()].filter((v) => !Number.isFinite(v.score)).length;
    add("llm", "judge_unparseable_rate", "all", failed / verdicts.size, verdicts.size);
  }

  // Only over records where BOTH numbers exist, and only where the judge parsed.
  const paired = results
    .map((r) => ({
      chrf: chrf(r.record.reference_translation, r.translation.value),
      judge: verdicts.get(r.record.id)?.score,
    }))
    .filter((p): p is { chrf: number; judge: number } => Number.isFinite(p.judge));

  if (paired.length >= 3) {
    const rho = spearman(
      paired.map((p) => p.chrf),
      paired.map((p) => p.judge),
    );
    const r = pearson(
      paired.map((p) => p.chrf),
      paired.map((p) => p.judge),
    );
    // Low agreement is a FINDING, not a failure — it means chrF and the judge
    // disagree about what "good" is on this language, and the samples where they
    // diverge are the ones worth reading.
    if (rho !== null) add("llm", "chrf_judge_spearman", "all", rho, paired.length);
    if (r !== null) add("llm", "chrf_judge_pearson", "all", r, paired.length);
  }

  // --- Intent -------------------------------------------------------------
  add("llm", "intent_accuracy", "all", confusion.accuracy, confusion.total);

  // --- TTS round-trip intelligibility --------------------------------------
  const roundTrips = results.filter(
    (r): r is ReplayResult & { roundTrip: NonNullable<ReplayResult["roundTrip"]> } =>
      r.roundTrip !== null && r.roundTrip.error === null && r.reply.value.length > 0,
  );
  if (roundTrips.length > 0) {
    const rtWers = roundTrips.map((r) => wordErrorRate(r.reply.value, r.roundTrip.value));
    add("tts", "round_trip_wer", "all", aggregateErrorRate(rtWers).rate, roundTrips.length);
  }

  // --- Latency: TTFB leads, wall time follows ------------------------------
  const hops: Array<[Hop, (r: ReplayResult) => { ttfb_ms: number | null; latency_ms: number }]> = [
    ["stt", (r) => r.stt],
    ["llm", (r) => r.reply],
    ["tts", (r) => r.roundTrip ?? { ttfb_ms: null, latency_ms: Number.NaN }],
  ];
  for (const [hop, pick] of hops) {
    const ttfb = percentiles(results.map((r) => pick(r).ttfb_ms));
    const wall = percentiles(results.map((r) => pick(r).latency_ms));
    if (ttfb.p50 !== null) {
      add(hop, "ttfb_p50", "all", ttfb.p50, ttfb.n);
      add(hop, "ttfb_p95", "all", ttfb.p95 ?? ttfb.p50, ttfb.n);
      add(hop, "ttfb_p99", "all", ttfb.p99 ?? ttfb.p50, ttfb.n);
    }
    if (wall.p50 !== null) {
      add(hop, "latency_p50", "all", wall.p50, wall.n);
      add(hop, "latency_p95", "all", wall.p95 ?? wall.p50, wall.n);
    }
  }

  // --- Failures ------------------------------------------------------------
  for (const [hop, pick] of [
    ["stt", (r: ReplayResult) => r.stt.error],
    ["llm", (r: ReplayResult) => r.reply.error],
    ["tts", (r: ReplayResult) => r.roundTrip?.error ?? null],
  ] as const) {
    const failures = results.filter((r) => pick(r) !== null).length;
    add(hop, "error_rate", "all", failures / results.length, results.length);
  }

  return rows;
}

/** Per-record detail: what the judge said, which utterance blew the WER. */
function sampleRows(
  runId: string,
  record: GoldenRecord,
  result: ReplayResult,
  verdict: JudgeVerdict | undefined,
): EvalSampleRow[] {
  const rows: EvalSampleRow[] = [
    {
      run_id: runId,
      record_id: record.id,
      lang: record.lang,
      hop: "stt",
      metric: "wer",
      value: wordErrorRate(record.expected_transcript, result.stt.value).rate,
      expected: record.expected_transcript,
      actual: result.stt.value,
      rationale: null,
      error_code: result.stt.error?.code ?? null,
    },
    {
      run_id: runId,
      record_id: record.id,
      lang: record.lang,
      hop: "llm",
      metric: "chrf",
      value: chrf(record.reference_translation, result.translation.value),
      expected: record.reference_translation,
      actual: result.translation.value,
      rationale: null,
      error_code: result.translation.error?.code ?? null,
    },
  ];

  if (verdict !== undefined) {
    rows.push({
      run_id: runId,
      record_id: record.id,
      lang: record.lang,
      hop: "llm",
      metric: "judge",
      value: Number.isFinite(verdict.score) ? verdict.score : null,
      expected: record.reference_translation,
      actual: result.translation.value,
      // The reason a number is arguable. Without it, a judge score is an oracle.
      rationale: verdict.rationale,
      error_code: Number.isFinite(verdict.score) ? null : "judge_unparseable",
    });
  }

  if (result.roundTrip !== null && result.reply.value.length > 0) {
    rows.push({
      run_id: runId,
      record_id: record.id,
      lang: record.lang,
      hop: "tts",
      metric: "round_trip_wer",
      value: wordErrorRate(result.reply.value, result.roundTrip.value).rate,
      expected: result.reply.value,
      actual: result.roundTrip.value,
      rationale: null,
      error_code: result.roundTrip.error?.code ?? null,
    });
  }

  return rows;
}

function tagsPresent(records: GoldenRecord[]): Tag[] {
  return [...new Set(records.flatMap((r) => r.tags))];
}

function inSlice(record: GoldenRecord, slice: string): boolean {
  return slice === "all" || record.tags.includes(slice as Tag);
}

function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
