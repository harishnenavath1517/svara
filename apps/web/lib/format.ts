import type { EvalScoreRow } from "@svara/db";

/**
 * Rendering rules that the dashboard must not get wrong, in one place.
 *
 * Most of these look like cosmetics and are not. A latency printed as "0.648"
 * because it went through the generic rate formatter is a number nobody reads as
 * 648ms; a judge mean printed without its `n` is a number that means nothing at
 * all (docs/EVAL_STRATEGY.md — the judge is saturated on hi-IN, and 4.95 over an
 * unstated sample is exactly how that gets sold as quality).
 */

/** Millisecond metrics. Everything else in the harness is a fraction or a rubric point. */
export function isTimeMetric(metric: string): boolean {
  return metric.includes("ttfb") || metric.includes("latency");
}

/** A 1–5 rubric score, not a rate. Printing it as a fraction would read as 500%. */
export function isJudgeMetric(metric: string): boolean {
  return metric.startsWith("judge_") && !metric.includes("rate");
}

export function formatValue(metric: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (isTimeMetric(metric)) return `${Math.round(value)} ms`;
  if (isJudgeMetric(metric)) return `${value.toFixed(2)} / 5`;
  return value.toFixed(3);
}

export function formatDelta(metric: string, delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  if (isTimeMetric(metric)) return `${sign}${Math.round(delta)} ms`;
  return `${sign}${delta.toFixed(3)}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/u, "").slice(0, 8);
}

/** Pivots the deliberately-tall eval_scores rows into a lookup the tables index into. */
export type ScoreIndex = Map<string, EvalScoreRow>;

export function indexScores(rows: EvalScoreRow[]): ScoreIndex {
  return new Map(rows.map((r) => [key(r.lang, r.hop, r.metric, r.slice), r]));
}

export function key(lang: string, hop: string, metric: string, slice = "all"): string {
  return `${lang}|${hop}|${metric}|${slice}`;
}

export function pick(
  index: ScoreIndex,
  lang: string,
  hop: string,
  metric: string,
  slice = "all",
): EvalScoreRow | undefined {
  return index.get(key(lang, hop, metric, slice));
}

/** Languages present in a run, in a stable order. */
export function languagesIn(rows: EvalScoreRow[]): string[] {
  return [...new Set(rows.map((r) => r.lang))].sort();
}

/** Slices present for a hop+metric, with `all` pinned first. */
export function slicesIn(rows: EvalScoreRow[], hop: string, metric: string): string[] {
  const found = [...new Set(rows.filter((r) => r.hop === hop && r.metric === metric).map((r) => r.slice))];
  return found.sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b)));
}
