import { CancellationScope, proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { TurnArgs, TurnResult } from "./turn.js";

/**
 * The turn saga. One workflow per caller utterance.
 *
 * The three hops run *concurrently*, not in sequence — they hand off through the
 * turn bus (see bus.ts) while each is still producing. What Temporal owns is the
 * turn's lifecycle: each hop is an activity with its own timeout, its own retry
 * policy, and cancellation that actually reaches it (guardrail 6). A hung LLM
 * times out into a failed turn instead of dead air; barge-in cancels the whole
 * saga, mid-hop, in one call.
 *
 * Only type imports here: workflow code is bundled into a deterministic sandbox,
 * so nothing with a side effect may cross this boundary.
 */

/**
 * Start-to-close is deliberately far above the latency budget: the budget is
 * what eval holds the pipeline to, the timeout is when we give up on the call.
 * STT's clock covers a long utterance; the LLM's is the one that catches a hang.
 */
const { transcribe } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  // Liveness only. Barge-in does NOT ride on this: Temporal delivers cancellation
  // on a heartbeat response, and heartbeats are throttled to ~80% of this value —
  // seconds, not milliseconds. The gateway aborts the hops in-band instead (bus.ts).
  heartbeatTimeout: "60 seconds",
  // The audio is consumed as it streams. A second attempt has nothing to hear.
  retry: { maximumAttempts: 1 },
});

const { respond } = proxyActivities<typeof activities>({
  startToCloseTimeout: "45 seconds",
  // Liveness only. Barge-in does NOT ride on this: Temporal delivers cancellation
  // on a heartbeat response, and heartbeats are throttled to ~80% of this value —
  // seconds, not milliseconds. The gateway aborts the hops in-band instead (bus.ts).
  heartbeatTimeout: "60 seconds",
  // Safe to retry: it re-reads the transcript off the bus and its only side
  // effect is a cumulative live-transcript frame, which overwrites.
  retry: { maximumAttempts: 3, initialInterval: "200ms", maximumInterval: "2 seconds" },
});

const { synthesize } = proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  // Liveness only. Barge-in does NOT ride on this: Temporal delivers cancellation
  // on a heartbeat response, and heartbeats are throttled to ~80% of this value —
  // seconds, not milliseconds. The gateway aborts the hops in-band instead (bus.ts).
  heartbeatTimeout: "60 seconds",
  // The activity itself refuses a retry once the caller has heard audio.
  retry: { maximumAttempts: 2, initialInterval: "200ms" },
});

const { endTurn } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 1 },
});

export async function turnWorkflow(args: TurnArgs): Promise<TurnResult> {
  try {
    // One node's config to one activity, straight through. The workflow resolves
    // no defaults of its own — a default applied here would be a difference in
    // output that `ctx.config_hash` never attested to.
    const [stt, llm, tts] = await Promise.all([
      transcribe({ ctx: args.ctx, stt: args.flow.stt }),
      respond({ ctx: args.ctx, history: args.history, llm: args.flow.llm }),
      synthesize({ ctx: args.ctx, tts: args.flow.tts }),
    ]);
    return {
      transcript: stt.text,
      reply: llm.text,
      lang: llm.lang,
      firstAudioMs: tts.ttfb_ms,
    };
  } finally {
    // Barge-in cancels this workflow mid-hop; the turn's buffers still have to go.
    await CancellationScope.nonCancellable(() => endTurn({ ctx: args.ctx }));
  }
}
