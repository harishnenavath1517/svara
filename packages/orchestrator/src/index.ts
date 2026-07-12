import { LATENCY_BUDGET_MS } from "@svara/shared";

/**
 * Temporal turn workflow + activities: transcribe -> respond -> synthesize.
 * Built in Phase 1; see docs/ROADMAP.md and docs/ARCHITECTURE.md.
 *
 * The hops are activities with per-hop timeouts and retries set in these
 * options — not bare awaits inside the workflow (guardrail 6 in CLAUDE.md).
 * A hung LLM then times out into a filler instead of dead air, and barge-in
 * cancels the whole saga cleanly.
 *
 * Start-to-close is set well above the budget: the budget is what we hold the
 * pipeline to in eval, the timeout is when we give up on a call.
 */
export const ACTIVITY_TIMEOUTS_MS = {
  transcribe: LATENCY_BUDGET_MS.stt * 20,
  respond: LATENCY_BUDGET_MS.llm * 20,
  synthesize: LATENCY_BUDGET_MS.tts * 20,
} as const;

export const TASK_QUEUE = "svara-turns";
