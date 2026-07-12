import { createHash } from "node:crypto";
import { DEFAULT_FLOW, flowFingerprint, sanitizeFlow, optionalEnv } from "@svara/shared";
import type { FlowConfig, SttMode } from "@svara/shared";

export const TASK_QUEUE = optionalEnv("TEMPORAL_TASK_QUEUE", "svara-turns");

/** Started by name so the gateway never imports workflow code. */
export const TURN_WORKFLOW = "turnWorkflow";

/**
 * Real call audio is Hinglish/Tanglish mid-sentence — that's the whole point of
 * the domain. `verbatim` is for building golden ground truth, not for serving.
 */
export const DEFAULT_STT_MODE: SttMode = DEFAULT_FLOW.stt.mode;

/** Bump whenever the prompt below changes: it feeds the config hash. */
export const PROMPT_VERSION = "1";

/**
 * Keeping the model from thinking out loud is not done here — the `/no_think`
 * prompt marker is a no-op on sarvam-30b (measured). It's the `thinking: false`
 * default in the Sarvam client's `chat()`, and the comment there is worth
 * reading before anyone tries to "fix" latency from this end.
 */
export const SYSTEM_PROMPT = [
  "You are a helpline agent for Indian government welfare schemes.",
  "Callers ask about eligibility, application status, how to apply, required documents, and grievances.",
  "Reply in the caller's language, matching their script and their code-mixing.",
  "Be brief: two short sentences, because your reply is spoken aloud, not read.",
  "If a scheme detail is not something you know, say so and offer to connect the caller to an officer.",
  "Never invent scheme names, amounts, deadlines, or application numbers.",
].join(" ");

export const GIT_SHA = optionalEnv("GIT_SHA", "dev");

/**
 * The flow a call runs with when the client asks for nothing — the shipped
 * configuration, with the deployment's env overlaid on it.
 *
 * It goes through `sanitizeFlow` like any other input. Env is not more
 * trustworthy than a browser, it is merely differently untrustworthy: a typo in
 * `TTS_SPEAKER` would otherwise reach bulbul and 400 every call in production,
 * and the failure would look like a Sarvam outage rather than a config error.
 */
export function serverDefaultFlow(): FlowConfig {
  return sanitizeFlow(
    {
      llm: { model: optionalEnv("LLM_MODEL", DEFAULT_FLOW.llm.model) },
      tts: { speaker: optionalEnv("TTS_SPEAKER", DEFAULT_FLOW.tts.speaker) },
    },
    DEFAULT_FLOW,
  );
}

/**
 * The trace's claim about *which configuration produced this number*
 * (docs/DATA_CONTRACTS.md). It must be identical across every hop of a turn, and
 * it must differ the moment anything that can change an output differs.
 *
 * This used to be a module constant, and that was safe only for exactly as long
 * as the configuration was a module constant too. The `/flow` canvas ended that:
 * a caller can now retune the LLM's temperature or the STT mode between turns,
 * and a fixed hash would have filed those turns' traces under the baseline
 * configuration's name — quietly poisoning every latency percentile and every
 * run-over-run diff downstream, with nothing anywhere to detect it. The hash is a
 * function of the flow now, because the flow is a variable now.
 */
export function configHashOf(flow: FlowConfig): string {
  return `sha256:${createHash("sha256").update(flowFingerprint(flow, PROMPT_VERSION)).digest("hex")}`;
}

/**
 * The hash of the shipped configuration. This is what the offline eval stamps on
 * its runs — the harness calls the hops directly with the defaults, so this is a
 * true statement about what it measured.
 */
export const CONFIG_HASH = configHashOf(serverDefaultFlow());
