import type { FlowConfig, FlowPatch } from "./flow.js";
import type { LanguageCode, TraceLanguage } from "./languages.js";

/**
 * The client ↔ gateway WebSocket contract. Both ends import this, so the call UI
 * and the gateway cannot drift apart.
 *
 * Audio goes both ways as raw PCM16 mono, little-endian:
 *  - up:   binary WebSocket frames at MIC_SAMPLE_RATE (what Saaras wants).
 *  - down: base64 inside an `audio` message at TTS_OUTPUT_SAMPLE_RATE (headerless,
 *          so chunks concatenate and play as they land).
 * Control messages are JSON, in both directions.
 */

/** Mic capture rate. Saaras accepts 16000 or 8000; 16000 is the quality one. */
export const MIC_SAMPLE_RATE = 16000;

/** Bulbul v3 output rate we request. Must match packages/sarvam's TTS_SAMPLE_RATE. */
export const TTS_OUTPUT_SAMPLE_RATE = 24000;

/** Client → gateway: open the call. Send once, before any audio. */
export interface StartMessage {
  type: "start";
  /**
   * "unknown" (the default) lets saaras:v3 detect the caller's language.
   * Sugar for `flow.stt.lang`, kept because most callers only ever set this one.
   * If both are given, `flow.stt.lang` wins — it is the more specific statement.
   */
  lang?: TraceLanguage;
  /** Per-hop overrides. Sanitized by the gateway; the resolved flow comes back in `ready`. */
  flow?: FlowPatch;
}

/**
 * Client → gateway: retune the hops. Applies from the **next** turn — never to a
 * turn already in flight, whose traces have already claimed a config hash.
 * The gateway answers with `flow_ack` carrying what it actually resolved.
 */
export interface ConfigureMessage {
  type: "configure";
  flow: FlowPatch;
}

/** Client → gateway: hang up. */
export interface StopMessage {
  type: "stop";
}

export type ClientMessage = StartMessage | ConfigureMessage | StopMessage;

/** Gateway → client: the call is up, and this is the flow it will actually run. */
export interface ReadyMessage {
  type: "ready";
  session_id: string;
  flow: FlowConfig;
  config_hash: string;
}

/**
 * Gateway → client: the resolved flow, after sanitization.
 *
 * The client renders *this*, never its own optimistic copy. Ask for a bulbul:v2
 * speaker and the gateway hands back `shubh`; the canvas then shows `shubh`,
 * because a canvas that displays a config the server didn't run is worse than no
 * canvas at all. The `config_hash` is what the next turn's traces will carry — so
 * a knob that moves it is visibly a knob that puts the run in a different bucket.
 */
export interface FlowAckMessage {
  type: "flow_ack";
  flow: FlowConfig;
  config_hash: string;
}

/** Gateway → client: what the caller is saying, as Saaras hears it. */
export interface TranscriptMessage {
  type: "partial" | "final";
  trace_id: string;
  text: string;
  lang: TraceLanguage;
}

/** Gateway → client: the agent's reply so far. Replaces, never appends. */
export interface ReplyMessage {
  type: "reply";
  trace_id: string;
  text: string;
}

/** Gateway → client: play this now. */
export interface AudioMessage {
  type: "audio";
  trace_id: string;
  /** base64 PCM16 mono @ TTS_OUTPUT_SAMPLE_RATE. */
  b64: string;
}

/**
 * Gateway → client: barge-in. Drop every queued and playing buffer immediately —
 * the caller is talking, and the agent has to stop mid-word (guardrail 5).
 */
export interface StopAudioMessage {
  type: "stop_audio";
  trace_id: string;
}

/** Gateway → client: the turn is over, one way or another. */
export interface TurnEndMessage {
  type: "turn_end";
  trace_id: string;
  ok: boolean;
  /** Mic close → first audio out. The number the <800ms budget refers to. */
  first_audio_ms: number | null;
  total_latency_ms: number;
  lang: TraceLanguage;
  /** Set when the turn failed or was cancelled. */
  error: string | null;
}

export type ServerMessage =
  | ReadyMessage
  | FlowAckMessage
  | TranscriptMessage
  | ReplyMessage
  | AudioMessage
  | StopAudioMessage
  | TurnEndMessage;

/** bulbul:v3 speaks these; "unknown" is not synthesizable. */
export type SpeakableLanguage = LanguageCode;
