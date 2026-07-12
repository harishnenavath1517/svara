import type { EvalRunRow, ScoreDelta } from "@svara/db";
import { isImprovement, lowerIsBetter } from "./direction.js";

/**
 * What counts as a regression, and what is just the harness talking to itself.
 *
 * A CI gate needs one number per metric: how far can this move before we fail the
 * build? Guessing that number is how you get a gate that either never fires or
 * fires constantly, and both are ignored within a week. So it was measured
 * instead.
 *
 * **The measurement.** Runs `38a3c939` (hi-IN) and `710bc192` (ta-IN) scored the
 * same golden records, at the same `config_hash`, as the combined run `58ab3e4c`.
 * Same code, same answer key, same models — every delta between them is pure
 * harness noise, with no quality change underneath it. What that showed:
 *
 * | metric              | measured run-to-run noise |
 * |---------------------|---------------------------|
 * | wer / cer / chrf    | **0.000** (both languages) |
 * | intent_accuracy     | **0.000**                  |
 * | judge_adequacy      | 0.05 – 0.10                |
 * | judge_unparseable   | 0.05 (one record of twenty)|
 * | round_trip_wer      | 0.034 – 0.041              |
 * | ttfb_p50            | 5 – 94 ms                  |
 * | ttfb_p95            | up to 142 ms               |
 * | ttfb_p99            | **up to 732 ms**           |
 * | wall latency_p95    | **up to 2.7 s** (TTS)      |
 *
 * Two conclusions, and they are not the ones you'd guess:
 *
 * 1. **The quality metrics are deterministic.** Saaras returns the same transcript
 *    for the same bytes, so WER noise is not "small", it is *zero*. A WER that
 *    moves at all moved because something changed. The thresholds below are
 *    therefore tight, and they can afford to be.
 *
 * 2. **The latency tails are not measurable at n=20.** `p99` over twenty samples
 *    is essentially the maximum, and it swung 732ms between two runs of identical
 *    code. Gating on it would fail builds at random — so it is NOT gated, and
 *    neither is wall-clock `latency_p95`. They are still reported, and the
 *    dashboard still charts them against the budget; they simply do not get a vote
 *    on whether the build goes red. The honest instrument for a tail at this
 *    sample size is the budget in LATENCY_BUDGET_MS, not a run-over-run delta.
 */

/**
 * Fail the build when a metric gets worse by MORE than this. Units are the
 * metric's own: a fraction for rates, rubric points for the judge, milliseconds
 * for the timings.
 *
 * Each is set above the measured noise floor above, with the reason stated. Every
 * one of these is a judgement call, and writing the call down is the point — a
 * threshold nobody can explain is a threshold nobody will defend when it fires.
 */
export const REGRESSION_THRESHOLDS: Readonly<Record<string, number>> = {
  // Noise 0.000. 0.02 is ~one record of twenty picking up a couple of extra
  // substitutions — below that we are arguing about a single word.
  wer: 0.02,
  cer: 0.02,
  wer_romanized: 0.02,

  // Noise 0.034–0.041, and structurally so: the round trip re-synthesizes and
  // re-transcribes, so it samples twice. Set at 2x the observed spread.
  round_trip_wer: 0.08,

  // Noise 0.000. chrF is [0,1] here, not scaled to 100 (see metrics/chrf.ts).
  chrf: 0.03,

  // Noise 0.000, but one record flipping in a 20-record set moves this by exactly
  // 0.05. One flip is a coin toss; two is a pattern. Fail past 0.05, so a single
  // record cannot redden a build.
  intent_accuracy: 0.05,

  // Noise 0.05–0.10 on a 1–5 scale. Half a rubric point is the smallest move a
  // saturated integer-valued judge can make that means anything — and on hi-IN it
  // is saturated flat at 5.0, so this gate is close to inert there. That is a
  // known limitation of the judge, not of the threshold (docs/EVAL_STRATEGY.md).
  judge_adequacy: 0.5,
  judge_fluency: 0.5,

  // Noise 0.05 = exactly one record the judge failed to answer for. An API hiccup
  // must never be able to fail a build as if it were a quality regression, so this
  // needs two. It IS gated, though: a judge that has quietly stopped parsing is a
  // scorer outage, and a scorer outage is worse than a regression — it is a
  // regression you can no longer see.
  judge_unparseable_rate: 0.1,

  // A rising empty-transcript rate means VAD is firing on noise and the agent is
  // being handed silence to answer (docs/EVAL_STRATEGY.md §6).
  empty_transcript_rate: 0.05,
  error_rate: 0.05,

  // Medians, in ms. Noise: 5–94ms (STT p50 is the loose one). 150ms is comfortably
  // above it and still well inside the 800ms end-to-end budget.
  ttfb_p50: 150,
  latency_p50: 150,

  // Noise up to 142ms. Gated, but loosely — p95 at n=20 is the 19th of twenty
  // samples and it knows it.
  ttfb_p95: 300,
};

/**
 * Metrics that are reported but deliberately do NOT gate the build, and why.
 *
 * This list exists so that "not gated" is a *decision on the page* rather than an
 * absence someone has to notice. A metric silently missing from the threshold
 * table looks exactly like a metric nobody has gotten around to — this is how you
 * tell them apart.
 */
export const NOT_GATED: Readonly<Record<string, string>> = {
  ttfb_p99:
    "p99 over 20 records is the maximum in disguise: it moved 732ms between two runs of " +
    "identical code. Gating it would fail builds at random. Watch it against the budget instead.",
  latency_p95:
    "Wall-clock p95 moved 2.7s between identical runs (TTS synthesizes a whole reply). " +
    "ttfb_p95 is the number that matters for voice anyway (docs/EVAL_STRATEGY.md §5).",
  chrf_judge_spearman:
    "Agreement is a diagnostic about the SCORERS, not the system. A falling correlation means " +
    "the judge and chrF disagree — that is a finding to read, not a build to fail.",
  chrf_judge_pearson: "See chrf_judge_spearman.",
};

export type Verdict =
  | "improved"
  | "flat"
  | "regressed"
  | "regressed_past_threshold"
  | "appeared"
  | "disappeared"
  | "ungated";

export interface DeltaVerdict extends ScoreDelta {
  verdict: Verdict;
  /** The threshold this was judged against, or null when the metric is not gated. */
  threshold: number | null;
  /** True when this delta should fail a build. */
  fails: boolean;
}

/**
 * Flat is a band, not a point: a float that came back 1e-9 different is the same
 * number. Matches the CLI's existing "did anything move" filter.
 */
const FLAT_EPSILON = 0.001;

export function thresholdFor(metric: string): number | null {
  return REGRESSION_THRESHOLDS[metric] ?? null;
}

/**
 * Judges one metric's movement.
 *
 * Direction is NOT re-derived here — `isImprovement` owns it, it is unit-tested,
 * and the one time that logic was retyped by hand from memory it reported a judge
 * that had started failing as an improvement (see metrics/direction.ts).
 */
export function classifyDelta(delta: ScoreDelta): DeltaVerdict {
  const threshold = thresholdFor(delta.metric);
  const base = { ...delta, threshold, fails: false };

  // A metric present in only one of the two runs. The FULL OUTER JOIN in
  // diffRuns surfaces these on purpose: a scorer was added, or a language quietly
  // stopped being scored. Neither is a quality regression, and neither is nothing.
  if (delta.before === null) return { ...base, verdict: "appeared" };
  if (delta.after === null) return { ...base, verdict: "disappeared", fails: false };

  const moved = delta.delta ?? 0;
  if (Math.abs(moved) < FLAT_EPSILON) return { ...base, verdict: "flat" };
  if (isImprovement(delta.metric, moved)) return { ...base, verdict: "improved" };

  // Worse, from here down.
  if (threshold === null) return { ...base, verdict: "ungated" };

  const worseBy = lowerIsBetter(delta.metric) ? moved : -moved;
  return worseBy > threshold
    ? { ...base, verdict: "regressed_past_threshold", fails: true }
    : { ...base, verdict: "regressed" };
}

export interface Comparability {
  comparable: boolean;
  reasons: string[];
}

/**
 * Whether two runs' numbers can be compared at all.
 *
 * **The config-hash rule.** If the two runs ran under different configurations or
 * different answer keys, a metric that moved may have moved *because of that*, and
 * calling it a regression is a lie the harness would be telling on its own
 * authority. The diff is still shown — suppressing it would be worse — but it is
 * labelled, and it does not fail the build.
 *
 * The cost of that is stated plainly rather than hidden: a PR that changes a
 * prompt changes `config_hash`, so the gate cannot fail it. That is not a
 * loophole to close, it is the truth about what a config-hash means. Such a run
 * needs a human to read the diff, which is exactly what the "NOT COMPARABLE"
 * banner is for.
 */
export function comparability(base: EvalRunRow, head: EvalRunRow): Comparability {
  const reasons: string[] = [];

  if (base.config_hash !== head.config_hash) {
    reasons.push(
      `config_hash differs (${short(base.config_hash)} → ${short(head.config_hash)}): ` +
        "models, modes, decoding params or prompt versions changed. A metric that moved may be " +
        "a configuration change, not a quality change.",
    );
  }
  if (base.golden_set_version !== head.golden_set_version) {
    reasons.push(
      `golden_set_version differs (v${base.golden_set_version} → v${head.golden_set_version}): ` +
        "the answer key changed, so these numbers are not measuring the same thing.",
    );
  }

  return { comparable: reasons.length === 0, reasons };
}

function short(hash: string): string {
  return hash.replace(/^sha256:/u, "").slice(0, 8);
}

export interface RegressionSummary {
  deltas: DeltaVerdict[];
  /** Deltas that broke a threshold. Empty when the run is clean. */
  failures: DeltaVerdict[];
  comparable: boolean;
  reasons: string[];
  /** True when something regressed past threshold AND the runs are comparable. */
  shouldFailBuild: boolean;
}

export function summarize(
  deltas: ScoreDelta[],
  base: EvalRunRow,
  head: EvalRunRow,
): RegressionSummary {
  const { comparable, reasons } = comparability(base, head);
  const classified = deltas.map(classifyDelta);
  const failures = classified.filter((d) => d.fails);

  return {
    deltas: classified,
    failures,
    comparable,
    reasons,
    // The config-hash rule, enforced in one place: an incomparable diff never
    // fails a build, however red it looks.
    shouldFailBuild: comparable && failures.length > 0,
  };
}
