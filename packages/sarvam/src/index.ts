import { SARVAM_AUTH_HEADER, SARVAM_BASE_URL, sarvamApiKey } from "@svara/shared";
import type { Secret } from "@svara/shared";

/**
 * Typed Sarvam client — STT (WS), TTS (stream), chat, translate.
 * Built in Phase 1; see docs/ROADMAP.md and docs/SARVAM_API.md.
 *
 * The auth key goes in the `api-subscription-key` header and nowhere else:
 * never a query string, never a log line (guardrail 2 in CLAUDE.md).
 */
export interface SarvamClientConfig {
  apiKey: Secret;
  baseUrl: string;
}

export function createConfig(): SarvamClientConfig {
  return { apiKey: sarvamApiKey(), baseUrl: SARVAM_BASE_URL };
}

export function authHeaders(config: SarvamClientConfig): Record<string, string> {
  return { [SARVAM_AUTH_HEADER]: config.apiKey.reveal() };
}
