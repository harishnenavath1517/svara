/**
 * Text normalization, applied before every text metric in the harness.
 *
 * This is versioned on purpose. A normalizer change moves every WER, CER and
 * chrF number in the project at once, and it does so *without any model
 * changing* — which is the most confusing possible way to see a regression.
 * `NORMALIZER_VERSION` goes into the eval run's config hash, so two runs that
 * normalized differently can never claim to have been the same configuration.
 *
 * Bump it in the same commit as any change below.
 */
export const NORMALIZER_VERSION = "1";

/**
 * Punctuation across the scripts we handle: ASCII, Devanagari danda (U+0964,
 * U+0965), and the general Unicode punctuation block. Not stripped: the ZWJ/ZWNJ
 * joiners, which are *letters* in Indic scripts — removing them silently changes
 * what word was said.
 */
const PUNCTUATION =
  /[!-/:-@[-`{-~।॥‐-‧‰-⁞¡¿«»]/gu;

/**
 * Normalize for scoring. The order matters:
 *
 *  1. NFC — an Indic vowel sign can be composed or decomposed and look identical
 *     on screen while comparing unequal. Without this, CER measures Unicode
 *     encoding rather than speech.
 *  2. Lowercase — only affects the Latin runs inside code-mixed text (Devanagari
 *     and Tamil are unicameral), but "Aadhaar" vs "aadhaar" is not an ASR error.
 *  3. Strip punctuation — the models do not reliably emit it, and neither do the
 *     humans who authored the scripts. Scoring it would measure a coin flip.
 *  4. Collapse whitespace.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Whitespace tokens of the normalized text. The unit WER counts. */
export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * Characters of the normalized text, with spaces removed. The unit CER counts.
 *
 * Uses `Array.from`, not `.split("")`: splitting a string in JS walks UTF-16 code
 * units, so it would cut a surrogate pair in half and count one character as two
 * broken ones. Every Indic script here lives in the BMP so it rarely bites — but
 * it bites silently, and inflates CER, when it does.
 */
export function characters(text: string): string[] {
  return Array.from(normalize(text).replace(/\s+/gu, ""));
}
