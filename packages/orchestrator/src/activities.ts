import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  chat,
  createConfig,
  sentences as toSentences,
  synthesize as ttsSynthesize,
  transcribe as sttTranscribe,
  TTS_SAMPLE_RATE,
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
import { AudioTee, audioCaptureEnabled } from "./audio-capture.js";
import { disposeTurnBus, turnBus } from "./bus.js";
import { SYSTEM_PROMPT } from "./config.js";
import { gatewayChannel } from "./gateway-channel.js";
import { emitTrace, toTraceError } from "./trace.js";

/** What the gateway captures from the caller's mic, and what Saaras expects. */
const CALLER_SAMPLE_RATE = 16000;

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
  const { ctx, stt } = input;
  const bus = turnBus(ctx.trace_id);
  const channel = gatewayChannel();
  const activity = Context.current();
  const startedAt = Date.now();

  let ttfb: number | null = null;
  let text = "";
  let lang: TraceLanguage = stt.lang;

  // Tees the caller's audio on its way to Saaras. Passive: it never holds a frame
  // back, and the WAV is only written once the utterance has already ended.
  const tee = new AudioTee(audioCaptureEnabled());

  try {
    const stream = sttTranscribe(
      tee.tap(channel.audioStream(ctx.trace_id)),
      { lang: stt.lang, mode: stt.mode, signal: hopSignal(ctx.trace_id) },
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

    // Stop the clock BEFORE the blob write. Reading Date.now() after the await
    // would charge the disk write to the model and quietly corrupt every STT
    // latency percentile in the harness.
    const latency = Date.now() - startedAt;
    const inputRef = await tee.store(ctx.session_id, ctx.trace_id, "stt", "in", CALLER_SAMPLE_RATE);

    emitTrace(ctx, {
      hop: "stt",
      lang,
      model: MODELS.stt,
      mode: stt.mode,
      input_ref: inputRef,
      text_out: text,
      latency_ms: latency,
      ttfb_ms: ttfb,
    });
    return { text, lang };
  } catch (err) {
    const latency = Date.now() - startedAt;
    bus.transcripts.fail(err);
    // Store what we heard even on failure: the audio behind a failed
    // transcription is the single most useful row in the eval set.
    const inputRef = await tee.store(ctx.session_id, ctx.trace_id, "stt", "in", CALLER_SAMPLE_RATE);

    emitTrace(ctx, {
      hop: "stt",
      lang,
      model: MODELS.stt,
      mode: stt.mode,
      input_ref: inputRef,
      text_out: text.length > 0 ? text : null,
      latency_ms: latency,
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
  const { ctx, llm: llmConfig } = input;
  const bus = turnBus(ctx.trace_id);
  const channel = gatewayChannel();
  const activity = Context.current();

  // Two clocks, and the distinction is the whole point of `ttfb_ms`.
  //
  //   waitStartedAt — activity start, i.e. how long this hop was ALIVE, including
  //                   the time it sat blocked waiting for STT to finalize.
  //   genStartedAt  — when the model was actually asked for a token.
  //
  // The LLM's latency and TTFB are measured from the second one. Measuring them
  // from the first would fold the caller's speaking time into "LLM latency" and
  // make the model look ten times slower than it is — the exact mistake the live
  // STT traces make, and the reason docs/EVAL_STRATEGY.md warns about it.
  const waitStartedAt = Date.now();
  let genStartedAt = waitStartedAt;
  let ttfb: number | null = null;
  let reply = "";
  let prompt = "";
  let lang: LanguageCode = DEFAULT_LANGUAGE;

  /**
   * Waiting for STT is INSIDE the try, and that is a deliberate fix, not a
   * refactor. It used to sit above it — which meant that if this hop failed or
   * stalled *here*, waiting for a transcript that never came, it emitted **no
   * trace at all**: no error, no latency, nothing. The turn simply vanished from
   * the eval plane, and guardrail 4 ("every hop emits a trace, even on failure")
   * was quietly false for one of the likeliest ways this hop can fail.
   *
   * Found while chasing a turn that hung after STT: the traces said the LLM hop
   * had never existed, which made the failure impossible to localise. The hang
   * turned out to be a stale gateway holding the port, not a bug in here — but a
   * blind spot that can hide a real hop failure is worth closing regardless of
   * what put us in front of it.
   */
  try {
    for await (const transcript of bus.transcripts.subscribe()) {
      activity.heartbeat();
      prompt = transcript.text;
      if (transcript.isFinal) break;
    }
    lang = await bus.lang.promise;
    genStartedAt = Date.now();
  } catch (err) {
    bus.sentences.fail(err);
    emitTrace(ctx, {
      hop: "llm",
      lang,
      // The model the flow actually ran, not the deployment's default. A trace
      // that names the wrong model is worse than a trace with no model at all.
      model: llmConfig.model,
      mode: null,
      text_in: null,
      text_out: null,
      // The hop never reached the model, so this is time spent waiting, not
      // generating. `stalled_before_llm` says exactly that rather than blaming
      // sarvam-30b for a turn it was never asked to answer.
      latency_ms: Date.now() - waitStartedAt,
      ttfb_ms: null,
      error: toTraceError(err),
    });
    return rethrow(ctx.trace_id, err);
  }

  if (prompt.trim().length === 0) {
    // Nothing intelligible — say so rather than prompting the model with "".
    bus.sentences.close();
    emitTrace(ctx, {
      hop: "llm",
      lang,
      // The model the flow actually ran, not the deployment's default. A trace
      // that names the wrong model is worse than a trace with no model at all.
      model: llmConfig.model,
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
    const tokens = chat(
      messages,
      {
        model: llmConfig.model,
        temperature: llmConfig.temperature,
        maxTokens: llmConfig.maxTokens,
        // `false` for every call the helpline serves — DEFAULT_FLOW says so, and
        // chat() would default it off anyway. It is a knob at all only so the
        // /flow canvas can demonstrate the cost: sarvam-30b's reasoning tokens
        // are billed against maxTokens *before* the reply, and at 512 it never
        // reaches a first word (packages/sarvam/src/chat.ts). Turning it on is a
        // config change, so the turn's traces carry a different config_hash and
        // cannot contaminate the baseline.
        thinking: llmConfig.thinking,
        signal: hopSignal(ctx.trace_id),
      },
      config,
    );
    for await (const sentence of toSentences(tokens)) {
      ttfb ??= Date.now() - genStartedAt;
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
      // The model the flow actually ran, not the deployment's default. A trace
      // that names the wrong model is worse than a trace with no model at all.
      model: llmConfig.model,
      mode: null,
      text_in: prompt,
      text_out: reply,
      rag_context_ids: [],
      latency_ms: Date.now() - genStartedAt,
      ttfb_ms: ttfb,
    });
    return { text: reply, lang, ragContextIds: [] };
  } catch (err) {
    bus.sentences.fail(err);
    emitTrace(ctx, {
      hop: "llm",
      lang,
      // The model the flow actually ran, not the deployment's default. A trace
      // that names the wrong model is worse than a trace with no model at all.
      model: llmConfig.model,
      mode: null,
      text_in: prompt,
      text_out: reply.length > 0 ? reply : null,
      rag_context_ids: [],
      latency_ms: Date.now() - genStartedAt,
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
  const { ctx, tts } = input;
  const bus = turnBus(ctx.trace_id);
  const channel = gatewayChannel();
  const activity = Context.current();

  const lang = await bus.lang.promise;
  const startedAt = Date.now();

  let ttfb: number | null = null;
  let chunks = 0;
  let bytes = 0;
  let spoken = "";

  const tee = new AudioTee(audioCaptureEnabled());

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
        // Already sanitized against the v3 roster by the gateway, so a v2 speaker
        // can't reach bulbul and 400 the call halfway through the reply.
        speaker: tts.speaker,
        pace: tts.pace,
        signal: hopSignal(ctx.trace_id),
      },
      config,
    );
    for await (const chunk of audio) {
      ttfb ??= Date.now() - startedAt;
      activity.heartbeat();
      chunks += 1;
      bytes += chunk.byteLength;
      // Forward to the caller FIRST, capture second. The recorder never sits
      // between Bulbul and the person waiting to hear the answer.
      channel.send({
        t: "tts_audio",
        trace_id: ctx.trace_id,
        session_id: ctx.session_id,
        b64: Buffer.from(chunk).toString("base64"),
      });
      tee.push(chunk);
    }

    const latency = Date.now() - startedAt;
    const outputRef = await tee.store(ctx.session_id, ctx.trace_id, "tts", "out", TTS_SAMPLE_RATE);

    emitTrace(ctx, {
      hop: "tts",
      lang,
      model: MODELS.tts,
      mode: null,
      text_in: spoken,
      output_ref: outputRef,
      latency_ms: latency,
      ttfb_ms: ttfb,
    });
    return { chunks, bytes, ttfb_ms: ttfb };
  } catch (err) {
    const latency = Date.now() - startedAt;
    // On barge-in this keeps the audio the caller actually heard before they cut
    // in — which is the entire evidence base for "why did they interrupt?".
    const outputRef = await tee.store(ctx.session_id, ctx.trace_id, "tts", "out", TTS_SAMPLE_RATE);

    emitTrace(ctx, {
      hop: "tts",
      lang,
      model: MODELS.tts,
      mode: null,
      text_in: spoken.length > 0 ? spoken : null,
      output_ref: outputRef,
      latency_ms: latency,
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
