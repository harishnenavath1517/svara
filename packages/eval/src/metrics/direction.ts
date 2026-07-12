/**
 * Which way is up, per metric.
 *
 * The eval plane reports two kinds of number in one table — error rates, where
 * lower is better, and quality scores, where higher is. A diff that renders both
 * as a bare signed delta invites the reader to congratulate themselves on a rising
 * WER, and the whole point of the harness is to stop exactly that kind of
 * self-deception.
 *
 * This lives in its own tested module rather than inline in the CLI's print
 * statement because it is *deceptively* easy to get wrong: the first version of
 * this logic, typed in haste, omitted `unparseable` from the lower-is-better list
 * and duly reported a judge that had started failing as an improvement.
 */

/**
 * Metrics where a smaller number is a better system. Everything else — chrF,
 * judge scores, intent accuracy, the agreement correlations — is better bigger.
 *
 * Matched on substrings, so `ttfb_p95`, `round_trip_wer` and
 * `judge_unparseable_rate` are all caught without an exhaustive list that would
 * silently miss the next metric someone adds.
 */
const LOWER_IS_BETTER = [
  "wer",
  "cer",
  "error",
  "unparseable",
  "latency",
  "ttfb",
  // A rising empty-transcript rate means VAD is firing on noise and the agent is
  // being handed silence to answer (docs/EVAL_STRATEGY.md §6). The test suite
  // caught this one missing from the list, which is the whole argument for the
  // list being tested at all.
  "empty",
] as const;

export function lowerIsBetter(metric: string): boolean {
  return LOWER_IS_BETTER.some((needle) => metric.includes(needle));
}

/**
 * True if `delta` moved this metric in the good direction. A delta of 0 is not an
 * improvement.
 */
export function isImprovement(metric: string, delta: number): boolean {
  if (delta === 0) return false;
  return lowerIsBetter(metric) ? delta < 0 : delta > 0;
}
