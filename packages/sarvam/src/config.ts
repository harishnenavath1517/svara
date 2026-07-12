import { SARVAM_AUTH_HEADER, SARVAM_BASE_URL, optionalEnv, sarvamApiKey } from "@svara/shared";
import type { Secret } from "@svara/shared";

/**
 * Typed Sarvam client — STT (WS), TTS (WS), chat (SSE). See docs/SARVAM_API.md.
 *
 * The auth key goes in the `api-subscription-key` header and nowhere else:
 * never a query string, never a log line (guardrail 2 in CLAUDE.md). The only
 * `.reveal()` in this package is in `authHeaders` below.
 */
export interface SarvamClientConfig {
  apiKey: Secret;
  /** REST base, e.g. https://api.sarvam.ai */
  baseUrl: string;
  /** WebSocket base, e.g. wss://api.sarvam.ai */
  wsBaseUrl: string;
  /**
   * OpenAI-compatible chat base. Point this at a LiteLLM proxy to swap the LLM
   * without touching the hop.
   */
  llmBaseUrl: string;
}

export function createConfig(): SarvamClientConfig {
  const baseUrl = optionalEnv("SARVAM_BASE_URL", SARVAM_BASE_URL);
  return {
    apiKey: sarvamApiKey(),
    baseUrl,
    wsBaseUrl: baseUrl.replace(/^http/, "ws"),
    llmBaseUrl: optionalEnv("LLM_BASE_URL", `${baseUrl}/v1`),
  };
}

export function authHeaders(config: SarvamClientConfig): Record<string, string> {
  return { [SARVAM_AUTH_HEADER]: config.apiKey.reveal() };
}

/** Sarvam returns errors as JSON; surface the body, never the request headers. */
export class SarvamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SarvamError";
  }
}
