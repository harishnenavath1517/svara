import type { SttMode } from "./constants.js";
import type { TraceLanguage } from "./languages.js";

/** The three model hops in a turn. */
export const HOPS = ["stt", "llm", "tts"] as const;
export type Hop = (typeof HOPS)[number];

export interface TraceError {
  code: string;
  message: string;
}

export interface LatencyBudget {
  stt: number;
  llm: number;
  tts: number;
  endToEndFirstAudio: number;
}

/**
 * A single hop of a single turn, published to `svara.traces`.
 * Contract: docs/DATA_CONTRACTS.md — change both together.
 *
 * Rules that the type can't enforce, but you must:
 *  - Emit even on failure (set `error`, still record `latency_ms`). Failed
 *    turns are the most valuable eval data.
 *  - `config_hash` is identical across every hop of a run, so metrics attribute
 *    to one configuration.
 *  - Never inline raw audio. Store the blob, reference it by URI.
 */
export interface TraceEvent {
  /** One per turn. */
  trace_id: string;
  /** One per call/conversation. */
  session_id: string;
  /** 0-based within the session. */
  turn_index: number;
  hop: Hop;
  /** BCP-47, or "unknown" if language ID hasn't resolved yet. */
  lang: TraceLanguage;
  /** Exact model used, e.g. "saaras:v3". */
  model: string;
  /** STT mode when applicable, else null. */
  mode: SttMode | null;
  /** Audio blob URI in (stt/tts), else null. Never the audio itself. */
  input_ref: string | null;
  /** Audio blob URI out (tts), else null. */
  output_ref: string | null;
  /** Transcript into the LLM, or text into TTS. */
  text_in: string | null;
  /** Transcript (stt), reply (llm), or null (tts). */
  text_out: string | null;
  /** Qdrant point ids used on the llm hop; [] elsewhere. */
  rag_context_ids: string[];
  /** Wall time for this hop. */
  latency_ms: number;
  /** Time to first byte/token on streaming hops; null if not streamed. */
  ttfb_ms: number | null;
  /** sha256 of models + modes + prompt versions. */
  config_hash: string;
  git_sha: string;
  /** ISO-8601. */
  ts: string;
  /** Non-null on failure. */
  error: TraceError | null;
}

/**
 * Turn-level summary published to `svara.turns` for the dashboard's live view.
 */
export interface TurnEvent {
  trace_id: string;
  session_id: string;
  turn_index: number;
  lang: TraceLanguage;
  total_latency_ms: number;
  /** First audio out of TTS — the number the <800ms budget refers to. */
  first_audio_ms: number | null;
  ok: boolean;
}
