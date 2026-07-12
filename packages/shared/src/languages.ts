/**
 * BCP-47 language codes. See docs/SARVAM_API.md.
 *
 * TTS (bulbul:v3) and the LLM cover the 11 codes below. STT (saaras:v3) and
 * /translate cover the full 22 scheduled languages, so STT may legitimately
 * return a code outside SPEECH_LANGUAGES — widen this list, don't cast, when
 * we start exercising the long tail.
 */
export const SPEECH_LANGUAGES = [
  "hi-IN",
  "bn-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "en-IN",
  "gu-IN",
] as const;

export type LanguageCode = (typeof SPEECH_LANGUAGES)[number];

/** STT accepts (and traces record) `unknown` before language ID has resolved. */
export const UNKNOWN_LANGUAGE = "unknown";
export type UnknownLanguage = typeof UNKNOWN_LANGUAGE;

/** What a trace's `lang` field may hold: a resolved code, or not-yet-detected. */
export type TraceLanguage = LanguageCode | UnknownLanguage;

export function isLanguageCode(value: string): value is LanguageCode {
  return (SPEECH_LANGUAGES as readonly string[]).includes(value);
}

/** Human-readable names, for dashboard axes and eval reports. */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  "hi-IN": "Hindi",
  "bn-IN": "Bengali",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "od-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "en-IN": "English (India)",
  "gu-IN": "Gujarati",
};
