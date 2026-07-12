import type { EvalRunRow, ScoreDelta } from "@svara/db";
import { describe, expect, it } from "vitest";
import {
  classifyDelta,
  comparability,
  NOT_GATED,
  REGRESSION_THRESHOLDS,
  summarize,
  thresholdFor,
} from "./regression.js";

/**
 * The CI gate's logic. This is the code that decides whether a build goes red, so
 * the interesting cases are the ones where it must NOT: a metric that improved, a
 * metric that moved less than the harness's own noise, and — the one that matters
 * most — a run whose configuration changed underneath it.
 */

const run = (over: Partial<EvalRunRow> = {}): EvalRunRow => ({
  run_id: "00000000-0000-0000-0000-000000000000",
  git_sha: "abc1234",
  config_hash: "sha256:2ad9ebd",
  started_at: "2026-07-12T05:00:00Z",
  finished_at: "2026-07-12T05:10:00Z",
  golden_set_version: "1",
  records_scored: 40,
  notes: null,
  ...over,
});

const delta = (metric: string, before: number | null, after: number | null): ScoreDelta => ({
  lang: "hi-IN",
  hop: "stt",
  metric,
  slice: "all",
  before,
  after,
  delta: before === null || after === null ? null : after - before,
});

describe("classifyDelta", () => {
  it("fails the build when an error rate rises past its threshold", () => {
    // wer threshold is 0.02; 0.12 -> 0.20 is a real regression.
    const v = classifyDelta(delta("wer", 0.12, 0.2));
    expect(v.verdict).toBe("regressed_past_threshold");
    expect(v.fails).toBe(true);
  });

  it("does not fail on a regression inside the threshold", () => {
    const v = classifyDelta(delta("wer", 0.12, 0.13));
    expect(v.verdict).toBe("regressed");
    expect(v.fails).toBe(false);
  });

  it("never fails on an improvement, however large", () => {
    const v = classifyDelta(delta("wer", 0.5, 0.01));
    expect(v.verdict).toBe("improved");
    expect(v.fails).toBe(false);
  });

  it("knows a FALLING judge score is the bad direction", () => {
    // The regression that a hand-rolled sign check gets wrong: higher is better
    // here, so a drop past half a rubric point must fail.
    const v = classifyDelta({ ...delta("judge_adequacy", 4.8, 4.0), hop: "llm" });
    expect(v.verdict).toBe("regressed_past_threshold");
    expect(v.fails).toBe(true);
  });

  it("knows a RISING judge score is not a regression", () => {
    expect(classifyDelta({ ...delta("judge_adequacy", 4.0, 4.9), hop: "llm" }).fails).toBe(false);
  });

  it("treats a judge that stopped parsing as gateable, not as a quality win", () => {
    // judge_unparseable_rate is lower-is-better. The bug this guards against
    // reported a scorer outage as an improvement.
    const v = classifyDelta({ ...delta("judge_unparseable_rate", 0.0, 0.25), hop: "llm" });
    expect(v.fails).toBe(true);
  });

  it("does not gate the latency tails, because at n=20 they are noise", () => {
    // ttfb_p99 moved 732ms between two runs of identical code. A gate here would
    // fire at random, so it reports and abstains.
    const v = classifyDelta({ ...delta("ttfb_p99", 400, 2000), hop: "stt" });
    expect(v.verdict).toBe("ungated");
    expect(v.fails).toBe(false);
    expect(v.threshold).toBeNull();
    expect(NOT_GATED.ttfb_p99).toBeDefined();
  });

  it("calls a metric present in only one run appeared/disappeared, not a regression", () => {
    // The FULL OUTER JOIN's whole reason for existing: a language that stopped
    // being scored is a finding, but it is not a quality regression and must not
    // masquerade as one.
    expect(classifyDelta(delta("wer", null, 0.3)).verdict).toBe("appeared");

    const gone = classifyDelta(delta("wer", 0.3, null));
    expect(gone.verdict).toBe("disappeared");
    expect(gone.fails).toBe(false);
  });

  it("treats a sub-epsilon float wobble as flat", () => {
    expect(classifyDelta(delta("wer", 0.1234, 0.12345)).verdict).toBe("flat");
  });

  it("leaves an unknown metric ungated rather than silently guessing a threshold", () => {
    // Worse (an unthresholded metric defaults to higher-is-better, per direction.ts),
    // and still it must not fail a build — nobody has said how far is too far.
    const v = classifyDelta(delta("some_new_metric_nobody_thresholded", 0.9, 0.1));
    expect(v.verdict).toBe("ungated");
    expect(v.fails).toBe(false);
    expect(thresholdFor("some_new_metric_nobody_thresholded")).toBeNull();
  });

  it("gates every quality metric the runner actually writes", () => {
    // A metric the runner emits but nobody thresholded would be silently ungated.
    // This is the test that notices.
    for (const metric of ["wer", "cer", "wer_romanized", "chrf", "intent_accuracy"]) {
      expect(REGRESSION_THRESHOLDS[metric]).toBeGreaterThan(0);
    }
  });
});

describe("comparability", () => {
  it("compares two runs of the same configuration", () => {
    expect(comparability(run(), run()).comparable).toBe(true);
  });

  it("refuses to compare across a config change", () => {
    const c = comparability(run(), run({ config_hash: "sha256:deadbee" }));
    expect(c.comparable).toBe(false);
    expect(c.reasons[0]).toMatch(/config_hash/u);
  });

  it("refuses to compare across a golden-set change", () => {
    const c = comparability(run(), run({ golden_set_version: "2" }));
    expect(c.comparable).toBe(false);
    expect(c.reasons[0]).toMatch(/answer key/u);
  });
});

describe("summarize", () => {
  it("fails the build on a real regression between comparable runs", () => {
    const s = summarize([delta("wer", 0.1, 0.3)], run(), run());
    expect(s.shouldFailBuild).toBe(true);
    expect(s.failures).toHaveLength(1);
  });

  it("does NOT fail the build when the configuration changed", () => {
    // The config-hash rule. The WER doubled, and the harness still refuses to call
    // it a quality regression, because it cannot tell one from a decoding-param
    // change. It says so instead, and a human reads the diff.
    const s = summarize([delta("wer", 0.1, 0.3)], run(), run({ config_hash: "sha256:deadbee" }));
    expect(s.failures).toHaveLength(1);
    expect(s.comparable).toBe(false);
    expect(s.shouldFailBuild).toBe(false);
    expect(s.reasons).toHaveLength(1);
  });

  it("passes a clean run", () => {
    const s = summarize([delta("wer", 0.1, 0.09)], run(), run());
    expect(s.shouldFailBuild).toBe(false);
    expect(s.failures).toHaveLength(0);
  });
});
