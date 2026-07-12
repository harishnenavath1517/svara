/**
 * Eval runner CLI. Wired to `pnpm eval` and `pnpm eval:report` at the root.
 *
 * Phase 2 implements this: `pnpm eval [--lang] [--hop] [--against]` replays the
 * golden set, scores every hop per language, and persists a versioned run you
 * can diff. Until then it exits non-zero rather than reporting a hollow pass —
 * a green eval that scored nothing is worse than no eval.
 */
const command = process.argv[2];

const PHASE_2 =
  "Not implemented until Phase 2 (see docs/ROADMAP.md). The runner will replay\n" +
  "evals/golden/<lang>.jsonl through the pipeline and write eval_runs + eval_scores.";

switch (command) {
  case "run":
    console.error(`svara eval: run\n${PHASE_2}`);
    process.exit(1);
    break;
  case "report":
    console.error(`svara eval: report\n${PHASE_2}`);
    process.exit(1);
    break;
  default:
    console.error(`svara eval: unknown command ${String(command)}. Expected "run" or "report".`);
    process.exit(2);
}
