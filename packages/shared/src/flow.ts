import { MODELS, STT_MODES, type SttMode } from "./constants.js";
import { isLanguageCode, UNKNOWN_LANGUAGE, type TraceLanguage } from "./languages.js";
import type { Hop } from "./trace.js";

/**
 * The flow: the turn's topology, and the knobs on each hop that can change what
 * comes out of it.
 *
 * This is what the `/flow` node canvas edits and what the gateway resolves. Two
 * rules hold the whole thing together, and both exist because a node editor is a
 * loaded gun pointed at the eval plane:
 *
 * 1. **The browser is not the authority.** Everything here is `sanitizeFlow`d on
 *    the gateway against the rosters and ranges below, and the gateway echoes back
 *    what it actually resolved. A canvas that shows `speaker: "anushka"` while the
 *    server quietly ran `shubh` is a canvas that lies about the run it just did.
 * 2. **The config hash follows the config.** Every field here is an input to
 *    `flowFingerprint`, because every field here can change a hop's output — and
 *    `config_hash` is the trace's claim about *which configuration produced this
 *    number* (docs/DATA_CONTRACTS.md). Add a knob without adding it to the
 *    fingerprint and you have built a machine that files results from one config
 *    under the name of another. That is not a dashboard bug; it is a corrupted
 *    eval plane, and nothing downstream can detect it.
 *
 * Hashing itself is not done here: this module is imported by the browser, and
 * `node:crypto` is not. The fingerprint is a pure string; the orchestrator hashes
 * it and the client is *told* the result by the gateway.
 */

export interface SttNodeConfig {
  /** `codemix` for real call audio. `verbatim` is for building golden truth, not serving. */
  mode: SttMode;
  /** "unknown" lets saaras:v3 detect the caller's language. */
  lang: TraceLanguage;
}

export interface LlmNodeConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  /**
   * sarvam-30b reasons by default and bills the reasoning against `maxTokens`
   * *before* the reply (see packages/sarvam/src/chat.ts). Off in the voice loop,
   * always. It is exposed on the canvas precisely so the cost is demonstrable:
   * turn it on and watch first-audio leave the 800ms budget by a factor of five.
   */
  thinking: boolean;
}

export interface TtsNodeConfig {
  speaker: string;
  pace: number;
}

export interface FlowConfig {
  stt: SttNodeConfig;
  llm: LlmNodeConfig;
  tts: TtsNodeConfig;
}

/**
 * bulbul:v3 speakers. The v2 roster is NOT the v3 roster: `anushka` and `meera`
 * are v2 and are rejected by v3 with a 400 (docs/SARVAM_API.md). They are absent
 * from this list on purpose — it is the allowlist the gateway sanitizes against,
 * so a client cannot talk the server into a 400 mid-call.
 */
export const TTS_SPEAKERS = [
  "shubh",
  "ritu",
  "aditya",
  "priya",
  "neha",
  "rahul",
  "kavya",
  "amit",
  "ishita",
  "shreya",
] as const;

/** Ranges the gateway clamps to. Outside these, Sarvam 400s or the budget dies. */
export const FLOW_LIMITS = {
  temperature: { min: 0, max: 2 },
  /** Sarvam's own default is 512. Below ~128 the model truncates mid-sentence. */
  maxTokens: { min: 128, max: 2048 },
  /** bulbul:v3 accepts 0.5–2.0; anything else is a 400. */
  pace: { min: 0.5, max: 2 },
} as const;

/**
 * The shipped configuration — and it is not decoration: these values must be the
 * ones the hops would have used with no flow at all, or `/flow` would silently be
 * a different product from `/`. `flow.test.ts` pins the fingerprint of this object
 * so a careless edit here can't rotate the config hash of every production trace
 * without someone noticing.
 */
export const DEFAULT_FLOW: FlowConfig = {
  stt: { mode: "codemix", lang: UNKNOWN_LANGUAGE },
  llm: { model: MODELS.llm, temperature: 0.2, maxTokens: 512, thinking: false },
  tts: { speaker: "shubh", pace: 1 },
};

/** A flow as it arrives from a client: any shape at all, including hostile. */
export type FlowPatch = {
  stt?: Partial<SttNodeConfig>;
  llm?: Partial<LlmNodeConfig>;
  tts?: Partial<TtsNodeConfig>;
};

/**
 * Resolve an untrusted patch against a trusted base. Total: never throws, never
 * returns a value the hops can't honour. An unrecognised mode, a v2 speaker, a
 * pace of 40, a `temperature` of `"hot"` — each falls back to the base rather
 * than reaching Sarvam and 400ing in the middle of a live call.
 *
 * Falling back rather than rejecting is deliberate. The gateway echoes the
 * resolved flow straight back to the client (`flow_ack`), so a clamp is *visible*
 * on the canvas — which is more useful than an error, and impossible to miss.
 */
export function sanitizeFlow(patch: unknown, base: FlowConfig = DEFAULT_FLOW): FlowConfig {
  const input: FlowPatch = isRecord(patch) ? (patch as FlowPatch) : {};
  const stt = isRecord(input.stt) ? input.stt : {};
  const llm = isRecord(input.llm) ? input.llm : {};
  const tts = isRecord(input.tts) ? input.tts : {};

  return {
    stt: {
      mode: isSttMode(stt.mode) ? stt.mode : base.stt.mode,
      lang: isTraceLanguage(stt.lang) ? stt.lang : base.stt.lang,
    },
    llm: {
      // Free text, because LLM_BASE_URL may point at a LiteLLM proxy with its own
      // roster (CLAUDE.md pins the *Sarvam* models, not the proxy's). Bounded to
      // something sane so it can't be used to smuggle a URL or a novel into a header.
      model: isModelName(llm.model) ? llm.model : base.llm.model,
      temperature: clamp(llm.temperature, FLOW_LIMITS.temperature, base.llm.temperature),
      maxTokens: Math.round(clamp(llm.maxTokens, FLOW_LIMITS.maxTokens, base.llm.maxTokens)),
      thinking: typeof llm.thinking === "boolean" ? llm.thinking : base.llm.thinking,
    },
    tts: {
      speaker: isSpeaker(tts.speaker) ? tts.speaker : base.tts.speaker,
      pace: clamp(tts.pace, FLOW_LIMITS.pace, base.tts.pace),
    },
  };
}

/**
 * The canonical serialization behind `config_hash`.
 *
 * `v` is not ceremony. Before the flow builder, the hash covered five fields
 * (models, stt mode, prompt version); it now covers every knob a node can move,
 * so the same production configuration fingerprints differently than it did — a
 * deliberate, one-time rotation. The version makes that rotation legible instead
 * of looking like a corrupted hash, and it means a *future* widening can't
 * collide with a past one. Runs either side of it are correctly stamped NOT
 * COMPARABLE by the dashboard, which is the harness doing its job, not failing.
 *
 * Keys are written in a fixed order, not JSON.stringify'd from a mutable object,
 * because key order is not guaranteed by the spec across engines and a hash that
 * depends on it is a hash that changes for no reason.
 *
 * **`stt.lang` is deliberately NOT in here**, and it is the one exclusion worth
 * arguing about, because it plainly does change what STT produces. It is excluded
 * because `config_hash` exists to answer "are these two numbers comparable?", and
 * language is a property of the *call*, not of the configuration under test — the
 * trace and every eval score already carry `lang` as its own dimension. Folding it
 * in was tried, and it broke exactly what the hash is for: a hi-IN call and a
 * ta-IN call landed in different config buckets, and neither could ever match the
 * offline eval's hash (the harness scores every language under one config), so
 * live traffic would have been stamped NOT COMPARABLE against every run forever.
 * A dimension the schema already models does not belong inside an opaque hash.
 */
export function flowFingerprint(flow: FlowConfig, promptVersion: string): string {
  return JSON.stringify({
    v: 2,
    prompt_version: promptVersion,
    stt: { model: MODELS.stt, mode: flow.stt.mode },
    llm: {
      model: flow.llm.model,
      temperature: flow.llm.temperature,
      max_tokens: flow.llm.maxTokens,
      thinking: flow.llm.thinking,
    },
    tts: { model: MODELS.tts, speaker: flow.tts.speaker, pace: flow.tts.pace },
  });
}

/* ------------------------------------------------------------------ *
 * The topology.
 * ------------------------------------------------------------------ */

export type FlowNodeId = "caller" | "stt" | "llm" | "tts" | "speaker";

export interface FlowNodeSpec {
  id: FlowNodeId;
  label: string;
  /** The Temporal activity behind this node; null for the two ends (the browser). */
  activity: "transcribe" | "respond" | "synthesize" | null;
  /** The trace hop that reports this node's latency. Null ends emit no trace. */
  hop: Hop | null;
}

export interface FlowEdgeSpec {
  from: FlowNodeId;
  to: FlowNodeId;
  /** What travels this edge, per docs/DATA_CONTRACTS.md. */
  payload: string;
  /**
   * *How* it travels — and the reason the canvas can't be a plain box-and-arrow
   * diagram. These four edges are three different transports: the caller's
   * WebSocket, the gateway↔worker channel, and the in-worker turn bus. Only the
   * bus edges are the ones that let the hops overlap.
   */
  carrier: "caller socket" | "gateway↔worker" | "turn bus";
}

/**
 * The turn, as it actually runs. Fixed, and deliberately not draggable — see the
 * note on `/flow`: the three activities start concurrently and hand off through
 * an in-worker bus, so an edge the user drew from TTS back to STT is not a flow
 * the runtime can honour. A canvas that accepts an edge the runtime will ignore
 * is a canvas that lies, and this repo has spent four phases refusing to do that.
 */
export const FLOW_NODES: readonly FlowNodeSpec[] = [
  { id: "caller", label: "Caller", activity: null, hop: null },
  { id: "stt", label: "STT", activity: "transcribe", hop: "stt" },
  { id: "llm", label: "LLM", activity: "respond", hop: "llm" },
  { id: "tts", label: "TTS", activity: "synthesize", hop: "tts" },
  { id: "speaker", label: "Speaker", activity: null, hop: null },
];

export const FLOW_EDGES: readonly FlowEdgeSpec[] = [
  { from: "caller", to: "stt", payload: "PCM16 mono @16k", carrier: "gateway↔worker" },
  { from: "stt", to: "llm", payload: "Transcript (final)", carrier: "turn bus" },
  { from: "llm", to: "tts", payload: "sentence, as each closes", carrier: "turn bus" },
  { from: "tts", to: "speaker", payload: "PCM16 mono @24k", carrier: "caller socket" },
];

/* ------------------------------------------------------------------ *
 * Guards. Deliberately paranoid: every one of these sits between a browser
 * and a live phone call.
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSttMode(value: unknown): value is SttMode {
  return typeof value === "string" && (STT_MODES as readonly string[]).includes(value);
}

function isTraceLanguage(value: unknown): value is TraceLanguage {
  return typeof value === "string" && (value === UNKNOWN_LANGUAGE || isLanguageCode(value));
}

function isSpeaker(value: unknown): value is string {
  return typeof value === "string" && (TTS_SPEAKERS as readonly string[]).includes(value);
}

/** Bounded and charset-limited: this string is interpolated into a request body. */
function isModelName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[\w.:/-]{1,64}$/.test(value);
}

function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {
  // NaN and Infinity both fail this, which is the point: `Number("hot")` is NaN,
  // and NaN survives Math.min/Math.max untouched.
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}
