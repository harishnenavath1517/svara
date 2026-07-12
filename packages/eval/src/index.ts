/**
 * The eval plane: golden-set loader, scorers, judge, and the run/diff machinery.
 * This is the differentiator — see docs/EVAL_STRATEGY.md.
 *
 * The `eval_runs` / `eval_scores` row types live in @svara/db, next to the SQL
 * that defines them, rather than being redeclared here where they could drift out
 * of sync with the schema they claim to describe.
 *
 * This entry point pulls in `run.js`, and therefore the Temporal SDK. The
 * dashboard needs the *scorers'* judgement (which way is up, what counts as a
 * regression) and none of the machinery, so `direction` and `regression` are also
 * published as their own subpaths — `@svara/eval/regression` — and Next imports
 * those. Importing them from here would drag a workflow runtime into a React
 * server component.
 */
export * from "./golden.js";
export * from "./intent.js";
export * from "./judge.js";
export * from "./metrics/agreement.js";
export * from "./metrics/chrf.js";
export * from "./metrics/direction.js";
export * from "./metrics/latency.js";
export * from "./metrics/normalize.js";
export * from "./metrics/regression.js";
export * from "./metrics/wer.js";
export * from "./pipeline.js";
export * from "./report.js";
export * from "./run.js";
