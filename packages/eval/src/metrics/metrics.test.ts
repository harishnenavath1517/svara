import { describe, expect, it } from "vitest";
import { pearson, spearman } from "./agreement.js";
import { chrf } from "./chrf.js";
import { isImprovement, lowerIsBetter } from "./direction.js";
import { percentiles } from "./latency.js";
import { characters, normalize, tokenize } from "./normalize.js";
import { aggregateErrorRate, characterErrorRate, wordErrorRate } from "./wer.js";

describe("normalize", () => {
  it("strips punctuation, lowercases, and collapses whitespace", () => {
    expect(normalize("  Kya  Aadhaar CARD hai?  ")).toBe("kya aadhaar card hai");
  });

  it("strips the Devanagari danda", () => {
    expect(normalize("मेरा पैसा नहीं आया।")).toBe("मेरा पैसा नहीं आया");
  });

  it("NFC-normalizes so composed and decomposed forms compare equal", () => {
    // Same grapheme, two encodings. Without NFC these compare unequal and CER
    // silently measures Unicode rather than speech.
    const composed = "नि"; // नि  (NA + vowel sign I)
    const decomposed = "नि".normalize("NFD");
    expect(normalize(composed)).toBe(normalize(decomposed));
  });

  it("does NOT strip ZWJ/ZWNJ, which are letters in Indic scripts", () => {
    // Removing a joiner changes which word was said. It must survive normalization.
    const withJoiner = "क‍ष";
    expect(normalize(withJoiner)).toContain("‍");
  });

  it("counts characters by code point, not UTF-16 code unit", () => {
    // "\u{1F600}" is a surrogate pair: .split("") would report 2 characters.
    expect(characters("a\u{1F600}b")).toHaveLength(3);
  });

  it("tokenizes an empty string to no tokens, not one empty token", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("wordErrorRate", () => {
  it("is 0 for an exact match after normalization", () => {
    expect(wordErrorRate("Mera paisa nahi aaya", "mera paisa nahi aaya!").rate).toBe(0);
  });

  it("counts a substitution", () => {
    const r = wordErrorRate("a b c d", "a x c d");
    expect(r).toMatchObject({ substitutions: 1, deletions: 0, insertions: 0, errors: 1 });
    expect(r.rate).toBeCloseTo(0.25);
  });

  it("counts a deletion", () => {
    expect(wordErrorRate("a b c d", "a c d")).toMatchObject({ deletions: 1, errors: 1 });
  });

  it("counts an insertion", () => {
    expect(wordErrorRate("a b c", "a b x c")).toMatchObject({ insertions: 1, errors: 1 });
  });

  it("exceeds 1.0 when the model hallucinates — it is NOT clamped", () => {
    // A model that answers two words with a paragraph must score worse than one
    // that says nothing. Clamping to 1 would hide the worst failure mode there is.
    expect(wordErrorRate("a b", "a b c d e f g h").rate).toBeGreaterThan(1);
  });

  it("treats an empty hypothesis as all-deletions", () => {
    expect(wordErrorRate("a b c", "")).toMatchObject({ deletions: 3, rate: 1 });
  });

  it("scores the code-mixed script effect this harness was built to catch", () => {
    // Saaras heard this utterance perfectly and wrote the loanwords in Devanagari.
    // Naive token WER calls that a majority-error transcription. It is not an ASR
    // error at all — which is why the QA gate scores on the romanized axis.
    const script = "क्या Aadhaar card और bank passbook काफी है";
    const heard = "क्या आधार कार्ड और बैंक पासबुक काफी है";

    // Exactly half: 4 of the 8 reference words are the Latin-script loanwords, and
    // every one of them is scored as a substitution for having been written in
    // Devanagari. Nothing was misheard.
    const r = wordErrorRate(script, heard);
    expect(r.rate).toBeCloseTo(0.5);
    expect(r.substitutions).toBe(4);
    expect(r.deletions + r.insertions).toBe(0);
  });
});

describe("characterErrorRate", () => {
  it("is far more forgiving of romanization spelling than WER", () => {
    // The exact pair that a WER gate wrongly quarantined: same word, same sound,
    // th/dh and a doubled consonant apart.
    const expected = "Moondru maathangalaaga en thavanai niruthapattullathu";
    const heard = "Moondru maadhangalaaga en thavanaai niruthappattulladhu";

    expect(wordErrorRate(expected, heard).rate).toBeGreaterThan(0.5);
    expect(characterErrorRate(expected, heard).rate).toBeLessThan(0.25);
  });
});

describe("aggregateErrorRate", () => {
  it("pools errors over references rather than averaging per-utterance rates", () => {
    // One 1-word utterance fully wrong, one 9-word utterance fully right.
    // Pooled  : 1 error / 10 reference words = 0.10  <- comparable across runs
    // Averaged: (1.0 + 0.0) / 2               = 0.50  <- one short line swamps it
    const short = wordErrorRate("a", "x");
    const long = wordErrorRate("b c d e f g h i j", "b c d e f g h i j");
    expect(aggregateErrorRate([short, long]).rate).toBeCloseTo(0.1);
  });

  it("is 0, not NaN, for an empty set", () => {
    expect(aggregateErrorRate([]).rate).toBe(0);
  });
});

describe("chrf", () => {
  it("is 1 for an identical string", () => {
    expect(chrf("hello world", "hello world")).toBeCloseTo(1);
  });

  it("is 0 against an empty candidate", () => {
    expect(chrf("hello world", "")).toBe(0);
  });

  it("scores a near-miss inflection generously, unlike a word metric", () => {
    // The reason chrF and not BLEU: one suffix must not wipe out the sentence.
    expect(chrf("the instalment has stopped", "the instalment has stopped")).toBeCloseTo(1);
    expect(chrf("the instalment has stopped", "the instalments have stopped")).toBeGreaterThan(0.7);
  });

  it("does not reward a model for repeating itself", () => {
    // Clipped n-gram counts: degenerate repetition must not out-score a real answer.
    const honest = chrf("my money has not arrived", "my money has not arrived");
    const babbling = chrf("my money has not arrived", "my money my money my money my money");
    expect(babbling).toBeLessThan(honest);
  });
});

describe("percentiles", () => {
  it("interpolates like Postgres percentile_cont", () => {
    const p = percentiles([1, 2, 3, 4]);
    expect(p.p50).toBeCloseTo(2.5);
    expect(p.n).toBe(4);
  });

  it("drops nulls instead of counting a missing TTFB as 0ms", () => {
    // A hop that never produced a first byte is missing a measurement, not fast.
    // Coercing null to 0 would make the broken hop the fastest row in the table.
    const p = percentiles([500, null, 600, undefined]);
    expect(p.n).toBe(2);
    expect(p.min).toBe(500);
  });

  it("returns nulls, not zeros, for an empty sample", () => {
    expect(percentiles([])).toMatchObject({ n: 0, p50: null, p95: null });
  });
});

describe("direction", () => {
  it.each(["wer", "cer", "round_trip_wer", "wer_romanized", "empty_transcript_rate"])(
    "%s is lower-is-better",
    (metric) => {
      expect(lowerIsBetter(metric)).toBe(true);
    },
  );

  it.each(["ttfb_p50", "ttfb_p99", "latency_p95", "error_rate"])(
    "%s is lower-is-better",
    (metric) => {
      expect(lowerIsBetter(metric)).toBe(true);
    },
  );

  it.each(["chrf", "judge_adequacy", "judge_fluency", "intent_accuracy", "chrf_judge_spearman"])(
    "%s is higher-is-better",
    (metric) => {
      expect(lowerIsBetter(metric)).toBe(false);
    },
  );

  it("treats a rising judge_unparseable_rate as a REGRESSION", () => {
    // The exact bug this module exists to prevent. A judge that has started
    // failing to answer must never be reported as an improvement.
    expect(lowerIsBetter("judge_unparseable_rate")).toBe(true);
    expect(isImprovement("judge_unparseable_rate", +0.05)).toBe(false);
    expect(isImprovement("judge_unparseable_rate", -0.05)).toBe(true);
  });

  it("treats a rising WER as a regression and a rising chrF as an improvement", () => {
    expect(isImprovement("wer", +0.02)).toBe(false);
    expect(isImprovement("chrf", +0.02)).toBe(true);
  });

  it("does not call an unchanged metric an improvement", () => {
    expect(isImprovement("wer", 0)).toBe(false);
    expect(isImprovement("chrf", 0)).toBe(false);
  });
});

describe("agreement", () => {
  it("pearson is 1 for a perfect linear relationship", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
  });

  it("pearson is -1 when inverted", () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
  });

  it("spearman catches a monotonic relationship that pearson underrates", () => {
    // chrF is continuous, the judge emits 1-5 integers; there is no reason to
    // expect linearity between them. Rank correlation is the honest instrument.
    const chrfScores = [0.1, 0.2, 0.4, 0.8, 0.99];
    const judgeScores = [1, 2, 3, 4, 5];
    const rho = spearman(chrfScores, judgeScores);
    expect(rho).toBeCloseTo(1);
    expect(rho!).toBeGreaterThan(pearson(chrfScores, judgeScores)!);
  });

  it("handles ties with average ranks", () => {
    expect(spearman([1, 1, 2, 3], [1, 1, 2, 3])).toBeCloseTo(1);
  });

  it("returns null rather than a fake correlation for fewer than 3 samples", () => {
    // Any two points lie on a line. A correlation over them is arithmetic, not evidence.
    expect(pearson([1, 2], [5, 9])).toBeNull();
  });

  it("returns null when a side has zero variance", () => {
    // The judge gave everything a 4. Correlation is undefined — reporting 0 would
    // read as "the metric and the judge disagree", which is not what happened.
    expect(pearson([1, 2, 3], [4, 4, 4])).toBeNull();
  });
});
