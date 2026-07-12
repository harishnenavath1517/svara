import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  chat,
  transcribe,
  synthesize,
  TTS_SAMPLE_RATE,
  type SarvamClientConfig,
} from "@svara/sarvam";
import { decodeWav, repoRoot, resamplePcm16, MODELS, optionalEnv } from "@svara/shared";
import type { ChatMessage, LanguageCode, SttMode } from "@svara/shared";
import { SYSTEM_PROMPT } from "@svara/orchestrator";
import type { GoldenRecord } from "./golden.js";

/**
 * Replays one golden record through the hops and reports what each one produced,
 * with timings. This is the eval plane's own copy of the pipeline — it does not
 * go through Temporal or the gateway, because it is scoring the *models*, not the
 * orchestration, and dragging a workflow engine into a scorer would buy nothing
 * but flakes.
 *
 * **Timing note that matters more than it looks.** STT is timed from the first
 * audio frame we feed, not from the hop's wall clock. In a live trace, the STT
 * hop's `latency_ms` spans the caller actually speaking — Saaras emits nothing
 * until the VAD endpoint triggers a flush — so the 5.2s we see in production
 * traces is a human talking, not a slow model. Timing it that way here would make
 * "STT latency" a measure of how long the golden clips are. Feeding the audio as
 * fast as the socket takes it and timing from the first frame gives a number that
 * actually moves when the model does.
 */

const CALLER_SAMPLE_RATE = 16000;
/** 20ms frames, like the gateway's mic capture. */
const FRAME_BYTES = (CALLER_SAMPLE_RATE / 1000) * 20 * 2;

export interface HopResult<T> {
  value: T;
  latency_ms: number;
  ttfb_ms: number | null;
  error: { code: string; message: string } | null;
}

export interface ReplayResult {
  record: GoldenRecord;
  /** Production mode: what the live loop would have heard. */
  stt: HopResult<string>;
  /** `translit` mode: the script-invariant cross-check. */
  sttRomanized: HopResult<string>;
  /** `translate` mode: Indic speech in, English text out. The translation hop. */
  translation: HopResult<string>;
  /** The agent's reply to the transcript the STT hop actually produced. */
  reply: HopResult<string>;
  /** Round-trip: the reply spoken by Bulbul, then heard back by Saaras. */
  roundTrip: HopResult<string> | null;
}

async function timed<T>(fn: (mark: () => void) => Promise<T>, empty: T): Promise<HopResult<T>> {
  const startedAt = Date.now();
  let ttfb: number | null = null;
  const mark = (): void => {
    ttfb ??= Date.now() - startedAt;
  };
  try {
    const value = await fn(mark);
    return { value, latency_ms: Date.now() - startedAt, ttfb_ms: ttfb, error: null };
  } catch (err) {
    return {
      value: empty,
      latency_ms: Date.now() - startedAt,
      ttfb_ms: ttfb,
      // A failed hop is scored as a failure, not dropped. Failed turns are the
      // most valuable rows in the set (docs/EVAL_STRATEGY.md §6).
      error: {
        code: err !== null && typeof err === "object" && "code" in err ? String(err.code) : "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function frames(pcm: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < pcm.byteLength; i += FRAME_BYTES) {
      yield pcm.subarray(i, Math.min(i + FRAME_BYTES, pcm.byteLength));
    }
  })();
}

async function runStt(
  pcm: Uint8Array,
  lang: LanguageCode,
  mode: SttMode,
  config: SarvamClientConfig,
  signal: AbortSignal,
): Promise<HopResult<string>> {
  return timed(async (mark) => {
    let text = "";
    for await (const t of transcribe(
      frames(pcm),
      { lang, mode, sampleRate: CALLER_SAMPLE_RATE, signal },
      config,
    )) {
      mark();
      text = t.text;
      if (t.isFinal) break;
    }
    return text;
  }, "");
}

/** Loads the golden clip. Refs are repo-relative, so anchor them at the repo root
 * rather than at cwd — every package runs from its own directory. */
async function loadClip(record: GoldenRecord): Promise<Uint8Array> {
  const path = resolve(repoRoot(), record.audio_ref);
  return decodeWav(new Uint8Array(await readFile(path))).pcm;
}

export async function replay(
  record: GoldenRecord,
  config: SarvamClientConfig,
  signal: AbortSignal,
): Promise<ReplayResult> {
  const pcm = await loadClip(record);
  const lang = record.lang;

  // Sequential, not parallel. Firing three sockets at Saaras at once is exactly
  // what made the golden build return empty transcripts — and an empty transcript
  // is indistinguishable from "the caller said nothing", so a rate limiter would
  // silently score as a 100% model error.
  const stt = await runStt(pcm, lang, "codemix", config, signal);
  const sttRomanized = await runStt(pcm, lang, "translit", config, signal);
  const translation = await runStt(pcm, lang, "translate", config, signal);

  const reply = await timed(async (mark) => {
    // Fed the transcript the STT hop actually produced, ASR errors and all — this
    // is the reply the caller would really have received, not the reply the model
    // would give a perfect transcript it will never see in production.
    if (stt.value.trim().length === 0) throw new Error("no transcript to respond to");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: stt.value },
    ];
    let text = "";
    for await (const delta of chat(
      messages,
      { model: optionalEnv("LLM_MODEL", MODELS.llm), signal },
      config,
    )) {
      mark();
      text += delta;
    }
    return text.trim();
  }, "");

  const roundTrip =
    reply.value.length === 0 ? null : await runRoundTrip(reply.value, lang, config, signal);

  return { record, stt, sttRomanized, translation, reply, roundTrip };
}

/**
 * Round-trip intelligibility: speak the reply with Bulbul, hear it back with
 * Saaras, and (later) score WER against the text we asked it to say.
 *
 * High round-trip WER means the voice is mangling words even when it "sounds
 * fine" to a listener who already knows what it was supposed to say — which is
 * the failure mode a human spot-check is worst at catching and a caller is worst
 * affected by.
 */
async function runRoundTrip(
  text: string,
  lang: LanguageCode,
  config: SarvamClientConfig,
  signal: AbortSignal,
): Promise<HopResult<string>> {
  return timed(async (mark) => {
    const chunks: Uint8Array[] = [];
    const sentences = (async function* () {
      yield text;
    })();

    for await (const chunk of synthesize(sentences, { lang, signal }, config)) {
      mark();
      chunks.push(chunk);
    }
    if (chunks.length === 0) throw new Error("bulbul produced no audio for the reply");

    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const pcm24k = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm24k.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Bulbul speaks at 24kHz, Saaras listens at 16kHz. Down-sampling without the
    // anti-alias filter in resamplePcm16 would fold 8-12kHz energy back into the
    // speech band and report the resulting garbage as a TTS regression.
    const pcm16k = resamplePcm16(pcm24k, TTS_SAMPLE_RATE, CALLER_SAMPLE_RATE);

    // `transcribe` mode, not `codemix`: we are scoring intelligibility of the
    // agent's own speech, and want the plainest transcription of what it said.
    const heard = await runStt(pcm16k, lang, "transcribe", config, signal);
    if (heard.error !== null) throw new Error(heard.error.message);
    return heard.value;
  }, "");
}
