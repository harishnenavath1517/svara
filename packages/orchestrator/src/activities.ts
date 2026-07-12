import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  chat,
  createConfig,
  DEFAULT_SPEAKER,
  sentences as toSentences,
  synthesize as ttsSynthesize,
  transcribe as sttTranscribe,
} from "@svara/sarvam";
import { MODELS, isLanguageCode, optionalEnv } from "@svara/shared";
import type {
  ChatMessage,
  LanguageCode,
  RespondInput,
  RespondOutput,
  SynthesizeInput,
  SynthesizeOutput,
  TraceLanguage,
  TranscribeInput,
  TranscribeOutput,
  TurnContext,
} from "@svara/shared";
import { disposeTurnBus, turnBus } from "./bus.js";
import { SYSTEM_PROMPT } from "./config.js";
import { gatewayChannel } from "./gateway-channel.js";
import { emitTrace, toTraceError } from "./trace.js";

/**
 * The three hops, as Temporal activities. Each one:
 *   - streams (never buffers its input to completion before starting),
 *   - emits exactly one trace event, on success and on failure alike,
 *   - heartbeats, so barge-in cancellation actually reaches it mid-call.
 *
 * Timeouts and retry policy live on the workflow's activity options, never in
 * these bodies (guardrail 6).
 */
const config = createConfig();

/** Fallback when the caller's language never resolves — the helpline's default. */
const DEFAULT_LANGUAGE = optionalEnv("DEFAULT_LANGUAGE", "hi-IN") as LanguageCode;

/**
 * What a hop's Sarvam socket listens to: Temporal's cancellation (durable, but
 * only delivered on a throttled heartbeat) *and* the turn bus's barge-in abort
 * (instant, in-process). Barge-in needs the second one — see bus.ts.
 */
function hopSignal(traceId: string): AbortSignal {
  return AbortSignal.any([Context.current().cancellationSignal, turnBus(traceId).abort.signal]);
}

/**
 * A cancelled hop must not be retried: the caller has moved on to a new turn,
 * and a retry would just talk over them again.
 */
function rethrow(traceId: string, err: unknown): never {
  if (turnBus(traceId).abort.signal.aborted) {
    throw ApplicationFailure.create({
      message: "turn cancelled by barge-in",
      type: "TurnCancelled",
      nonRetryable: true,
    });
  }
  throw err;
}

/**
 * Caller audio (from the gateway) → Saaras v3 → transcripts (to the gateway, and
 * onto the bus for the LLM hop). Ends when the gateway's VAD closes the audio
 * stream, which is what makes Saaras finalize.
 */
export async function transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
  const { ctx } = input;
  const bus = turnBus(ctx.trace_id);
  const channel = gatewayChannel();
  const activity = Context.current();
  const startedAt = Date.now();

  let ttfb: number | null = null;
  let text = "";
  let lang: TraceLanguage = input.lang;

  try {
    const stream = sttTranscribe(
      channel.audioStream(ctx.trace_id),
      { lang: input.lang, mode: input.mode, signal: hopSignal(ctx.trace_id) },
      config,
    );
    for await (const transcript of stream) {
      ttfb ??= Date.now() - startedAt;
      activity.heartbeat();

      text = transcript.text;
      lang = transcript.lang;
      if (isLanguageCode(lang)) bus.lang.resolve(lang);
      bus.transcripts.push(transcript);
      channel.send({
        t: transcript.isFinal ? "final" : "partial",
        trace_id: ctx.trace_id,
        session_id: ctx.session_id,
        text: transcript.text,
        lang: transcript.lang,
      });
      if (transcript.isFinal) break;
    }
    // Unblocks the LLM hop even if the caller said nothing intelligible.
    bus.lang.resolve(isLanguageCode(lang) ? lang : DEFAULT_LANGUAGE);
    bus.transcripts.close();

    emitTrace(ctx, {
      hop: "stt",
      lang,
      model: MODELS.stt,
      mode: input.mode,
      text_out: text,
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
    });
    return { text, lang };
  } catch (err) {
    bus.transcripts.fail(err);
    emitTrace(ctx, {
      hop: "stt",
      lang,
      model: MODELS.stt,
      mode: input.mode,
      text_out: text.length > 0 ? text : null,
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
      error: toTraceError(err),
    });
    return rethrow(ctx.trace_id, err);
  }
}

/**
 * Transcript (from the bus) → sarvam-30b → sentences (onto the bus for TTS).
 *
 * Starts the moment STT marks a transcript final — which the gateway's VAD
 * triggers at the end of the utterance, not when the STT activity finishes
 * tearing its socket down. Sentences go onto the bus as they close, so TTS is
 * speaking sentence 1 while the model is still writing sentence 2.
 *
 * RAG grounding lands in Phase 2; `rag_context_ids` is honestly empty until then.
 */
export async function respond(input: RespondInput): Promise<RespondOutput> {
  const { ctx } = input;
  const bus = turnBus(ctx.trace_id);
  const channel = gatewayChannel();
  const activity = Context.current();

  let prompt = "";
  for await (const transcript of bus.transcripts.subscribe()) {
    activity.heartbeat();
    prompt = transcript.text;
    if (transcript.isFinal) break;
  }

  const lang = await bus.lang.promise;
  const startedAt = Date.now();
  let ttfb: number | null = null;
  let reply = "";

  if (prompt.trim().length === 0) {
    // Nothing intelligible — say so rather than prompting the model with "".
    bus.sentences.close();
    emitTrace(ctx, {
      hop: "llm",
      lang,
      model: optionalEnv("LLM_MODEL", MODELS.llm),
      mode: null,
      text_in: null,
      text_out: null,
      latency_ms: 0,
      error: { code: "empty_transcript", message: "no speech recognized in the utterance" },
    });
    return { text: "", lang, ragContextIds: [] };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...input.history,
    { role: "user", content: prompt },
  ];

  try {
    const tokens = chat(messages, { signal: hopSignal(ctx.trace_id) }, config);
    for await (const sentence of toSentences(tokens)) {
      ttfb ??= Date.now() - startedAt;
      activity.heartbeat();
      reply = reply.length === 0 ? sentence : `${reply} ${sentence}`;
      bus.sentences.push(sentence);
      // Cumulative, so a retried attempt overwrites the live transcript.
      channel.send({ t: "token", trace_id: ctx.trace_id, session_id: ctx.session_id, text: reply });
    }
    bus.sentences.close();

    channel.send({
      t: "reply",
      trace_id: ctx.trace_id,
      session_id: ctx.session_id,
      text: reply,
      lang,
    });
    emitTrace(ctx, {
      hop: "llm",
      lang,
      model: optionalEnv("LLM_MODEL", MODELS.llm),
      mode: null,
      text_in: prompt,
      text_out: reply,
      rag_context_ids: [],
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
    });
    return { text: reply, lang, ragContextIds: [] };
  } catch (err) {
    bus.sentences.fail(err);
    emitTrace(ctx, {
      hop: "llm",
      lang,
      model: optionalEnv("LLM_MODEL", MODELS.llm),
      mode: null,
      text_in: prompt,
      text_out: reply.length > 0 ? reply : null,
      rag_context_ids: [],
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
      error: toTraceError(err),
    });
    return rethrow(ctx.trace_id, err);
  }
}

/**
 * Sentences (from the bus) → Bulbul v3 → PCM chunks (to the gateway, which
 * forwards them to the caller as they arrive). Subscribes before the LLM has
 * written anything, and blocks on the bus until sentence 1 closes.
 */
export async function synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const { ctx } = input;
  const bus = turnBus(ctx.trace_id);
  const channel = gatewayChannel();
  const activity = Context.current();

  const lang = await bus.lang.promise;
  const startedAt = Date.now();

  let ttfb: number | null = null;
  let chunks = 0;
  let bytes = 0;
  let spoken = "";

  try {
    const sentences = (async function* () {
      for await (const sentence of bus.sentences.subscribe()) {
        spoken = spoken.length === 0 ? sentence : `${spoken} ${sentence}`;
        yield sentence;
      }
    })();

    const audio = ttsSynthesize(
      sentences,
      {
        lang,
        speaker: input.speaker ?? optionalEnv("TTS_SPEAKER", DEFAULT_SPEAKER),
        pace: input.pace,
        signal: hopSignal(ctx.trace_id),
      },
      config,
    );
    for await (const chunk of audio) {
      ttfb ??= Date.now() - startedAt;
      activity.heartbeat();
      chunks += 1;
      bytes += chunk.byteLength;
      channel.send({
        t: "tts_audio",
        trace_id: ctx.trace_id,
        session_id: ctx.session_id,
        b64: Buffer.from(chunk).toString("base64"),
      });
    }

    emitTrace(ctx, {
      hop: "tts",
      lang,
      model: MODELS.tts,
      mode: null,
      text_in: spoken,
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
    });
    return { chunks, bytes, ttfb_ms: ttfb };
  } catch (err) {
    emitTrace(ctx, {
      hop: "tts",
      lang,
      model: MODELS.tts,
      mode: null,
      text_in: spoken.length > 0 ? spoken : null,
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
      error: toTraceError(err),
    });
    // Retrying after the caller has already heard half the reply would speak it
    // twice. Only a hop that produced no audio is safe to retry.
    if (chunks > 0 && !turnBus(ctx.trace_id).abort.signal.aborted) {
      throw ApplicationFailure.create({
        message: `tts failed after ${chunks} chunks; not retryable`,
        type: "TtsPartialFailure",
        nonRetryable: true,
        cause: err instanceof Error ? err : undefined,
      });
    }
    return rethrow(ctx.trace_id, err);
  }
}

/**
 * Turn teardown. The workflow calls this in a non-cancellable finally, so it
 * runs on the barge-in path too — otherwise the bus and any buffered audio for
 * an abandoned turn stay in the worker's memory for the life of the process.
 */
export async function endTurn(input: { ctx: TurnContext }): Promise<void> {
  disposeTurnBus(input.ctx.trace_id);
  gatewayChannel().discard(input.ctx.trace_id);
  return Promise.resolve();
}
