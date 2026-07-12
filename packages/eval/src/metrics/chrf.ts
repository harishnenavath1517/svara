import { normalize } from "./normalize.js";

/**
 * chrF — character n-gram F-score (Popović, 2015). The translation metric.
 *
 * Chosen over BLEU deliberately. BLEU counts word n-grams, and word-level metrics
 * are near-useless on Indic output: these are agglutinative, morphologically rich
 * languages where one inflected token carries what English spreads over three, so
 * a single suffix disagreement wipes out every n-gram it touches. chrF counts
 * *character* n-grams and degrades gracefully instead — a near-miss inflection
 * scores as a near miss.
 *
 * F-score is weighted toward recall by `beta` (2 by convention): failing to say
 * something the reference said is a worse translation error than adding a word.
 */

const MAX_N = 6;
const BETA = 2;

/**
 * chrF in [0, 1]. Reported as-is, not scaled to 100 — every other rate in this
 * harness is a fraction, and mixing the two conventions in one table is how a
 * dashboard ends up claiming a 0.62 chrF regressed to 62.
 */
export function chrf(reference: string, hypothesis: string, maxN = MAX_N, beta = BETA): number {
  const ref = normalize(reference).replace(/\s+/gu, "");
  const hyp = normalize(hypothesis).replace(/\s+/gu, "");

  if (ref.length === 0 && hyp.length === 0) return 1;
  if (ref.length === 0 || hyp.length === 0) return 0;

  let precisionSum = 0;
  let recallSum = 0;
  let orders = 0;

  for (let n = 1; n <= maxN; n += 1) {
    const refGrams = ngrams(ref, n);
    const hypGrams = ngrams(hyp, n);
    const refTotal = count(refGrams);
    const hypTotal = count(hypGrams);

    // An order with no n-grams on either side (the strings are shorter than n)
    // carries no information. Averaging a 0 in for it would drag the score down
    // purely because the utterance was short.
    if (refTotal === 0 || hypTotal === 0) continue;

    let overlap = 0;
    for (const [gram, hypCount] of hypGrams) {
      // Clipped: three "aaa" in the hypothesis cannot match one in the reference
      // more than once. Without the clip, a model that repeats itself scores
      // higher — which is exactly the degenerate output we most want to punish.
      overlap += Math.min(hypCount, refGrams.get(gram) ?? 0);
    }

    precisionSum += overlap / hypTotal;
    recallSum += overlap / refTotal;
    orders += 1;
  }

  if (orders === 0) return 0;

  const precision = precisionSum / orders;
  const recall = recallSum / orders;
  if (precision === 0 && recall === 0) return 0;

  const beta2 = beta * beta;
  return ((1 + beta2) * precision * recall) / (beta2 * precision + recall);
}

function ngrams(text: string, n: number): Map<string, number> {
  const grams = new Map<string, number>();
  // Array.from, not indexing: a surrogate pair must count as one character or the
  // n-grams straddle half a code point.
  const chars = Array.from(text);
  for (let i = 0; i + n <= chars.length; i += 1) {
    const gram = chars.slice(i, i + n).join("");
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function count(grams: Map<string, number>): number {
  let total = 0;
  for (const n of grams.values()) total += n;
  return total;
}
