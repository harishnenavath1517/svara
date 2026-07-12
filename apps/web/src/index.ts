import { LATENCY_BUDGET_MS, LANGUAGE_NAMES } from "@svara/shared";
import type { LanguageCode } from "@svara/shared";

/**
 * Call UI + eval dashboard (Next.js 15, App Router, React 19).
 *
 * Phase 1 replaces this file with the Next.js app: connect, mic capture, audio
 * playback, live transcript. Phase 3 adds the regression dashboard. Next itself
 * is not installed yet — no point carrying the dependency before there's a page
 * to render. See docs/ROADMAP.md.
 */
export const CALL_UI_LANGUAGES: readonly LanguageCode[] = ["hi-IN", "ta-IN", "te-IN"];

export function languageLabel(code: LanguageCode): string {
  return LANGUAGE_NAMES[code];
}

/** The number the dashboard holds the live loop to. */
export const FIRST_AUDIO_BUDGET_MS = LATENCY_BUDGET_MS.endToEndFirstAudio;
