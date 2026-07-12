import type { SttMode } from "./constants.js";
import type { LanguageCode, TraceLanguage } from "./languages.js";

/**
 * Temporal activity signatures for the turn saga. Contract:
 * docs/DATA_CONTRACTS.md.
 *
 * A Temporal activity takes serializable arguments and returns a serializable
 * result. It cannot be handed a live microphone, and it cannot yield audio back
 * as it produces it — so the streams do NOT cross this boundary. Only
 * correlation ids go in, and summaries come out.
 *
 * The bytes flow around Temporal instead:
 *   - caller audio and hop output ride the gateway ↔ worker channel
 *     (packages/orchestrator/src/protocol.ts),
 *   - STT → LLM → TTS hand off through the in-worker turn bus
 *     (packages/orchestrator/src/bus.ts).
 *
 * The three activities run *concurrently* and block on that bus, which is what
 * makes the hops overlap: TTS is already subscribed when the LLM's first
 * sentence closes. Buffering a hop to completion blows the <800ms first-audio
 * budget. Per-hop timeouts and retry policy belong on the Temporal activity
 * options, never inside the body.
 */

/** Correlation carried through every hop of one turn, and onto its traces. */
export interface TurnContext {
  trace_id: string;
  session_id: string;
  turn_index: number;
  config_hash: string;
  git_sha: string;
}

/** One STT emission, as it travels the turn bus. Partials arrive with isFinal=false. */
export interface Transcript {
  text: string;
  lang: TraceLanguage;
  isFinal: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TranscribeInput {
  ctx: TurnContext;
  /** Pass "unknown" to let saaras:v3 auto-detect. */
  lang: TraceLanguage;
  /** "codemix" for real call audio; "verbatim" when building golden truth. */
  mode: SttMode;
}

/** The final transcript. Partials went to the bus and the caller's UI as they landed. */
export interface TranscribeOutput {
  text: string;
  lang: TraceLanguage;
}

export type TranscribeActivity = (input: TranscribeInput) => Promise<TranscribeOutput>;

export interface RespondInput {
  ctx: TurnContext;
  /** Prior turns, oldest first. The current utterance arrives over the bus. */
  history: ChatMessage[];
}

export interface RespondOutput {
  text: string;
  lang: LanguageCode;
  /** Qdrant point ids retrieved to ground this reply; [] until RAG lands in Phase 2. */
  ragContextIds: string[];
}

export type RespondActivity = (input: RespondInput) => Promise<RespondOutput>;

export interface SynthesizeInput {
  ctx: TurnContext;
  /**
   * bulbul:v3 speaker — lowercase and case-sensitive, and the v2 roster
   * (anushka, meera) is rejected by v3. Defaults to TTS_SPEAKER.
   */
  speaker?: string;
  /** 0.5–2.0. */
  pace?: number;
}

export interface SynthesizeOutput {
  chunks: number;
  bytes: number;
  /** Hop start → first audio chunk leaving for the caller. */
  ttfb_ms: number | null;
}

/**
 * The language is not an input: TTS reads it off the bus, where STT resolved it.
 * bulbul:v3 cannot speak "unknown".
 */
export type SynthesizeActivity = (input: SynthesizeInput) => Promise<SynthesizeOutput>;
