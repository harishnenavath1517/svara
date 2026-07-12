import { closeDb, diffRuns, getRun, latestRun, pingDb, scoresFor } from "@svara/db";
import { writeFile } from "node:fs/promises";
import { HOPS, isLanguageCode } from "@svara/shared";
import type { Hop, LanguageCode } from "@svara/shared";
import { availableLanguages } from "./golden.js";
import { formatConfusion } from "./intent.js";
import { isImprovement } from "./metrics/direction.js";
import { buildReport, toMarkdown } from "./report.js";
import { runEval } from "./run.js";

/**
 * The eval runner CLI.
 *
 *   pnpm eval                          full set, all built languages
 *   pnpm eval --lang ta-IN             one language
 *   pnpm eval --hop stt                one hop
 *   pnpm eval --against <run_id>       diff against a previous run
 *   pnpm eval --against latest         diff against the last scoring run
 *   pnpm eval --skip-judge             fast pass: skip the slow, expensive judge
 *   pnpm eval --fail-on-regression     exit non-zero if a gated metric regressed (CI)
 *   pnpm eval:report                   diff the latest run vs its baseline, store the
 *                                      verdict the dashboard reads, print markdown
 *   pnpm eval:report --run <id> --against <id> --markdown <path>
 *
 * **This command exits non-zero unless it actually scored something**, and that is
 * the design, not a placeholder. A harness whose failure mode is "green and empty"
 * is worse than no harness at all, because a green run is a claim someone will act
 * on. If the golden set is missing, or Postgres is down, or every record failed to
 * replay, you find out from the exit code — not from a suspiciously empty table
 * three weeks later.
 */

const args = process.argv.slice(2);
const command = args[0] ?? "run";

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? null);
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

function die(message: string, code = 1): never {
  console.error(`svara eval: ${message}`);
  process.exit(code);
}

async function resolveLanguages(): Promise<LanguageCode[]> {
  const requested = flag("lang");
  if (requested !== null) {
    if (!isLanguageCode(requested)) die(`unknown language "${requested}"`, 2);
    return [requested];
  }
  const built = await availableLanguages();
  if (built.length === 0) {
    die("no golden set found. Build it first:\n  pnpm golden:build");
  }
  return built;
}

function resolveHops(): Hop[] | null {
  const requested = flag("hop");
  if (requested === null) return null;
  if (!(HOPS as readonly string[]).includes(requested)) {
    die(`unknown hop "${requested}". Expected one of: ${HOPS.join(", ")}`, 2);
  }
  return [requested as Hop];
}

type ScoreRows = Awaited<ReturnType<typeof scoresFor>>;

/** Groups the deliberately-tall score rows back into a table a human can read. */
function printScores(rows: ScoreRows): void {
  const byHop = new Map<string, ScoreRows>();
  for (const row of rows) {
    const existing = byHop.get(row.hop);
    if (existing === undefined) byHop.set(row.hop, [row]);
    else existing.push(row);
  }

  for (const [hop, hopRows] of byHop) {
    console.log(`\n  ${hop.toUpperCase()}`);
    for (const row of hopRows) {
      const isTime = row.metric.includes("ttfb") || row.metric.includes("latency");
      const value = isTime ? `${Math.round(row.value)}ms` : row.value.toFixed(3);
      const slice = row.slice === "all" ? "" : `  [${row.slice}]`;
      console.log(
        `    ${row.lang}  ${row.metric.padEnd(24)}${value.padStart(9)}  (n=${row.n})${slice}`,
      );
    }
  }
}

async function doDiff(baseRef: string, headRunId: string): Promise<void> {
  const base = baseRef === "latest" ? await latestRun() : await getRun(baseRef);
  if (base === null) die(`no run found for --against ${baseRef}`);
  if (base.run_id === headRunId) return;

  const head = await getRun(headRunId);
  console.log(`\n[eval] diff vs ${base.run_id}  (${base.git_sha}, ${base.started_at})`);

  if (head !== null && base.config_hash !== head.config_hash) {
    // The reason config_hash is stored on every run. Without this line, a metric
    // that moved because someone changed a decoding param reads as a model
    // regression, and the team goes hunting for a bug that does not exist.
    console.log(
      "  note: these runs have DIFFERENT config hashes — a metric that moved may be a\n" +
        "        configuration change, not a quality change.",
    );
  }
  if (base.golden_set_version !== (head?.golden_set_version ?? base.golden_set_version)) {
    console.log(
      "  note: these runs used DIFFERENT golden-set versions — the answer key changed,\n" +
        "        so these numbers are not directly comparable.",
    );
  }

  const moved = (await diffRuns(base.run_id, headRunId)).filter(
    (d) => d.delta !== null && Math.abs(d.delta) > 0.001,
  );

  if (moved.length === 0) {
    console.log("  no metric moved.");
    return;
  }

  for (const d of moved) {
    // Direction is per-metric and is NOT inlined here: an error rate going down is
    // good, a judge score going down is bad, and a hand-typed regex got that wrong
    // the first time. See metrics/direction.ts, which is tested.
    const delta = d.delta ?? 0;
    const slice = d.slice === "all" ? "" : ` [${d.slice}]`;
    console.log(
      `  ${isImprovement(d.metric, delta) ? "▼ better" : "▲ WORSE "}  ${d.lang}  ` +
        `${d.hop}/${d.metric}${slice}  ${fmtValue(d.before)} → ${fmtValue(d.after)}  ` +
        `(${delta > 0 ? "+" : ""}${delta.toFixed(3)})`,
    );
  }
}

function fmtValue(v: number | null): string {
  return v === null ? "--" : v.toFixed(3);
}

async function doRun(): Promise<void> {
  if (!(await pingDb())) die("Postgres unreachable. Run `pnpm infra:up` first.");

  const languages = await resolveLanguages();
  const summary = await runEval({
    languages,
    hops: resolveHops(),
    notes: flag("notes"),
    skipJudge: has("skip-judge"),
  });

  // The whole point of the harness, in one branch.
  if (summary.recordsScored === 0) {
    die(
      "scored 0 records — the golden set is empty, or every record failed to replay.\n" +
        "Refusing to report a green run that measured nothing.",
    );
  }

  console.log(`\n[eval] run ${summary.runId} — ${summary.recordsScored} records scored`);
  printScores(summary.scores);

  for (const [lang, confusion] of summary.confusion) {
    console.log(`\n  INTENT CONFUSION — ${lang}  (accuracy ${confusion.accuracy.toFixed(3)})`);
    console.log(formatConfusion(confusion));
  }

  const against = flag("against");
  if (against !== null) await doDiff(against, summary.runId);
  else console.log(`\n[eval] diff a future run against this one with:\n  pnpm eval --against ${summary.runId}`);

  // CI's entry point. The gate is deliberately the *last* thing a run does: the
  // scores are already written and the report already stored, so a red build still
  // leaves a run in the dashboard for someone to open and read. A gate that exits
  // before it persists what it was angry about is a gate that cannot be argued with.
  if (has("fail-on-regression")) await gate(summary.runId, against ?? "auto");
}

/**
 * Stores the verdict, prints it, and decides the build.
 *
 * Note what does NOT fail here: an incomparable diff (different `config_hash` or
 * `golden_set_version`). `summarize` owns that rule — a PR that changes a prompt
 * changes the config hash, and a metric that moved under it may be a configuration
 * change rather than a quality change. Failing the build on that would be the
 * harness lying on its own authority. It is loudly labelled instead, and read by a
 * human.
 */
async function gate(runId: string, baseRef: string): Promise<void> {
  const report = await buildReport(runId, baseRef);
  const markdownPath = flag("markdown");
  const markdown = toMarkdown(report);
  if (markdownPath !== null) await writeFile(markdownPath, markdown, "utf8");

  const { summary } = report;
  if (summary === null) {
    console.log("\n[eval] no baseline — nothing to regress against. Build stays green.");
    return;
  }

  if (!summary.comparable) {
    console.log(`\n[eval] NOT COMPARABLE — ${summary.reasons.join(" ")}`);
    console.log("[eval] the diff does not gate this build. Read it by hand.");
    return;
  }

  if (summary.shouldFailBuild) {
    console.error(`\n[eval] REGRESSION — ${summary.failures.length} metric(s) past threshold:`);
    for (const f of summary.failures) {
      console.error(
        `  ${f.lang}  ${f.hop}/${f.metric}${f.slice === "all" ? "" : ` [${f.slice}]`}  ` +
          `${fmtValue(f.before)} → ${fmtValue(f.after)}  (threshold ${f.threshold})`,
      );
    }
    console.error("\n  Thresholds and why: packages/eval/src/metrics/regression.ts");
    process.exitCode = 1;
    return;
  }

  console.log("\n[eval] no regression past threshold.");
}

/**
 * `pnpm eval:report` — the command that gives the dashboard and CI a single verdict
 * to agree on. It scores nothing and calls no model; it reads `eval_scores` and
 * writes `eval_reports`, so it is cheap to re-run and safe to run anywhere.
 */
async function doReport(): Promise<void> {
  if (!(await pingDb())) die("Postgres unreachable. Run `pnpm infra:up` first.");

  const requested = flag("run");
  const run = requested === null ? await latestRun() : await getRun(requested);
  if (run === null) die("no scoring run found. Run `pnpm eval` first.");

  console.log(
    `[eval] run ${run.run_id}\n` +
      `  git_sha      ${run.git_sha}\n` +
      `  config_hash  ${run.config_hash}\n` +
      `  golden_set   v${run.golden_set_version}\n` +
      `  records      ${run.records_scored}\n` +
      `  started      ${run.started_at}`,
  );
  printScores(await scoresFor(run.run_id));

  const report = await buildReport(run.run_id, flag("against") ?? "auto");
  const markdownPath = flag("markdown");
  if (markdownPath !== null) {
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    console.log(`\n[eval] wrote ${markdownPath}`);
  }

  console.log(`\n${toMarkdown(report)}`);
  console.log(`\n[eval] verdict stored. The dashboard reads it at /evals/${run.run_id}`);

  if (has("fail-on-regression") && report.summary?.shouldFailBuild === true) {
    process.exitCode = 1;
  }
}

try {
  switch (command) {
    case "run":
      await doRun();
      break;
    case "report":
      await doReport();
      break;
    default:
      die(`unknown command "${command}". Expected "run" or "report".`, 2);
  }
} catch (err) {
  console.error("svara eval: fatal:", err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
