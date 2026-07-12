import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LanguageCode } from "@svara/shared";
import { isLanguageCode, repoRoot } from "@svara/shared";

/**
 * The golden set. Schema: docs/DATA_CONTRACTS.md.
 *
 * Two files per language, and the distinction matters:
 *
 *  - `evals/golden/source/<lang>.jsonl` — **authored by hand**. The utterance
 *    text, its intent label, and an English reference translation. This is the
 *    ground truth, and it is ground truth precisely because a human wrote it and
 *    no model touched it.
 *  - `evals/golden/<lang>.jsonl` — **generated** by `pnpm golden:build`, which
 *    synthesizes audio for each source line and records the audio ref plus the
 *    QA verdict.
 *
 * Why the split: the audio is synthesized by Bulbul, so if we also built the
 * "expected transcript" by running Saaras over that audio, the STT score would be
 * Saaras-vs-Saaras — one model grading its own homework, and a number that cannot
 * go down no matter how bad the model gets. The script we fed the synthesizer is
 * what was said. Saaras still runs over the clip, but as a *check on the
 * synthesis* (did Bulbul say what we asked?), never as the answer key — and in
 * `translit` mode, not the production `codemix` mode, so the gate cannot
 * rubber-stamp the thing it is grading. See build-golden.ts.
 */

export const INTENTS = [
  "check_eligibility",
  "check_status",
  "how_to_apply",
  "document_list",
  "grievance",
] as const;

export type Intent = (typeof INTENTS)[number];

export function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}

/** The buckets the eval reports separately. `code-mixed` is the interesting cell. */
export const TAGS = ["clean", "code-mixed", "numbers", "noisy"] as const;
export type Tag = (typeof TAGS)[number];

/** A hand-authored line. No model has seen this. */
export interface GoldenSource {
  id: string;
  intent: Intent;
  tags: Tag[];
  /** As spoken, in native script, with the code-mixing left in Latin. */
  text: string;
  /** The same utterance romanized, hand-authored. See `expected_romanized`. */
  romanized: string;
  reference_translation: string;
}

/** A built record: a source line plus the audio synthesized for it. */
export interface GoldenRecord {
  id: string;
  lang: LanguageCode;
  audio_ref: string;
  /** The authored script. Ground truth — see the note at the top of this file. */
  expected_transcript: string;
  expected_intent: Intent;
  reference_translation: string;
  /**
   * The utterance romanized to Latin, **hand-authored** (copied from the source
   * file, not generated). The reference for the QA gate and for the
   * script-invariant STT cross-check.
   *
   * It is hand-authored because the obvious alternative — Sarvam's
   * `/transliterate` — is not a pure function: for `ta-IN` it is
   * non-deterministic and degenerates into a repetition loop ("... uraiya uraiya
   * uraiya" ×80) on identical input, while `hi-IN` is stable. A metric that calls
   * it would report regressions that are really API jitter. See the note in
   * packages/sarvam/src/transliterate.ts.
   */
  expected_romanized: string;
  tags: Tag[];
  /** Provenance is required. Bulbul-synthesized audio is honestly "synthetic". */
  consent: "synthetic" | "consented";
  /** Which bulbul:v3 speaker said it. Varied, so we don't fit one voice. */
  speaker: string;
  /** Signal-to-noise ratio of the added noise, dB. Null unless tagged `noisy`. */
  snr_db: number | null;
  /**
   * The QA gate: what Saaras `translit` heard in the synthesized clip, and how
   * far that is from `expected_romanized`.
   *
   * This answers one narrow question — *did Bulbul actually say the thing we
   * asked it to say?* — and it is not the answer key. Two properties make it
   * trustworthy:
   *
   *  - It runs in `translit`, **not** the production `codemix` mode. A gate that
   *    used the same mode it is grading would quarantine exactly the records that
   *    mode is bad at, leaving a set of easy records that scores green and means
   *    nothing.
   *  - It compares on the romanized axis, so a model that heard the words
   *    perfectly but chose a different script is not mistaken for bad synthesis.
   */
  qa_transcript: string | null;
  /** CER, not WER — romanization has no single spelling convention. See build-golden.ts. */
  qa_cer: number | null;
  /** True when the record passed QA and should be scored. */
  usable: boolean;
}

export const GOLDEN_DIR = resolve(repoRoot(), "evals/golden");
export const GOLDEN_AUDIO_DIR = join(GOLDEN_DIR, "audio");
export const GOLDEN_SOURCE_DIR = join(GOLDEN_DIR, "source");

/**
 * Bumped whenever the set's content changes, and stored on every run so a metric
 * move can be attributed to a model change rather than a quietly-edited answer key.
 */
export const GOLDEN_SET_VERSION = "1";

export async function loadSource(lang: LanguageCode): Promise<GoldenSource[]> {
  const raw = await readFile(join(GOLDEN_SOURCE_DIR, `${lang}.jsonl`), "utf8");
  return parseJsonl<GoldenSource>(raw);
}

/**
 * Loads the built set. Returns only usable records by default — a record that
 * failed the synthesis QA gate would otherwise be scored as if the *model* got
 * it wrong, when in fact the audio never said the thing in the first place.
 */
export async function loadGolden(
  lang: LanguageCode,
  opts: { includeQuarantined?: boolean } = {},
): Promise<GoldenRecord[]> {
  const raw = await readFile(join(GOLDEN_DIR, `${lang}.jsonl`), "utf8");
  const records = parseJsonl<GoldenRecord>(raw);
  return opts.includeQuarantined === true ? records : records.filter((r) => r.usable);
}

/** Languages the golden set has actually been built for, not the ones we could build. */
export async function availableLanguages(): Promise<LanguageCode[]> {
  const entries = await readdir(GOLDEN_DIR).catch(() => [] as string[]);
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .filter(isLanguageCode);
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
