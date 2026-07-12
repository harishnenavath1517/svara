import { MODELS } from "@svara/shared";
import type { LanguageCode } from "@svara/shared";
import WebSocket from "ws";
import { authHeaders, SarvamError, type SarvamClientConfig } from "./config.js";
import { AsyncQueue } from "./stream.js";

/**
 * Bulbul v3 streaming TTS over WebSocket — wss://api.sarvam.ai/text-to-speech/ws.
 * Spec: docs/SARVAM_API.md. bulbul:v1 is deprecated; MODELS.tts only (guardrail 1).
 *
 * We ask for `linear16`: headerless PCM16, so chunks concatenate and play as they
 * land. A container format (wav/mp3) would put a header on every chunk and the
 * client would have to decode each one separately.
 */
export const TTS_SAMPLE_RATE = 24000;
export const TTS_CODEC = "linear16";

/** bulbul:v3 default speaker. Speaker names are lowercase and case-sensitive. */
export const DEFAULT_SPEAKER = "shubh";

export interface SynthesizeOptions {
  /** "unknown" is not synthesizable — resolve the language before calling. */
  lang: LanguageCode;
  speaker?: string;
  /** 0.5–2.0. */
  pace?: number;
  signal: AbortSignal;
}

interface TtsMessage {
  type: "audio" | "error";
  data?: {
    audio?: string;
    content_type?: string;
    error?: string;
    code?: string;
  };
}

/**
 * How long to keep the socket open after the last sentence is flushed, waiting
 * for the audio tail. Bulbul doesn't send an end-of-stream message, so quiet is
 * the only signal we have. This delays the hop's *completion*, never playback —
 * chunks are yielded the moment they arrive.
 */
const TAIL_QUIET_MS = 2000;

/**
 * Consumes sentences as the LLM produces them and yields PCM16 chunks as Bulbul
 * produces those. Both ends stream: the first chunk of sentence 1 is on its way
 * to the caller while the model is still writing sentence 2.
 */
export async function* synthesize(
  sentences: AsyncIterable<string>,
  opts: SynthesizeOptions,
  config: SarvamClientConfig,
): AsyncIterable<Uint8Array> {
  const url = new URL(`${config.wsBaseUrl}/text-to-speech/ws`);
  url.searchParams.set("model", MODELS.tts);

  const socket = new WebSocket(url, { headers: authHeaders(config) });
  const events = new AsyncQueue<TtsMessage>();
  let tailTimer: NodeJS.Timeout | null = null;

  socket.on("message", (raw: Buffer) => {
    if (tailTimer !== null) tailTimer.refresh();
    try {
      events.push(JSON.parse(raw.toString("utf8")) as TtsMessage);
    } catch {
      // Ignore unparseable frames rather than drop the audio we already have.
    }
  });
  socket.on("error", (err) => events.fail(err));
  socket.on("close", () => events.close());

  const onAbort = (): void => {
    socket.close(1000, "cancelled");
    events.fail(opts.signal.reason ?? new Error("cancelled"));
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });

  const pump = (async () => {
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "config",
        data: {
          model: MODELS.tts,
          target_language_code: opts.lang,
          speaker: opts.speaker ?? DEFAULT_SPEAKER,
          pace: opts.pace ?? 1.0,
          speech_sample_rate: String(TTS_SAMPLE_RATE),
          output_audio_codec: TTS_CODEC,
        },
      }),
    );
    for await (const sentence of sentences) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "text", data: { text: sentence } }));
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "flush" }));
    tailTimer = setTimeout(() => socket.close(1000, "done"), TAIL_QUIET_MS);
  })().catch((err: unknown) => events.fail(err));

  try {
    for await (const message of events) {
      if (message.type === "error") {
        throw new SarvamError(
          message.data?.code ?? "tts_error",
          message.data?.error ?? "text-to-speech stream failed",
        );
      }
      const audio = message.data?.audio;
      if (message.type !== "audio" || audio === undefined || audio.length === 0) continue;
      yield new Uint8Array(Buffer.from(audio, "base64"));
    }
  } finally {
    if (tailTimer !== null) clearTimeout(tailTimer);
    opts.signal.removeEventListener("abort", onAbort);
    socket.close();
    await pump.catch(() => undefined);
  }
}

function once(socket: WebSocket, event: "open"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once(event, () => resolve());
    socket.once("error", reject);
    socket.once("close", () => reject(new SarvamError("tts_closed", "socket closed before open")));
  });
}
