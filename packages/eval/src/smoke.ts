import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeWav, MIC_SAMPLE_RATE, optionalEnv, repoRoot } from "@svara/shared";
import type { ServerMessage } from "@svara/shared";
import WebSocket from "ws";

/**
 * End-to-end smoke test of the live voice loop.
 *
 *   pnpm --filter @svara/eval run smoke [--id hi-IN-0001]
 *
 * Plays a golden clip into the gateway exactly as a caller's microphone would —
 * real WebSocket, real VAD, real Temporal workflow, real Sarvam hops — and asserts
 * a complete turn comes back: a final transcript, a reply, and audio.
 *
 * The eval harness scores the *models* by calling them directly, which means it
 * would stay perfectly green while the orchestration underneath it was broken. This
 * is the check that the thing we ship still works. It exists because Phase 2 added
 * audio-blob capture to the middle of both streaming hops, and "the tests pass" is
 * not an answer to "can it still complete a call?".
 *
 * Requires `pnpm dev` (gateway + Temporal worker) to be running.
 */

const GATEWAY_URL = optionalEnv("NEXT_PUBLIC_GATEWAY_WS_URL", "ws://localhost:8787/voice");

/** 20ms of PCM16 @16kHz, the frame size the browser's capture worklet emits. */
const FRAME_BYTES = (MIC_SAMPLE_RATE / 1000) * 20 * 2;
const FRAME_MS = 20;

/** The VAD needs silence after the utterance to decide the caller has stopped. */
const TRAILING_SILENCE_MS = 900;

const TURN_TIMEOUT_MS = 30_000;

/** Bulbul sends no end-of-stream message, so quiet is the only signal the reply is done. */
const AUDIO_QUIET_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TurnOutcome {
  transcript: string;
  reply: string;
  audioChunks: number;
  firstAudioMs: number | null;
}

async function drive(recordId: string): Promise<TurnOutcome> {
  const audioPath = resolve(repoRoot(), `evals/golden/audio/${recordId}.wav`);
  const { pcm } = decodeWav(new Uint8Array(await readFile(audioPath)));

  const socket = new WebSocket(GATEWAY_URL);
  const outcome: TurnOutcome = { transcript: "", reply: "", audioChunks: 0, firstAudioMs: null };

  await new Promise<void>((ok, fail) => {
    socket.once("open", () => ok());
    socket.once("error", fail);
  });

  let micClosedAt = 0;
  let quiet: NodeJS.Timeout | undefined;
  const done = new Promise<void>((ok, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`no complete turn within ${TURN_TIMEOUT_MS}ms`)),
      TURN_TIMEOUT_MS,
    );

    socket.on("message", (raw: Buffer) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString("utf8")) as ServerMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case "final":
          outcome.transcript = message.text;
          break;
        case "reply":
          outcome.reply = message.text;
          break;
        case "audio":
          outcome.audioChunks += 1;
          // Mic close → first audio at the caller. The number the <800ms budget
          // is actually about; everything else is a component of it.
          outcome.firstAudioMs ??= Date.now() - micClosedAt;
          break;
        default:
          break;
      }

      // A turn is complete when we have heard the caller, answered, and finished
      // speaking. Resolving on the FIRST audio chunk and closing the socket would
      // look like a pass, but the gateway reads the close as a barge-in and the
      // TTS hop traces `error: cancelled` — writing a fake interruption into the
      // very eval data this harness exists to keep honest. So: wait for the audio
      // to stop arriving, then hang up.
      if (outcome.transcript && outcome.reply && outcome.audioChunks > 0) {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          clearTimeout(timer);
          ok();
        }, AUDIO_QUIET_MS);
      }
    });
    socket.once("error", fail);
  });

  socket.send(JSON.stringify({ type: "start", lang: recordId.slice(0, 5) }));

  // Feed the clip in real time. Blasting it at the socket would defeat the VAD,
  // which is looking for the *shape* of speech over time, and would not exercise
  // the streaming path the way a real caller does.
  for (let i = 0; i < pcm.byteLength; i += FRAME_BYTES) {
    socket.send(pcm.subarray(i, Math.min(i + FRAME_BYTES, pcm.byteLength)));
    await sleep(FRAME_MS);
  }
  micClosedAt = Date.now();

  // Silence, so the VAD endpoints the utterance — this is what makes Saaras flush
  // and finalize, and it is where most of the first-audio budget actually goes.
  const silence = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < TRAILING_SILENCE_MS / FRAME_MS; i += 1) {
    socket.send(silence);
    await sleep(FRAME_MS);
  }

  await done;
  socket.send(JSON.stringify({ type: "stop" }));
  socket.close();
  return outcome;
}

const idFlag = process.argv.indexOf("--id");
const recordId = idFlag === -1 ? "hi-IN-0001" : (process.argv[idFlag + 1] ?? "hi-IN-0001");

try {
  console.log(`[smoke] driving a turn through ${GATEWAY_URL} with ${recordId}`);
  const outcome = await drive(recordId);

  console.log(`  transcript : ${outcome.transcript}`);
  console.log(`  reply      : ${outcome.reply}`);
  console.log(`  audio      : ${outcome.audioChunks} chunks`);
  console.log(`  first audio: ${outcome.firstAudioMs ?? "--"}ms  (budget 800ms)`);
  console.log("[smoke] the voice loop completed a turn.");
} catch (err) {
  console.error("[smoke] FAILED — the voice loop did not complete a turn:", err);
  console.error("        Is `pnpm dev` running (gateway + Temporal worker)?");
  process.exit(1);
}
