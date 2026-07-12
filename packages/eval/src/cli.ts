import { closeDb, diffRuns, getRun, latestRun, pingDb, scoresFor } from "@svara/db";
import { HOPS, isLanguageCode } from "@svara/shared";
import type { Hop, LanguageCode } from "@svara/shared";
import { availableLanguages } from "./golden.js";
import { formatConfusion } from "./intent.js";
import { isImprovement } from "./metrics/direction.js";
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
 *   pnpm eval:report                   re-print the latest run
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
}

async function doReport(): Promise<void> {
  if (!(await pingDb())) die("Postgres unreachable. Run `pnpm infra:up` first.");

  const run = await latestRun();
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
