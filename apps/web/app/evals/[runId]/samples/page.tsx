import { getRun, samplesFor } from "@svara/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatValue, shortId } from "../../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Per-record detail: the transcript, the reference, and the judge's stored
 * rationale.
 *
 * This is the page that turns "hi-IN code-mixed WER is 0.234" into "…because
 * Saaras wrote आधार कार्ड and the reference says Aadhaar card" — which is the
 * difference between a number you can act on and a number you can only worry
 * about. `samplesFor` orders worst-first, so the rows that explain an aggregate
 * are the rows you land on.
 */
export default async function SamplesPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ lang?: string; hop?: string; metric?: string }>;
}) {
  const { runId } = await params;
  const filter = await searchParams;

  const run = await getRun(runId);
  if (run === null) notFound();

  const samples = await samplesFor(runId, filter);
  const metrics = [...new Set(samples.map((s) => s.metric))].sort();

  return (
    <main className="wide">
      <p className="crumb">
        <Link href={`/evals/${runId}`}>← run {shortId(runId)}</Link>
      </p>

      <h1>Samples{filter.lang !== undefined && ` — ${filter.lang}`}</h1>
      <p className="sub">
        {samples.length} scored records, worst first. Filter:{" "}
        <Link href={`/evals/${runId}/samples?lang=${filter.lang ?? ""}`}>all metrics</Link>
        {metrics.map((m) => (
          <span key={m}>
            {" · "}
            <Link
              href={`/evals/${runId}/samples?lang=${filter.lang ?? ""}&metric=${m}`}
              className={filter.metric === m ? "active" : ""}
            >
              {m}
            </Link>
          </span>
        ))}
      </p>

      {samples.length === 0 ? (
        <div className="panel">
          <p className="note">No samples match.</p>
        </div>
      ) : (
        <div className="panel">
          <table className="samples">
            <thead>
              <tr>
                <th>record</th>
                <th>hop</th>
                <th>metric</th>
                <th className="num">value</th>
                <th>expected</th>
                <th>actual</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => (
                <tr
                  key={`${s.record_id}|${s.hop}|${s.metric}`}
                  className={s.error_code !== null ? "row-fail" : ""}
                >
                  <td>
                    <code>{s.record_id}</code>
                    <div className="muted">{s.lang}</div>
                  </td>
                  <td>{s.hop}</td>
                  <td>
                    <code>{s.metric}</code>
                  </td>
                  <td className="num">
                    {/* An error is not a zero. A record the scorer could not score is
                        counted as unscored, never as a score of 0 — the difference
                        between "the model failed" and "the API did". */}
                    {s.error_code !== null ? (
                      <span className="tag bad">{s.error_code}</span>
                    ) : (
                      formatValue(s.metric, s.value)
                    )}
                  </td>
                  <td className="text">{s.expected ?? "—"}</td>
                  <td className="text">
                    {s.actual ?? "—"}
                    {s.rationale !== null && (
                      <details className="rationale">
                        <summary>judge&rsquo;s rationale</summary>
                        <p>{s.rationale}</p>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
