import { MODELS } from "@svara/shared";
import type { SttMode, TraceLanguage, Transcript } from "@svara/shared";
import WebSocket from "ws";
import { authHeaders, SarvamError, type SarvamClientConfig } from "./config.js";
import { AsyncQueue } from "./stream.js";

/**
 * Saaras v3 streaming STT over WebSocket — wss://api.sarvam.ai/speech-to-text/ws.
 * Spec: docs/SARVAM_API.md. saarika:* is deprecated; MODELS.stt is the only id
 * that goes on the wire (guardrail 1).
 */
export interface TranscribeOptions {
  /** "unknown" lets saaras:v3 auto-detect the language. */
  lang: TraceLanguage;
  /** "codemix" for real call audio; "verbatim" when building golden truth. */
  mode: SttMode;
  /** Must match the PCM the gateway captures. Saaras accepts 16000 or 8000. */
  sampleRate?: 16000 | 8000;
  /** Barge-in and Temporal cancellation both arrive here. */
  signal: AbortSignal;
}

interface SttMessage {
  type: "data" | "error" | "events";
  data?: {
    transcript?: string;
    language_code?: string | null;
    error?: string;
    code?: string;
  };
}

/**
 * Streams raw PCM16 mono frames up and transcripts down. Transcripts are
 * cumulative for the utterance: each yield is the best transcript so far, and
 * the last one (after the audio ends and we flush) is `isFinal`.
 *
 * The caller must end `audio` at the VAD endpoint — that's what triggers the
 * flush, and the final transcript is what unblocks the LLM hop.
 */
export async function* transcribe(
  audio: AsyncIterable<Uint8Array>,
  opts: TranscribeOptions,
  config: SarvamClientConfig,
): AsyncIterable<Transcript> {
  const sampleRate = opts.sampleRate ?? 16000;
  const url = new URL(`${config.wsBaseUrl}/speech-to-text/ws`);
  url.searchParams.set("model", MODELS.stt);
  url.searchParams.set("mode", opts.mode);
  url.searchParams.set("language-code", opts.lang);
  url.searchParams.set("sample_rate", String(sampleRate));

  const socket = new WebSocket(url, { headers: authHeaders(config) });
  const events = new AsyncQueue<SttMessage>();
  let flushed = false;

  socket.on("message", (raw: Buffer) => {
    try {
      events.push(JSON.parse(raw.toString("utf8")) as SttMessage);
    } catch {
      // A frame we can't parse is not worth killing a live call over.
    }
  });
  socket.on("error", (err) => events.fail(err));
  socket.on("close", () => events.close());

  const onAbort = (): void => {
    socket.close(1000, "cancelled");
    events.fail(opts.signal.reason ?? new Error("cancelled"));
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });

  // Pump audio in the background: the transcript loop below must not wait on it.
  const pump = (async () => {
    await once(socket, "open");
    for await (const frame of audio) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          audio: {
            data: Buffer.from(frame).toString("base64"),
            sample_rate: String(sampleRate),
            encoding: "audio/wav",
          },
        }),
      );
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    // Force the model to finalize the partials it's sitting on.
    socket.send(JSON.stringify({ type: "flush" }));
    flushed = true;
  })().catch((err: unknown) => events.fail(err));

  let text = "";
  let lang: TraceLanguage = opts.lang;
  try {
    for await (const message of events) {
      if (message.type === "error") {
        throw new SarvamError(
          message.data?.code ?? "stt_error",
          message.data?.error ?? "speech-to-text stream failed",
        );
      }
      if (message.type !== "data") continue;
      const chunk = message.data?.transcript?.trim() ?? "";
      if (chunk.length === 0) continue;
      text = text.length === 0 ? chunk : `${text} ${chunk}`;
      const detected = message.data?.language_code;
      if (detected != null && detected.length > 0) lang = detected as TraceLanguage;

      const isFinal = flushed;
      yield { text, lang, isFinal };
      if (isFinal) return;
    }
    // Stream closed without a post-flush transcript: what we have is what we get.
    yield { text, lang, isFinal: true };
  } finally {
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
    socket.once("close", () => reject(new SarvamError("stt_closed", "socket closed before open")));
  });
}
