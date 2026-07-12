import { createHash } from "node:crypto";
import { MODELS, optionalEnv } from "@svara/shared";
import type { SttMode } from "@svara/shared";

export const TASK_QUEUE = optionalEnv("TEMPORAL_TASK_QUEUE", "svara-turns");

/** Started by name so the gateway never imports workflow code. */
export const TURN_WORKFLOW = "turnWorkflow";

/**
 * Real call audio is Hinglish/Tanglish mid-sentence — that's the whole point of
 * the domain. `verbatim` is for building golden ground truth, not for serving.
 */
export const DEFAULT_STT_MODE: SttMode = "codemix";

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
 * Identical across every hop of a run, so eval metrics attribute to one exact
 * configuration (docs/DATA_CONTRACTS.md). Anything that can change an output
 * belongs in here.
 */
export const CONFIG_HASH = `sha256:${createHash("sha256")
  .update(
    JSON.stringify({
      stt: MODELS.stt,
      stt_mode: DEFAULT_STT_MODE,
      llm: optionalEnv("LLM_MODEL", MODELS.llm),
      tts: MODELS.tts,
      prompt_version: PROMPT_VERSION,
    }),
  )
  .digest("hex")}`;
