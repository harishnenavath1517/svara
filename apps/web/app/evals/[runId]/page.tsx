import {
  diffRuns,
  getRun,
  listRuns,
  previousRun,
  samplesFor,
  scoresFor,
} from "@svara/db";
import { comparability } from "@svara/eval/regression";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiffTable } from "../../../components/diff-table";
import { JudgePanel } from "../../../components/judge-panel";
import { LatencyTable } from "../../../components/latency-table";
import { SttTable } from "../../../components/stt-table";
import { indexScores, languagesIn, shortHash, shortId } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * One run, per language, against a baseline.
 *
 * The baseline defaults to the previous scoring run and can be overridden with
 * `?against=<run_id>`. Whichever it is, the first thing rendered is whether the
 * two runs can be compared at all: if `config_hash` or `golden_set_version`
 * differs, a metric that moved may have moved because the *configuration* changed,
 * and presenting that as a quality regression would be the dashboard lying with a
 * straight face. So the diff is still shown — hiding it would be worse — and it is
 * stamped instead.
 */
export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ against?: string }>;
}) {
  const { runId } = await params;
  const { against } = await searchParams;

  const run = await getRun(runId);
  if (run === null) notFound();

  const [scores, samples, allRuns, defaultBase] = await Promise.all([
    scoresFor(runId),
    samplesFor(runId),
    listRuns(),
    previousRun(runId),
  ]);

  const base = against === undefined ? defaultBase : await getRun(against);
  const deltas = base === null ? [] : await diffRuns(base.run_id, runId);
  const compare = base === null ? null : comparability(base, run);

  const index = indexScores(scores);
  const langs = languagesIn(scores);

  return (
    <main className="wide">
      <p className="crumb">
        <Link href="/evals">← all runs</Link>
      </p>

      <h1>
        Run <code>{shortId(run.run_id)}</code>
      </h1>
      <p className="sub">
        {new Date(run.started_at).toLocaleString()} · {run.records_scored} records · git{" "}
        <code>{shortHash(run.git_sha)}</code> · config <code>{shortHash(run.config_hash)}</code> ·
        golden v{run.golden_set_version}
        {run.notes !== null && ` · ${run.notes}`}
      </p>

      {run.records_scored === 0 && (
        <div className="panel verdict-banner bad">
          <strong>This run scored zero records.</strong> It is not a passing run — the harness
          failed before it measured anything. Nothing below can be trusted, and the numbers that
          are missing are the point.
        </div>
      )}

      {/* The baseline picker. A plain form, no client JS: this is a link with extra steps. */}
      <form className="controls" method="get">
        <label className="label" htmlFor="against" style={{ margin: 0 }}>
          Diff against
        </label>
        <select id="against" name="against" defaultValue={base?.run_id ?? ""}>
          <option value="">— no baseline —</option>
          {allRuns
            .filter((r) => r.run_id !== run.run_id && r.records_scored > 0)
            .map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {shortId(r.run_id)} · {new Date(r.started_at).toLocaleDateString()} ·{" "}
                {r.records_scored} records · cfg {shortHash(r.config_hash)}
              </option>
            ))}
        </select>
        <button type="submit">Compare</button>
      </form>

      {compare !== null && !compare.comparable && (
        <div className="panel verdict-banner warn">
          <div className="label">Not comparable</div>
          <ul className="reasons">
            {compare.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="note">
            The diff below is real, but a moved metric here may be a configuration change rather
            than a quality change. It is reported and it does <strong>not</strong> fail the build.
            Read it with a human.
          </p>
        </div>
      )}

      {base !== null && <DiffTable deltas={deltas} comparable={compare?.comparable ?? false} />}

      {langs.length === 0 ? (
        <div className="panel">
          <p className="note">This run has no scores.</p>
        </div>
      ) : (
        langs.map((lang) => (
          <section key={lang} className="lang-section">
            <h2>{lang}</h2>
            <SttTable rows={scores} index={index} lang={lang} />
            <JudgePanel index={index} samples={samples} lang={lang} />
            <LatencyTable index={index} lang={lang} />
            <p className="note">
              <Link href={`/evals/${run.run_id}/samples?lang=${lang}`}>
                Read the {samples.filter((s) => s.lang === lang).length} per-record samples for{" "}
                {lang} →
              </Link>{" "}
              — the transcripts, the references, and the judge&rsquo;s stored rationale. An
              aggregate you cannot drill into is a number you can only worry about.
            </p>
          </section>
        ))
      )}
    </main>
  );
}
