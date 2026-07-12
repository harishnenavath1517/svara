import { characters, tokenize } from "./normalize.js";

/**
 * Word and character error rate, via Levenshtein distance against the reference.
 *
 * WER = (substitutions + deletions + insertions) / reference length. Note it is
 * *not* bounded above by 1: a model that hallucinates a paragraph in response to
 * two words scores well over 100%, and that is the correct, informative answer —
 * clamping it to 1 would hide the worst failures behind a tidy number.
 */

export interface ErrorRate {
  /** substitutions + deletions + insertions */
  errors: number;
  /** Length of the reference, in the unit being counted. */
  reference: number;
  /** errors / reference. Unbounded above. NaN-free: 0 when both are empty. */
  rate: number;
  substitutions: number;
  deletions: number;
  insertions: number;
}

export function wordErrorRate(reference: string, hypothesis: string): ErrorRate {
  return errorRate(tokenize(reference), tokenize(hypothesis));
}

export function characterErrorRate(reference: string, hypothesis: string): ErrorRate {
  return errorRate(characters(reference), characters(hypothesis));
}

/**
 * Aggregate over a set the way WER is actually defined: sum the errors, sum the
 * reference lengths, divide once.
 *
 * Averaging per-utterance rates instead would weight a three-word utterance the
 * same as a thirty-word one, so one short line the model fluffed could swamp the
 * corpus number. Both are "the WER"; only one of them is comparable across runs.
 */
export function aggregateErrorRate(rates: ErrorRate[]): ErrorRate {
  const total = rates.reduce(
    (acc, r) => ({
      errors: acc.errors + r.errors,
      reference: acc.reference + r.reference,
      substitutions: acc.substitutions + r.substitutions,
      deletions: acc.deletions + r.deletions,
      insertions: acc.insertions + r.insertions,
      rate: 0,
    }),
    { errors: 0, reference: 0, substitutions: 0, deletions: 0, insertions: 0, rate: 0 },
  );
  total.rate = total.reference === 0 ? 0 : total.errors / total.reference;
  return total;
}

/** Levenshtein with edit-type accounting, over two token/character sequences. */
function errorRate(reference: string[], hypothesis: string[]): ErrorRate {
  const R = reference.length;
  const H = hypothesis.length;

  if (R === 0) {
    // Nothing was supposed to be said. Anything the model emitted is an insertion,
    // and there is no reference length to divide by — rate 0 keeps the aggregate
    // honest (these contribute errors but no denominator).
    return { errors: H, reference: 0, rate: 0, substitutions: 0, deletions: 0, insertions: H };
  }

  // Full DP matrix with backpointers. The set is ~20 short utterances per
  // language, so the O(R*H) memory is irrelevant and the edit breakdown — which
  // an O(min) rolling-row version cannot give you — is worth having: a WER that
  // is all deletions means the model truncated, all insertions means it babbled,
  // and those are different bugs.
  const cost: number[][] = Array.from({ length: R + 1 }, () => new Array<number>(H + 1).fill(0));
  for (let i = 0; i <= R; i += 1) cost[i]![0] = i;
  for (let j = 0; j <= H; j += 1) cost[0]![j] = j;

  for (let i = 1; i <= R; i += 1) {
    for (let j = 1; j <= H; j += 1) {
      const match = reference[i - 1] === hypothesis[j - 1];
      cost[i]![j] = Math.min(
        cost[i - 1]![j - 1]! + (match ? 0 : 1), // substitute (or match)
        cost[i - 1]![j]! + 1, // delete from reference
        cost[i]![j - 1]! + 1, // insert into hypothesis
      );
    }
  }

  // Walk back to attribute each edit. Ties are broken toward substitution, then
  // deletion, then insertion — a fixed order, so the breakdown is reproducible.
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = R;
  let j = H;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const match = reference[i - 1] === hypothesis[j - 1];
      if (cost[i]![j] === cost[i - 1]![j - 1]! + (match ? 0 : 1)) {
        if (!match) substitutions += 1;
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + 1) {
      deletions += 1;
      i -= 1;
      continue;
    }
    insertions += 1;
    j -= 1;
  }

  const errors = substitutions + deletions + insertions;
  return { errors, reference: R, rate: errors / R, substitutions, deletions, insertions };
}
