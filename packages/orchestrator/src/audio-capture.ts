import { encodeWav, optionalEnv, putAudio, traceAudioKey } from "@svara/shared";

/**
 * Captures a hop's audio to the blob store so a trace can be *listened to* later,
 * not just read. The dashboard's drill-down (Phase 3) and the eval plane's
 * ability to re-score a real failed call both depend on the bytes still existing
 * after the call ends.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Never delay first audio.** Capture is a passive tee — the chunks are
 *     forwarded to the caller the instant they arrive, and the WAV is only
 *     assembled and written once the hop has finished streaming. The write lands
 *     after the caller has already heard the reply.
 *  2. **Never fail a call to store a blob.** `putAudio` swallows and logs its own
 *     errors and returns null; a null ref means "no recording", which degrades
 *     the eval plane and nothing else.
 */

/** Off by default in production; on locally, where the drill-down is the point. */
export function audioCaptureEnabled(): boolean {
  return optionalEnv("TRACE_AUDIO", "true") !== "false";
}

/**
 * Passes an audio stream straight through while keeping a copy. The copy is a
 * list of chunk references, not a concatenation — joining once at the end beats
 * reallocating a growing buffer on every 20ms frame.
 */
export class AudioTee {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly enabled: boolean) {}

  async *tap(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    for await (const chunk of source) {
      if (this.enabled) {
        this.chunks.push(chunk);
        this.bytes += chunk.byteLength;
      }
      yield chunk;
    }
  }

  /** Call from the hop's own loop when the stream is consumed by someone else. */
  push(chunk: Uint8Array): void {
    if (!this.enabled) return;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  /**
   * Writes what was captured and returns the trace ref, or null if capture is
   * off, nothing was heard, or the write failed. A cancelled turn still stores
   * the partial audio it captured — the half-second before a caller barged in is
   * exactly the audio you want when you're asking why they barged in.
   */
  async store(
    sessionId: string,
    traceId: string,
    hop: "stt" | "tts",
    direction: "in" | "out",
    sampleRate: number,
  ): Promise<string | null> {
    if (!this.enabled || this.bytes === 0) return null;

    const pcm = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return putAudio(
      traceAudioKey(sessionId, traceId, hop, direction),
      encodeWav(pcm, sampleRate),
    );
  }
}
