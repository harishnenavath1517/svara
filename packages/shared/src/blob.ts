import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { optionalEnv } from "./env.js";

/**
 * Audio blob storage. A trace event never carries audio — it carries a *reference*
 * to audio (guardrail: "never put raw audio in the event; store the blob,
 * reference it"). This is the thing on the other end of that reference.
 *
 * Locally that's the filesystem under STORAGE_DIR, and a ref is a relative path
 * like `traces/<session>/<trace>-stt-in.wav`. In production the same refs become
 * Supabase Storage object keys under STORAGE_BUCKET — the ref format is
 * deliberately a key, not a URL, so moving between the two changes the driver and
 * not a single stored row.
 *
 * Writes are best-effort by design. Losing a blob costs you a trace drill-down;
 * failing a live call to store one is not a trade worth making, so `putAudio`
 * logs and returns null instead of throwing into the hot path.
 */

/**
 * The monorepo root, found by walking up for the pnpm workspace file.
 *
 * Storage must be anchored here and NOT to `process.cwd()`. Every process in this
 * repo runs from its own package directory — the Temporal worker from
 * `packages/orchestrator`, the eval runner from `packages/eval` — so a
 * cwd-relative root means the worker writes a blob to one place and the eval
 * runner looks for it in another. The trace still carries a ref, the ref still
 * looks fine in Postgres, and the audio is simply *gone*: a dangling reference
 * that nothing detects until someone clicks "play" in the dashboard months later.
 */
export function repoRoot(): string {
  let dir = resolve(process.cwd());
  const { root } = parse(dir);
  while (dir !== root) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  // Not inside the monorepo (a container, a published artifact). cwd is the only
  // honest answer, and STORAGE_DIR should be set explicitly there anyway.
  return resolve(process.cwd());
}

function storageRoot(): string {
  const configured = optionalEnv("STORAGE_DIR", "");
  if (configured.length > 0) {
    return isAbsolute(configured) ? configured : resolve(repoRoot(), configured);
  }
  return join(repoRoot(), ".svara-storage");
}

/** Guards against a `..` in a caller-supplied key escaping the storage root. */
function resolveKey(key: string): string {
  const full = resolve(join(storageRoot(), key));
  const root = storageRoot();
  if (!full.startsWith(root)) throw new Error(`blob key escapes storage root: ${key}`);
  return full;
}

/**
 * Stores audio and returns the ref to put in the trace, or null if the write
 * failed. Callers must treat null as "no blob", never as an error to propagate.
 */
export async function putAudio(key: string, bytes: Uint8Array): Promise<string | null> {
  try {
    const path = resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return key;
  } catch (err) {
    console.error(`[blob] failed to store ${key}:`, err);
    return null;
  }
}

/**
 * Reads a blob back. Unlike `putAudio` this *does* throw: the eval runner and the
 * dashboard's drill-down have nothing useful to do with a missing blob, and
 * scoring silently fewer records than you think you scored is the exact failure
 * this harness exists to prevent.
 */
export async function getAudio(ref: string): Promise<Uint8Array> {
  // Absolute paths are how the golden set refers to files that live in the repo
  // (evals/golden/audio/...) rather than in the trace store.
  const path = isAbsolute(ref) ? ref : resolveKey(ref);
  return new Uint8Array(await readFile(path));
}

/** Where a hop's audio lives. Keyed by trace so a drill-down is one lookup. */
export function traceAudioKey(
  sessionId: string,
  traceId: string,
  hop: "stt" | "tts",
  direction: "in" | "out",
): string {
  return `traces/${sessionId}/${traceId}-${hop}-${direction}.wav`;
}
