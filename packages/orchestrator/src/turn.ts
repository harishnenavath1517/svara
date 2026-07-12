import type { ChatMessage, LanguageCode, SttMode, TraceLanguage, TurnContext } from "@svara/shared";

/**
 * The turn workflow's signature, kept out of workflows.ts so the gateway can
 * import it without loading workflow code — `proxyActivities` at module scope
 * throws outside the workflow sandbox.
 */
export interface TurnArgs {
  ctx: TurnContext;
  /** "unknown" lets saaras:v3 detect the caller's language. */
  lang: TraceLanguage;
  mode: SttMode;
  /** Prior turns of the conversation, oldest first. */
  history: ChatMessage[];
  speaker?: string;
}

export interface TurnResult {
  transcript: string;
  reply: string;
  lang: LanguageCode;
  /** Latency from the TTS hop starting to the first audio chunk. */
  firstAudioMs: number | null;
}
