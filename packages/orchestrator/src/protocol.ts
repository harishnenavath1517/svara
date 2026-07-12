import type { LanguageCode, TraceLanguage } from "@svara/shared";

/**
 * The internal channel between the gateway and the Temporal worker.
 *
 * Temporal activities take serializable arguments and return serializable
 * results — they cannot be handed a live microphone stream, and they cannot
 * yield audio back as they produce it. So the streams don't go through
 * Temporal at all:
 *
 *   gateway  --audio frames-->  worker (transcribe activity)
 *   worker   --transcripts, tokens, tts audio-->  gateway  --> client
 *
 * Temporal stays the control plane — it owns the turn's lifecycle, per-hop
 * timeouts, retries, and cancellation (guardrail 6). The gateway is the stream
 * broker. Audio rides as base64 in JSON: this hop is localhost, and the
 * simplicity is worth more than the ~33% overhead.
 */

/** Gateway → worker. */
export interface AudioFrame {
  t: "audio";
  trace_id: string;
  session_id: string;
  /** base64 PCM16 mono @ 16kHz — exactly what Saaras wants on the wire. */
  b64: string;
}

/** Gateway → worker: VAD says the caller stopped talking. Ends the STT stream. */
export interface AudioEndFrame {
  t: "audio_end";
  trace_id: string;
}

/**
 * Gateway → worker: barge-in. Abort every hop of this turn *now*.
 *
 * This is deliberately not left to Temporal's cancellation: that only reaches an
 * activity on a heartbeat response, and heartbeats are throttled to ~80% of the
 * heartbeat timeout. See the `abort` field in bus.ts for what that cost us.
 */
export interface CancelFrame {
  t: "cancel";
  trace_id: string;
}

export type GatewayFrame = AudioFrame | AudioEndFrame | CancelFrame;

/** Worker → gateway: transcript so far; `final` unblocks the LLM hop. */
export interface TranscriptFrame {
  t: "partial" | "final";
  trace_id: string;
  session_id: string;
  text: string;
  lang: TraceLanguage;
}

/**
 * Worker → gateway: the reply as the LLM writes it, for the live transcript.
 * Carries the reply *so far*, not the latest delta — so a retried `respond`
 * attempt overwrites the partial reply in the UI instead of doubling it.
 */
export interface TokenFrame {
  t: "token";
  trace_id: string;
  session_id: string;
  text: string;
}

/** Worker → gateway: the complete reply, once the LLM hop is done. */
export interface ReplyFrame {
  t: "reply";
  trace_id: string;
  session_id: string;
  text: string;
  lang: LanguageCode;
}

/** Worker → gateway: synthesized audio, forwarded straight to the caller. */
export interface TtsAudioFrame {
  t: "tts_audio";
  trace_id: string;
  session_id: string;
  /** base64 PCM16 mono @ TTS_SAMPLE_RATE. */
  b64: string;
}

export type WorkerFrame = TranscriptFrame | TokenFrame | ReplyFrame | TtsAudioFrame;

/** Where the worker dials the gateway. Localhost — never expose this publicly. */
export const INTERNAL_WS_PATH = "/internal";
