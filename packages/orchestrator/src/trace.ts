import { TOPICS, optionalEnv } from "@svara/shared";
import type { Hop, TraceEvent, TraceError, TurnContext, TurnEvent } from "@svara/shared";
import { Kafka, logLevel, type Producer } from "kafkajs";
import { CONFIG_HASH, GIT_SHA } from "./config.js";

/**
 * Trace emission to Redpanda. Every hop emits exactly one event, on success and
 * on failure alike — a failed turn is the most valuable row in the eval set, and
 * a missing trace is a bug, not an optimization (guardrail 4).
 *
 * Emission is fire-and-forget: Redpanda being down degrades the eval plane, it
 * must never drop a live call. Failures are logged loudly instead.
 */
const kafka = new Kafka({
  clientId: "svara-orchestrator",
  brokers: optionalEnv("REDPANDA_BROKERS", "localhost:19092").split(","),
  logLevel: logLevel.ERROR,
});

let producer: Producer | null = null;
let connecting: Promise<Producer> | null = null;

async function getProducer(): Promise<Producer> {
  if (producer !== null) return producer;
  connecting ??= (async () => {
    const next = kafka.producer({ allowAutoTopicCreation: true });
    await next.connect();
    producer = next;
    return next;
  })();
  return connecting;
}

export async function closeTraceProducer(): Promise<void> {
  await producer?.disconnect();
  producer = null;
  connecting = null;
}

async function publish(topic: string, key: string, value: unknown): Promise<void> {
  try {
    const active = await getProducer();
    // Key by session so a session's events stay ordered once we add partitions.
    await active.send({ topic, messages: [{ key, value: JSON.stringify(value) }] });
  } catch (err) {
    console.error(`[trace] failed to publish to ${topic}:`, err);
  }
}

/** Everything about a hop that isn't already in the turn context. */
export interface HopTrace {
  hop: Hop;
  lang: TraceEvent["lang"];
  model: string;
  mode: TraceEvent["mode"];
  text_in?: string | null;
  text_out?: string | null;
  input_ref?: string | null;
  output_ref?: string | null;
  rag_context_ids?: string[];
  latency_ms: number;
  ttfb_ms?: number | null;
  error?: TraceError | null;
}

export function emitTrace(ctx: TurnContext, hop: HopTrace): void {
  const event: TraceEvent = {
    trace_id: ctx.trace_id,
    session_id: ctx.session_id,
    turn_index: ctx.turn_index,
    hop: hop.hop,
    lang: hop.lang,
    model: hop.model,
    mode: hop.mode,
    input_ref: hop.input_ref ?? null,
    output_ref: hop.output_ref ?? null,
    text_in: hop.text_in ?? null,
    text_out: hop.text_out ?? null,
    rag_context_ids: hop.rag_context_ids ?? [],
    latency_ms: hop.latency_ms,
    ttfb_ms: hop.ttfb_ms ?? null,
    config_hash: ctx.config_hash,
    git_sha: ctx.git_sha,
    ts: new Date().toISOString(),
    error: hop.error ?? null,
  };
  void publish(TOPICS.traces, ctx.session_id, event);
}

export function emitTurn(event: TurnEvent): void {
  void publish(TOPICS.turns, event.session_id, event);
}

export function turnContext(
  sessionId: string,
  traceId: string,
  turnIndex: number,
): TurnContext {
  return {
    trace_id: traceId,
    session_id: sessionId,
    turn_index: turnIndex,
    config_hash: CONFIG_HASH,
    git_sha: GIT_SHA,
  };
}

/** Sarvam errors carry a code; anything else gets a generic one. */
export function toTraceError(err: unknown): TraceError {
  if (err !== null && typeof err === "object" && "code" in err && "message" in err) {
    return { code: String(err.code), message: String(err.message) };
  }
  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}
