import type { ChatMessage, FlowConfig, LanguageCode, TurnContext } from "@svara/shared";

/**
 * The turn workflow's signature, kept out of workflows.ts so the gateway can
 * import it without loading workflow code — `proxyActivities` at module scope
 * throws outside the workflow sandbox.
 */
export interface TurnArgs {
  ctx: TurnContext;
  /**
   * The resolved flow — already sanitized by the gateway, and already hashed into
   * `ctx.config_hash`. The workflow hands each node's slice to its activity and
   * adds nothing of its own: if a knob could be applied here instead, it would be
   * a knob the config hash never saw.
   */
  flow: FlowConfig;
  /** Prior turns of the conversation, oldest first. */
  history: ChatMessage[];
}

export interface TurnResult {
  transcript: string;
  reply: string;
  lang: LanguageCode;
  /** Latency from the TTS hop starting to the first audio chunk. */
  firstAudioMs: number | null;
}
