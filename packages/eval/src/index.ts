/**
 * The eval plane: golden-set loader, scorers, judge, and the run/diff machinery.
 * This is the differentiator — see docs/EVAL_STRATEGY.md.
 *
 * The `eval_runs` / `eval_scores` row types live in @svara/db, next to the SQL
 * that defines them, rather than being redeclared here where they could drift out
 * of sync with the schema they claim to describe.
 */
export * from "./golden.js";
export * from "./intent.js";
export * from "./judge.js";
export * from "./metrics/agreement.js";
export * from "./metrics/chrf.js";
export * from "./metrics/direction.js";
export * from "./metrics/latency.js";
export * from "./metrics/normalize.js";
export * from "./metrics/wer.js";
export * from "./pipeline.js";
export * from "./run.js";
