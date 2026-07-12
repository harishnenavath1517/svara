/**
 * Metric↔judge agreement.
 *
 * The point of EVAL_STRATEGY's "metric + judge, never judge alone" rule. chrF is
 * cheap, reproducible, and blind to meaning: it will happily reward a fluent
 * mistranslation that reuses the reference's characters. The judge understands
 * meaning but is a model with its own biases, and it is not reproducible. Neither
 * is trustworthy on its own.
 *
 * Reporting their **correlation** is what makes the pair honest. High agreement
 * means the cheap metric is tracking the expensive one and you can gate CI on it.
 * Low agreement is not a failure — it is a *finding*, and the most valuable thing
 * this harness can tell you: it means one of the two is systematically wrong on
 * this language, and you now know to go look at the samples where they diverge
 * instead of trusting a single number.
 */

/**
 * Pearson — linear correlation. Answers "does chrF move proportionally with the
 * judge's score?"
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  // Two points always correlate perfectly (a line fits any two points), so a
  // correlation over fewer than three samples is arithmetic, not evidence.
  if (n < 3) return null;

  const meanX = mean(xs.slice(0, n));
  const meanY = mean(ys.slice(0, n));

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  // Zero variance on either side: the judge gave everything a 4, or chrF is
  // identical throughout. Correlation is undefined, not zero — returning 0 would
  // read as "they disagree", when in truth nothing was measured.
  if (varianceX === 0 || varianceY === 0) return null;

  return covariance / Math.sqrt(varianceX * varianceY);
}

/**
 * Spearman — rank correlation, and the one to trust here.
 *
 * The judge emits a 1-5 integer; chrF is continuous in [0,1]. There is no reason
 * to expect a *linear* relationship between them, and Pearson would punish a
 * perfectly good monotonic one. What we actually care about is whether the metric
 * ranks the same translations the judge ranks — and that is exactly what Spearman
 * measures. Ties are handled with average ranks, which matters a lot when the
 * judge hands out the same score repeatedly.
 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  return pearson(rank(xs.slice(0, n)), rank(ys.slice(0, n)));
}

/** Average ranks for ties — the standard correction. */
function rank(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]?.value === indexed[i]?.value) j += 1;

    // Ranks are 1-based; the tied block all take the mean of the ranks it spans.
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const entry = indexed[k];
      if (entry !== undefined) ranks[entry.index] = averageRank;
    }
    i = j + 1;
  }
  return ranks;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
