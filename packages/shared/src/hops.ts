import type { SttMode } from "./constants.js";
import type { LanguageCode, TraceLanguage } from "./languages.js";

/**
 * Temporal activity signatures for the turn saga. Contract:
 * docs/DATA_CONTRACTS.md.
 *
 * Each activity is pure with respect to the workflow: typed in, typed out, and
 * exactly one trace event emitted as a side effect. Per-hop timeouts and retry
 * policy belong on the Temporal activity options, never inside the body.
 *
 * Every hop streams. Partial transcripts feed the LLM; the LLM's first sentence
 * feeds TTS. Buffering a hop to completion blows the <800ms first-audio budget.
 */

/** Correlation carried through every hop of one turn, and onto its traces. */
export interface TurnContext {
  trace_id: string;
  session_id: string;
  turn_index: number;
  config_hash: string;
  git_sha: string;
}

export interface TranscribeOptions {
  /** Pass "unknown" to let saaras:v3 auto-detect. */
  lang: TraceLanguage;
  /** "codemix" for real call audio; "verbatim" when building golden truth. */
  mode: SttMode;
}

/** One STT emission. Partials arrive with isFinal=false and must not be awaited. */
export interface Transcript {
  text: string;
  lang: TraceLanguage;
  isFinal: boolean;
}

export type TranscribeActivity = (
  audio: AsyncIterable<Uint8Array>,
  opts: TranscribeOptions,
  ctx: TurnContext,
) => AsyncIterable<Transcript>;

export interface RespondOptions {
  lang: TraceLanguage;
  /** Prior turns, oldest first. */
  history: ChatMessage[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RespondResult {
  /** Reply tokens as they generate. Cut sentences off this and start TTS. */
  tokenStream: AsyncIterable<string>;
  /** Qdrant point ids retrieved to ground this reply; [] if RAG was skipped. */
  ragContextIds: string[];
}

export type RespondActivity = (
  text: string,
  opts: RespondOptions,
  ctx: TurnContext,
) => Promise<RespondResult>;

export interface SynthesizeOptions {
  /** bulbul:v3 speaks the 11 SPEECH_LANGUAGES — "unknown" is not synthesizable. */
  lang: LanguageCode;
  /** Speaker names are lowercase and case-sensitive. Default: "shubh". */
  speaker: string;
  /** 0.5–2.0. */
  pace?: number;
}

export type SynthesizeActivity = (
  sentences: AsyncIterable<string>,
  opts: SynthesizeOptions,
  ctx: TurnContext,
) => AsyncIterable<Uint8Array>;
