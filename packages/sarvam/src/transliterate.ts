import type { LanguageCode } from "@svara/shared";
import { authHeaders, SarvamError, type SarvamClientConfig } from "./config.js";

/**
 * POST /transliterate. Romanizes Indic script into Latin ("मैं ऑफिस जा रहा हूँ" →
 * "main office ja raha hun") when `target_language_code` is `en-IN`.
 *
 * This exists for one reason, and it is the most important thing the eval harness
 * discovered: **you cannot score code-mixed ASR with naive WER.**
 *
 * Saaras hears a Hinglish utterance perfectly and then writes the English words
 * in Devanagari — "Aadhaar card" comes back as "आधार कार्ड". The recognition is
 * flawless; the *script* is the model's own formatting choice. Token WER against a
 * Latin-script reference counts every one of those as a substitution and reports
 * 60-86% error on utterances the model got completely right.
 *
 * Romanizing both sides collapses that away and leaves only real recognition
 * error. The harness reports both numbers — the script-sensitive one (what a
 * naive eval would tell you) and the script-invariant one (what actually
 * happened) — because the distance between them is the finding.
 */
export interface TransliterateOptions {
  /** `auto` lets Sarvam detect it. */
  source: LanguageCode | "auto";
  /** `en-IN` for romanized Latin output. */
  target: LanguageCode;
  signal?: AbortSignal;
}

interface TransliterateResponse {
  transliterated_text?: string;
}

export async function transliterate(
  input: string,
  opts: TransliterateOptions,
  config: SarvamClientConfig,
): Promise<string> {
  // The API rejects empty input, and an empty transcript is a legitimate thing to
  // want romanized (a hop that heard nothing) — so short-circuit rather than 400.
  if (input.trim().length === 0) return "";

  const response = await fetch(`${config.baseUrl}/transliterate`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({
      input,
      source_language_code: opts.source,
      target_language_code: opts.target,
      // Keep digits as digits on both sides of the comparison. Letting one side
      // spell "15" and the other "fifteen" would reintroduce, in the numbers
      // bucket, exactly the spelling-not-recognition error this call removes.
      numerals_format: "international",
    }),
    signal: opts.signal ?? null,
  });

  if (!response.ok) {
    throw new SarvamError(
      `transliterate_http_${response.status}`,
      `transliterate failed: ${response.status} ${await response.text().catch(() => "")}`.trim(),
    );
  }

  const body = (await response.json()) as TransliterateResponse;
  return body.transliterated_text ?? "";
}
