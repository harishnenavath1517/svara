import {
  diffRuns,
  getRun,
  previousRun,
  runForGitSha,
  saveReport,
  type EvalRunRow,
} from "@svara/db";
import { summarize, type RegressionSummary } from "./metrics/regression.js";

/**
 * What `pnpm eval:report` does now that it has a job.
 *
 * Before Phase 3 it re-printed the latest run to stdout, which is a thing you can
 * do with `psql`. Its job now is to produce the *verdict* — head vs baseline,
 * classified, comparability checked — and to persist it, so that three consumers
 * cannot disagree about it:
 *
 *   - the dashboard, which renders the banner on /evals,
 *   - CI, which fails the build on it,
 *   - and whoever runs the command by hand.
 *
 * Recomputing the verdict independently in each of those is how the dashboard ends
 * up green while CI is red, and then nobody trusts either. `eval_reports` is a
 * cache of a pure function of `eval_scores` — it can be thrown away and rebuilt —
 * but it is the *one* copy everything reads.
 */

export interface Report {
  head: EvalRunRow;
  base: EvalRunRow | null;
  summary: RegressionSummary | null;
}

/**
 * Diffs `head` against `base` (defaulting to the previous scoring run) and stores
 * the verdict.
 *
 * A run with no baseline is not an error and is not a failure: the first run ever
 * has nothing to regress against. It gets a report with a null summary, and the
 * dashboard says so.
 */
export async function buildReport(headRunId: string, baseRef?: string): Promise<Report> {
  const head = await getRun(headRunId);
  if (head === null) throw new Error(`no run ${headRunId}`);

  const base = await resolveBase(headRunId, baseRef);

  if (base === null) {
    await saveReport({
      run_id: head.run_id,
      base_run_id: null,
      comparable: false,
      notes: "no baseline: nothing earlier to diff against",
      summary: { deltas: [], failures: [], comparable: false, reasons: [], shouldFailBuild: false },
    });
    return { head, base: null, summary: null };
  }

  const summary = summarize(await diffRuns(base.run_id, head.run_id), base, head);

  await saveReport({
    run_id: head.run_id,
    base_run_id: base.run_id,
    comparable: summary.comparable,
    notes: summary.reasons.join(" "),
    summary,
  });

  return { head, base, summary };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Resolves what to diff against.
 *
 *   auto | (omitted)   the previous scoring run — what a human at a terminal means
 *   <uuid>             that exact run
 *   <git sha>          the run recorded at that commit — what CI means
 *
 * The git-sha form exists because "the previous run" is the wrong baseline on a
 * pull request: the previous row in the table might belong to a different branch,
 * and a PR gated against another PR is noise. CI passes `origin/main`'s sha, so a
 * branch is always measured against the thing it is proposing to change.
 */
async function resolveBase(headRunId: string, baseRef?: string): Promise<EvalRunRow | null> {
  if (baseRef === undefined || baseRef === "auto") return previousRun(headRunId);
  if (baseRef === "latest") return previousRun(headRunId);
  if (UUID.test(baseRef)) return getRun(baseRef);
  return runForGitSha(baseRef);
}

/**
 * The CI comment. Markdown, because that is what a PR renders — and because a
 * regression that only exists in a job log is a regression nobody reads.
 */
export function toMarkdown({ head, base, summary }: Report): string {
  const lines: string[] = [];
  lines.push(`### svara eval — \`${short(head.run_id)}\``);
  lines.push("");
  lines.push(
    `${head.records_scored} records · golden v${head.golden_set_version} · config \`${short(head.config_hash)}\``,
  );
  lines.push("");

  if (base === null || summary === null) {
    lines.push("_No baseline run to diff against — nothing to regress from yet._");
    return lines.join("\n");
  }

  lines.push(`Baseline: \`${short(base.run_id)}\` (${base.records_scored} records)`);
  lines.push("");

  if (!summary.comparable) {
    lines.push("> **⚠ NOT COMPARABLE — this diff does not gate the build.**");
    for (const reason of summary.reasons) lines.push(`> - ${reason}`);
    lines.push(">");
    lines.push(
      "> The numbers below are real, but a metric that moved may have moved because the " +
        "configuration changed rather than because quality did. A human has to read this one.",
    );
    lines.push("");
  } else if (summary.failures.length === 0) {
    lines.push("✅ **No regressions.** Every gated metric held.");
    lines.push("");
  } else {
    lines.push(
      `❌ **${summary.failures.length} metric${summary.failures.length === 1 ? "" : "s"} regressed past threshold.**`,
    );
    lines.push("");
  }

  const moved = summary.deltas.filter((d) => d.verdict !== "flat");
  if (moved.length === 0) {
    lines.push("_No metric moved._");
    return lines.join("\n");
  }

  lines.push("| | lang | hop | metric | slice | base | head | Δ | threshold |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const d of moved) {
    lines.push(
      `| ${icon(d.verdict)} | ${d.lang} | ${d.hop} | \`${d.metric}\` | ${d.slice} | ` +
        `${num(d.before)} | ${num(d.after)} | ${signed(d.delta)} | ${d.threshold ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    `_${summary.deltas.length - moved.length} metrics did not move. Thresholds and the reasons ` +
      "for them: `packages/eval/src/metrics/regression.ts`._",
  );

  return lines.join("\n");
}

function icon(verdict: string): string {
  switch (verdict) {
    case "regressed_past_threshold":
      return "❌";
    case "regressed":
    case "ungated":
      return "⚠️";
    case "improved":
      return "✅";
    case "appeared":
      return "🆕";
    case "disappeared":
      return "👻";
    default:
      return "";
  }
}

function num(v: number | null): string {
  return v === null ? "—" : v.toFixed(3);
}

function signed(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(3)}`;
}

function short(id: string): string {
  return id.replace(/^sha256:/u, "").slice(0, 8);
}
