import type { LatencyBudget } from "./trace.js";

/** Redpanda topics. See docs/DATA_CONTRACTS.md. */
export const TOPICS = {
  /** One event per hop, per turn. The eval plane's source of truth. */
  traces: "svara.traces",
  /** Turn start/end summaries, for the dashboard's live view. */
  turns: "svara.turns",
} as const;

/**
 * Pinned Sarvam models. saarika:v1/v2/flash and bulbul:v1 are DEPRECATED and
 * will fail — see guardrail 1 in CLAUDE.md. Do not add them here.
 */
export const MODELS = {
  stt: "saaras:v3",
  tts: "bulbul:v3",
  llm: "sarvam-30b",
  /** Agentic / eval-judge tier. */
  judge: "sarvam-105b",
  translate: "sarvam-translate",
} as const;

/** saaras:v3 output modes. `mode` is a v3-only param. */
export const STT_MODES = [
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix",
] as const;

export type SttMode = (typeof STT_MODES)[number];

/**
 * Latency targets from docs/ARCHITECTURE.md, in milliseconds. These are the
 * numbers the eval harness holds the pipeline to; the dashboard renders budget
 * vs. actual against them.
 */
export const LATENCY_BUDGET_MS: LatencyBudget = {
  stt: 150,
  llm: 500,
  tts: 200,
  endToEndFirstAudio: 800,
};

export const SARVAM_BASE_URL = "https://api.sarvam.ai";

/** Sarvam auth header name. The key is a header value — never a query param. */
export const SARVAM_AUTH_HEADER = "api-subscription-key";
