import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  createConfig,
  TTS_SAMPLE_RATE,
  synthesize,
  transcribe,
  type SarvamClientConfig,
} from "@svara/sarvam";
import {
  addNoise,
  decodeWav,
  encodeWav,
  isLanguageCode,
  resamplePcm16,
  type LanguageCode,
} from "@svara/shared";
import {
  GOLDEN_AUDIO_DIR,
  GOLDEN_DIR,
  GOLDEN_SET_VERSION,
  loadSource,
  type GoldenRecord,
  type GoldenSource,
} from "./golden.js";
import { characterErrorRate } from "./metrics/wer.js";

/**
 * Builds the golden set: hand-authored script → Bulbul audio → Saaras QA gate.
 *
 *   pnpm golden:build [--lang hi-IN] [--force]
 *
 * The audio is synthetic, and that is a deliberate, documented trade. Consented
 * recordings of real callers asking about welfare schemes do not exist and could
 * not be collected without a privacy regime this project has no business
 * inventing; synthetic audio has none of those problems and `consent: "synthetic"`
 * is a truthful provenance for every line. What it costs us is honesty about
 * difficulty: TTS speech is cleaner than a real phone call from a field, so the
 * WER this set produces is a *lower bound* on real-world error. It is a
 * regression detector, not an accuracy claim, and docs/EVAL_STRATEGY.md says so.
 *
 * QA gate: Saaras `translit` re-transcribes each synthesized clip and we compare
 * it to the hand-authored romanization. That is *not* the answer key — using one
 * Saaras output to grade another would be the model marking its own homework. It
 * answers a narrower question: did Bulbul actually say the thing we asked it to
 * say? A clip that fails is quarantined (`usable: false`) instead of being scored
 * later as a model failure it isn't.
 *
 * The gate runs in `translit`, not the production `codemix` mode, for a reason
 * worth stating plainly: a gate that grades a mode using that same mode
 * quarantines precisely the records the mode is worst at, and leaves behind a set
 * of easy records that scores green and measures nothing.
 */

/** Caller audio is 16kHz; golden audio must look like caller audio. */
const CALLER_SAMPLE_RATE = 16000;

/** Rotated across records so the set isn't a study of one voice. v3 roster only. */
const SPEAKERS = ["shubh", "ritu", "aditya", "priya"] as const;

/** Signal-to-noise ratio for the `noisy` bucket. Hard enough to hurt, not to break. */
const NOISY_SNR_DB = 10;

/**
 * A clip whose QA re-transcription is this far from the hand-authored
 * romanization is treated as bad synthesis and quarantined.
 *
 * The gate measures **CER, not WER**, and that is not a detail. Both sides are
 * romanized, and romanization has no single spelling convention: Saaras writes
 * "maadhangalaaga" where a human writes "maathangalaaga" — same word, same
 * sound, `th`/`dh` and a doubled consonant apart. Word-level WER scores that pair
 * 0.60 and quarantines a record whose recognition was flawless. CER sees it for
 * what it is (~0.1) while still catching a clip that genuinely said the wrong
 * thing.
 *
 * 0.25 is deliberately loose. Saaras is imperfect and will disagree with the
 * script on genuinely hard words — and *that disagreement is the thing the STT
 * metric exists to measure*, not something for this gate to filter out. An
 * earlier revision of this gate quarantined all six code-mixed records, every one
 * of which Bulbul had spoken perfectly. A gate like that silently deletes the
 * hard records and leaves a set of easy ones that scores green and means nothing
 * — the worst failure mode an eval harness has.
 */
const QA_CER_THRESHOLD = 0.25;

async function synthesizeClip(
  text: string,
  lang: LanguageCode,
  speaker: string,
  config: SarvamClientConfig,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const controller = new AbortController();

  const source = (async function* () {
    yield text;
  })();

  for await (const chunk of synthesize(source, { lang, speaker, signal: controller.signal }, config)) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw new Error(`bulbul returned no audio for "${text.slice(0, 40)}"`);

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const pcm = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return pcm;
}

/**
 * Re-transcribes a clip. The QA gate, never the answer key.
 *
 * Runs in `translit` (romanized output) rather than the production `codemix`
 * mode, deliberately: a gate that grades a mode with itself quarantines the
 * records that mode is worst at, which is the one thing an eval harness must
 * never do. `translit` is also deterministic — verified across repeat calls on
 * both languages — which `/transliterate` is not.
 */
async function qaTranscribe(
  pcm16k: Uint8Array,
  lang: LanguageCode,
  config: SarvamClientConfig,
): Promise<string> {
  const controller = new AbortController();

  // Feed it the way the gateway does — 20ms frames — so the QA pass exercises the
  // same streaming path the live loop uses rather than a bulk upload that behaves
  // differently.
  const frameBytes = (CALLER_SAMPLE_RATE / 1000) * 20 * 2;
  const frames = (async function* () {
    for (let i = 0; i < pcm16k.byteLength; i += frameBytes) {
      yield pcm16k.subarray(i, Math.min(i + frameBytes, pcm16k.byteLength));
    }
  })();

  let text = "";
  for await (const t of transcribe(
    frames,
    { lang, mode: "translit", sampleRate: CALLER_SAMPLE_RATE, signal: controller.signal },
    config,
  )) {
    text = t.text;
    if (t.isFinal) break;
  }
  return text;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The QA transcription, with backoff.
 *
 * Saaras returns an **empty transcript, not an error**, when it is being hammered:
 * open 40 WebSockets back-to-back with no pacing and a third of them come back
 * with nothing at all — the same cached clip that transcribed perfectly a minute
 * earlier. An immediate retry fails the same way, because the rate limit is still
 * in force; only backing off actually recovers it.
 *
 * This matters far beyond the build script. An empty transcript is
 * indistinguishable, at the type level, from "the caller said nothing" — the STT
 * hop yields `{text: "", isFinal: true}` in both cases. So a throttled API would
 * have quietly poisoned the golden set with blank references, and later poisoned
 * the eval with blank hypotheses, and every one of those would have been scored as
 * a 100% model error. Retry-with-backoff is not politeness here; it is the
 * difference between measuring a model and measuring a rate limiter.
 */
async function qaWithRetry(
  id: string,
  pcm16k: Uint8Array,
  lang: LanguageCode,
  config: SarvamClientConfig,
): Promise<string> {
  const backoffMs = [0, 1_000, 3_000, 8_000];
  for (const [attempt, wait] of backoffMs.entries()) {
    if (wait > 0) await sleep(wait);
    const heard = await qaTranscribe(pcm16k, lang, config).catch(() => "");
    if (heard.trim().length > 0) return heard;
    if (attempt < backoffMs.length - 1) {
      console.warn(`      ${id}: empty QA transcript, backing off ${backoffMs[attempt + 1]}ms`);
    }
  }
  // Genuinely nothing after four tries. Let the gate quarantine it loudly rather
  // than pretend we measured something.
  return "";
}

async function buildRecord(
  source: GoldenSource,
  lang: LanguageCode,
  index: number,
  config: SarvamClientConfig,
  force: boolean,
): Promise<GoldenRecord> {
  const speaker = SPEAKERS[index % SPEAKERS.length] ?? "shubh";
  const noisy = source.tags.includes("noisy");
  const audioPath = join(GOLDEN_AUDIO_DIR, `${source.id}.wav`);
  const audioRef = relative(resolve(GOLDEN_DIR, "../.."), audioPath).replace(/\\/g, "/");

  let pcm16k: Uint8Array;

  if (existsSync(audioPath) && !force) {
    // Synthesis costs API calls and, more importantly, is not bit-reproducible:
    // re-running the build would hand every record slightly different audio and
    // every WER would move for no reason. Cached audio is the stable answer key.
    pcm16k = decodeWav(new Uint8Array(await readFile(audioPath))).pcm;
    console.log(`  ${source.id}  (cached)`);
  } else {
    const pcm24k = await synthesizeClip(source.text, lang, speaker, config);
    pcm16k = resamplePcm16(pcm24k, TTS_SAMPLE_RATE, CALLER_SAMPLE_RATE);
    if (noisy) pcm16k = addNoise(pcm16k, NOISY_SNR_DB, hashSeed(source.id));

    await writeFile(audioPath, encodeWav(pcm16k, CALLER_SAMPLE_RATE));
    console.log(`  ${source.id}  ${speaker}${noisy ? `  +noise@${NOISY_SNR_DB}dB` : ""}`);
  }

  const heard = await qaWithRetry(source.id, pcm16k, lang, config);
  const qaCer = characterErrorRate(source.romanized, heard).rate;

  const usable = qaCer <= QA_CER_THRESHOLD;
  if (!usable) {
    console.warn(
      `  ! ${source.id} QUARANTINED — QA CER ${qaCer.toFixed(2)} > ${QA_CER_THRESHOLD}\n` +
        `      expected: ${source.romanized}\n` +
        `      heard   : ${heard}`,
    );
  }

  return {
    id: source.id,
    lang,
    audio_ref: audioRef,
    expected_transcript: source.text,
    expected_intent: source.intent,
    reference_translation: source.reference_translation,
    expected_romanized: source.romanized,
    tags: source.tags,
    consent: "synthetic",
    speaker,
    snr_db: noisy ? NOISY_SNR_DB : null,
    qa_transcript: heard,
    qa_cer: qaCer,
    usable,
  };
}

/** Stable per-record noise seed: rebuilding must not change what "noisy" means. */
function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const langArg = args[args.indexOf("--lang") + 1];

  const languages: LanguageCode[] =
    args.includes("--lang") && langArg !== undefined && isLanguageCode(langArg)
      ? [langArg]
      : ["hi-IN", "ta-IN"];

  await mkdir(GOLDEN_AUDIO_DIR, { recursive: true });
  const config = createConfig();

  for (const lang of languages) {
    const sources = await loadSource(lang);
    console.log(`\n[golden] ${lang}: ${sources.length} utterances`);

    const records: GoldenRecord[] = [];
    for (const [index, source] of sources.entries()) {
      // Pace the loop. Building the set is not latency-sensitive, and hammering
      // Saaras is what produces the empty transcripts in the first place — better
      // to spend 30 extra seconds than to bake a rate limiter into the answer key.
      if (index > 0) await sleep(500);
      try {
        records.push(await buildRecord(source, lang, index, config, force));
      } catch (err) {
        // One bad line must not cost the whole build. It stays out of the set,
        // loudly — a golden set that silently shrank is worse than one that failed.
        console.error(`  ! ${source.id} FAILED to build:`, err);
      }
    }

    await writeFile(
      join(GOLDEN_DIR, `${lang}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );

    const usable = records.filter((r) => r.usable).length;
    console.log(
      `[golden] ${lang}: ${usable}/${sources.length} usable` +
        `${usable < records.length ? ` (${records.length - usable} quarantined)` : ""}`,
    );
  }

  console.log(`\n[golden] set version ${GOLDEN_SET_VERSION} written to evals/golden/`);
}

main().catch((err: unknown) => {
  console.error("[golden] fatal:", err);
  process.exit(1);
});
