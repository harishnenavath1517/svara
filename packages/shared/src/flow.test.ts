import { describe, expect, it } from "vitest";

import { DEFAULT_FLOW, flowFingerprint, sanitizeFlow, type FlowConfig } from "./flow.js";

const PROMPT_VERSION = "1";

const fingerprint = (flow: FlowConfig): string => flowFingerprint(flow, PROMPT_VERSION);

type Mutation = { path: string; mutate: (flow: FlowConfig) => FlowConfig };

/**
 * The one knob that must NOT move the config hash. `lang` describes the call, not
 * the configuration, and the trace carries it as its own column. Hashing it split
 * hi-IN and ta-IN calls into separate config buckets and left both unable to match
 * the offline eval's hash — see the note on `flowFingerprint`.
 */
const UNHASHED: Mutation[] = [
  { path: "stt.lang", mutate: (f) => ({ ...f, stt: { ...f.stt, lang: "ta-IN" } }) },
];

/** Every other leaf of FlowConfig, and a value for it that differs from the default. */
const KNOBS: Mutation[] = [
  { path: "stt.mode", mutate: (f) => ({ ...f, stt: { ...f.stt, mode: "verbatim" } }) },
  { path: "llm.model", mutate: (f) => ({ ...f, llm: { ...f.llm, model: "sarvam-105b" } }) },
  { path: "llm.temperature", mutate: (f) => ({ ...f, llm: { ...f.llm, temperature: 0.9 } }) },
  { path: "llm.maxTokens", mutate: (f) => ({ ...f, llm: { ...f.llm, maxTokens: 1024 } }) },
  { path: "llm.thinking", mutate: (f) => ({ ...f, llm: { ...f.llm, thinking: true } }) },
  { path: "tts.speaker", mutate: (f) => ({ ...f, tts: { ...f.tts, speaker: "ritu" } }) },
  { path: "tts.pace", mutate: (f) => ({ ...f, tts: { ...f.tts, pace: 1.4 } }) },
];

describe("sanitizeFlow", () => {
  it("resolves an empty patch to the base, unchanged", () => {
    expect(sanitizeFlow({})).toEqual(DEFAULT_FLOW);
  });

  it("survives hostile input rather than throwing into a live call", () => {
    for (const hostile of [null, undefined, 42, "flow", [], { stt: "codemix" }, { llm: null }]) {
      expect(sanitizeFlow(hostile)).toEqual(DEFAULT_FLOW);
    }
  });

  it("rejects a bulbul:v2 speaker instead of letting it 400 mid-call", () => {
    // anushka and meera are v2 and are rejected by bulbul:v3 (docs/SARVAM_API.md).
    // The gateway has to catch that here, or the caller hears the failure.
    expect(sanitizeFlow({ tts: { speaker: "anushka" } }).tts.speaker).toBe(DEFAULT_FLOW.tts.speaker);
    expect(sanitizeFlow({ tts: { speaker: "meera" } }).tts.speaker).toBe(DEFAULT_FLOW.tts.speaker);
    expect(sanitizeFlow({ tts: { speaker: "ritu" } }).tts.speaker).toBe("ritu");
  });

  it("rejects an unknown STT mode and an unknown language", () => {
    expect(sanitizeFlow({ stt: { mode: "saarika" } }).stt.mode).toBe(DEFAULT_FLOW.stt.mode);
    expect(sanitizeFlow({ stt: { lang: "fr-FR" } }).stt.lang).toBe(DEFAULT_FLOW.stt.lang);
    expect(sanitizeFlow({ stt: { mode: "translit", lang: "ta-IN" } }).stt).toEqual({
      mode: "translit",
      lang: "ta-IN",
    });
  });

  it("clamps numbers into the ranges Sarvam accepts", () => {
    expect(sanitizeFlow({ tts: { pace: 40 } }).tts.pace).toBe(2);
    expect(sanitizeFlow({ tts: { pace: 0.1 } }).tts.pace).toBe(0.5);
    expect(sanitizeFlow({ llm: { temperature: -3 } }).llm.temperature).toBe(0);
    expect(sanitizeFlow({ llm: { maxTokens: 99_999 } }).llm.maxTokens).toBe(2048);
  });

  it("falls back on NaN, which survives Math.min/Math.max untouched", () => {
    // The bug this pins: `Number("hot")` is NaN, and `Math.min(2, Math.max(0, NaN))`
    // is NaN — so a naive clamp passes "temperature": NaN straight to the model.
    expect(sanitizeFlow({ llm: { temperature: Number.NaN } }).llm.temperature).toBe(0.2);
    expect(sanitizeFlow({ llm: { temperature: "hot" } }).llm.temperature).toBe(0.2);
    expect(sanitizeFlow({ tts: { pace: Number.POSITIVE_INFINITY } }).tts.pace).toBe(1);
  });

  it("resolves against the given base, not the shipped default", () => {
    const base = sanitizeFlow({ tts: { speaker: "aditya" } });
    expect(sanitizeFlow({}, base).tts.speaker).toBe("aditya");
    expect(sanitizeFlow({ llm: { temperature: 0.7 } }, base).tts.speaker).toBe("aditya");
  });
});

describe("flowFingerprint", () => {
  /**
   * The property the eval plane's integrity rests on: a knob that can change a
   * hop's output but NOT the config hash is a machine for filing one
   * configuration's results under another's name — silently, and undetectably
   * from downstream. Adding a field to FlowConfig without adding it to the
   * fingerprint fails here.
   */
  it("changes when any knob changes", () => {
    const base = fingerprint(DEFAULT_FLOW);
    const seen = new Map<string, string>([[base, "DEFAULT_FLOW"]]);

    for (const { path, mutate } of KNOBS) {
      const moved = fingerprint(mutate(DEFAULT_FLOW));
      expect(moved, `moving ${path} did not change the config hash`).not.toBe(base);

      const collision = seen.get(moved);
      expect(collision, `${path} fingerprints identically to ${String(collision)}`).toBeUndefined();
      seen.set(moved, path);
    }
  });

  it("does not change when the caller's language changes", () => {
    // The bug this pins, caught by running a real turn: with `lang` in the hash,
    // the gateway advertised one config_hash on /flow and every actual call — which
    // always sets a language — traced a different one. Worse, hi-IN and ta-IN calls
    // landed in *different* config buckets, and neither could ever match an eval
    // run's hash, so live traffic was NOT COMPARABLE to the baseline forever.
    for (const { mutate } of UNHASHED) {
      expect(fingerprint(mutate(DEFAULT_FLOW))).toBe(fingerprint(DEFAULT_FLOW));
    }
  });

  it("covers every leaf of FlowConfig", () => {
    // Guards the guard: if someone adds `llm.top_p` and forgets to add it to
    // KNOBS, the test above would pass while proving nothing about it. Every leaf
    // must be a deliberate decision — hashed, or explicitly not.
    const leaves = Object.entries(DEFAULT_FLOW).flatMap(([node, config]) =>
      Object.keys(config).map((knob) => `${node}.${knob}`),
    );
    const classified = [...KNOBS, ...UNHASHED].map((k) => k.path);
    expect(new Set(classified)).toEqual(new Set(leaves));
  });

  it("is stable across calls and independent of key order", () => {
    const reordered: FlowConfig = {
      tts: { pace: DEFAULT_FLOW.tts.pace, speaker: DEFAULT_FLOW.tts.speaker },
      llm: {
        thinking: DEFAULT_FLOW.llm.thinking,
        maxTokens: DEFAULT_FLOW.llm.maxTokens,
        temperature: DEFAULT_FLOW.llm.temperature,
        model: DEFAULT_FLOW.llm.model,
      },
      stt: { lang: DEFAULT_FLOW.stt.lang, mode: DEFAULT_FLOW.stt.mode },
    };
    expect(fingerprint(reordered)).toBe(fingerprint(DEFAULT_FLOW));
  });

  it("pins the shipped configuration", () => {
    // Not busywork. `/flow` is only honest if its untouched defaults are the exact
    // configuration `/` already ships; and the config hash of every production
    // trace is derived from this string. If this assertion fails, you have either
    // changed what the agent does by default — in which case the rotation is real
    // and every stored run is correctly NOT COMPARABLE to the next one — or you
    // have changed it by accident. Both are worth stopping for.
    expect(fingerprint(DEFAULT_FLOW)).toBe(
      '{"v":2,"prompt_version":"1","stt":{"model":"saaras:v3","mode":"codemix"},' +
        '"llm":{"model":"sarvam-30b","temperature":0.2,"max_tokens":512,"thinking":false},' +
        '"tts":{"model":"bulbul:v3","speaker":"shubh","pace":1}}',
    );
  });
});
