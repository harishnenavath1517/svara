import { latestReport, listRuns, previousRun } from "@svara/db";
import Link from "next/link";
import { shortHash, shortId } from "../../lib/format";

/**
 * The run list.
 *
 * Hollow runs — `records_scored = 0` — are listed, and listed as hollow. A run
 * that scored nothing is not a passing run; it is a harness that fell over, and
 * the single most expensive thing this page could do is render it as a green row
 * that nobody looks at twice. `pnpm eval` exits non-zero for the same reason
 * (CLAUDE.md).
 */

// Read Postgres on every request. These rows change when someone runs the harness,
// not when someone builds the app, and a cached eval dashboard is a lying one.
export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  const [runs, report] = await Promise.all([listRuns(), latestReport()]);

  // The default baseline for each run's "diff" link: the previous run that
  // actually scored something.
  const baselines = await Promise.all(
    runs.map(async (run) => (run.records_scored > 0 ? await previousRun(run.run_id) : null)),
  );

  const failures = summaryFailures(report?.summary);

  return (
    <main className="wide">
      <h1>Eval runs</h1>
      <p className="sub">
        Every run of the offline harness against the golden set. Pick a run to see its scores;
        pick a baseline to diff it against — the diff is the deliverable.
      </p>

      {report !== null && (
        <div className={`panel verdict-banner ${verdictClass(report.comparable, failures)}`}>
          <div className="label">Latest report — {shortId(report.run_id)}</div>
          <div className="line">
            {failures === null ? (
              "No verdict recorded. Run `pnpm eval:report`."
            ) : !report.comparable ? (
              <>
                <strong>Not comparable to its baseline.</strong> {report.notes ?? ""} The diff is
                shown, but it cannot be read as a quality change and it does not fail CI.
              </>
            ) : failures === 0 ? (
              <>
                <strong>No regressions.</strong> Every gated metric held against baseline{" "}
                {report.base_run_id === null ? "—" : shortId(report.base_run_id)}.
              </>
            ) : (
              <>
                <strong>
                  {failures} metric{failures === 1 ? "" : "s"} regressed past threshold
                </strong>{" "}
                against baseline {report.base_run_id === null ? "—" : shortId(report.base_run_id)}.
                This would fail CI.
              </>
            )}
          </div>
        </div>
      )}

      {runs.length === 0 ? (
        <div className="panel">
          <p className="note">
            No runs yet. <code>pnpm eval</code> writes one — it costs ~360 Sarvam calls and about
            twelve minutes.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>run</th>
                <th>started</th>
                <th className="num">records</th>
                <th>git</th>
                <th>config</th>
                <th>golden</th>
                <th>notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const base = baselines[i] ?? null;
                const hollow = run.records_scored === 0;
                return (
                  <tr key={run.run_id} className={hollow ? "row-hollow" : ""}>
                    <td>
                      <Link href={`/evals/${run.run_id}`}>
                        <code>{shortId(run.run_id)}</code>
                      </Link>
                    </td>
                    <td className="muted">{new Date(run.started_at).toLocaleString()}</td>
                    <td className="num">
                      {run.records_scored}
                      {hollow && <span className="tag bad">scored nothing</span>}
                    </td>
                    <td className="muted">
                      <code>{shortHash(run.git_sha)}</code>
                    </td>
                    <td className="muted">
                      <code>{shortHash(run.config_hash)}</code>
                    </td>
                    <td className="muted">v{run.golden_set_version}</td>
                    <td className="muted">{run.notes ?? "—"}</td>
                    <td>
                      {base !== null && (
                        <Link
                          className="pill"
                          href={`/evals/${run.run_id}?against=${base.run_id}`}
                        >
                          diff vs {shortId(base.run_id)}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="note">
            A run that scored zero records is shown, not hidden. It is a broken harness, not a
            passing build — and the only thing worse than a red eval is a green one that never ran.
          </p>
        </div>
      )}
    </main>
  );
}

/** Pulls the failure count out of the stored summary without trusting its shape. */
function summaryFailures(summary: unknown): number | null {
  if (typeof summary !== "object" || summary === null) return null;
  const failures = (summary as { failures?: unknown }).failures;
  return Array.isArray(failures) ? failures.length : null;
}

function verdictClass(comparable: boolean, failures: number | null): string {
  if (failures === null) return "";
  if (!comparable) return "warn";
  return failures === 0 ? "ok" : "bad";
}
