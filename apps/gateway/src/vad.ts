import { optionalEnv } from "@svara/shared";

/**
 * Voice-activity detection over the incoming PCM16 stream.
 *
 * Energy + hysteresis, deliberately: it runs in a few microseconds per frame,
 * has no model to load, and barge-in latency is dominated by how fast we can
 * cancel TTS, not by how clever the detector is. A neural VAD (Silero) is a
 * drop-in upgrade behind this same interface if the demo room turns out to be
 * noisy — swap the `speaking()` predicate, keep the state machine.
 *
 * Two events matter:
 *  - "speech-start": the caller began talking. Starts a turn, and if the agent is
 *    mid-reply, that's barge-in — cancel it (guardrail 5).
 *  - "speech-end": the caller stopped. Closes the audio stream, which is what
 *    makes Saaras flush and finalize the transcript.
 */
export type VadEvent = "speech-start" | "speech-end" | null;

/** RMS over normalized samples. Raise it in a noisy room, lower it for a quiet mic. */
const RMS_THRESHOLD = Number(optionalEnv("VAD_RMS_THRESHOLD", "0.02"));
/** Consecutive loud frames before we believe it's speech and not a door slam. */
const SPEECH_FRAMES = 2;
/** Silence that ends an utterance. Too short clips words; too long adds dead air. */
const HANGOVER_MS = 600;

export class Vad {
  readonly #sampleRate: number;
  #speaking = false;
  #loudFrames = 0;
  #silenceMs = 0;

  constructor(sampleRate: number) {
    this.#sampleRate = sampleRate;
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  push(frame: Int16Array): VadEvent {
    const loud = rms(frame) >= RMS_THRESHOLD;
    const frameMs = (frame.length / this.#sampleRate) * 1000;

    if (this.#speaking) {
      this.#silenceMs = loud ? 0 : this.#silenceMs + frameMs;
      if (this.#silenceMs >= HANGOVER_MS) {
        this.#speaking = false;
        this.#loudFrames = 0;
        this.#silenceMs = 0;
        return "speech-end";
      }
      return null;
    }

    this.#loudFrames = loud ? this.#loudFrames + 1 : 0;
    if (this.#loudFrames >= SPEECH_FRAMES) {
      this.#speaking = true;
      this.#silenceMs = 0;
      return "speech-start";
    }
    return null;
  }
}

function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) {
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / frame.length);
}
