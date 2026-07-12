import { classifyDelta, NOT_GATED, type DeltaVerdict } from "@svara/eval/regression";
import type { ScoreDelta } from "@svara/db";
import { formatDelta, formatValue } from "../lib/format";

/**
 * Run-over-run deltas — the deliverable.
 *
 * Two things this table does not do, on purpose:
 *
 * 1. **It does not decide which way is up.** `classifyDelta` does, and it defers to
 *    `isImprovement`, which is unit-tested and lives next to the scorers. The one
 *    time that direction logic was retyped by hand into a rendering layer, the
 *    regex dropped `unparseable` and the diff cheerfully reported a judge that had
 *    started *failing* as an improvement. A component is the worst place in the
 *    codebase to keep a fact that has to be right.
 *
 * 2. **It does not hide the rows that did not move.** They collapse behind a
 *    summary line, but "23 metrics flat" is itself the most reassuring sentence on
 *    the page, and a diff that only ever shows movement can't say it.
 */

/** Rows ordered so the reader's eye lands on the build-breaking ones first. */
const VERDICT_ORDER: Record<DeltaVerdict["verdict"], number> = {
  regressed_past_threshold: 0,
  regressed: 1,
  disappeared: 2,
  appeared: 3,
  ungated: 4,
  improved: 5,
  flat: 6,
};

const VERDICT_LABEL: Record<DeltaVerdict["verdict"], string> = {
  regressed_past_threshold: "regression",
  regressed: "worse",
  disappeared: "gone",
  appeared: "new",
  ungated: "worse (ungated)",
  improved: "better",
  flat: "flat",
};

export function DiffTable({
  deltas,
  comparable,
}: {
  deltas: ScoreDelta[];
  comparable: boolean;
}) {
  const classified = deltas
    .map(classifyDelta)
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        a.lang.localeCompare(b.lang) ||
        a.metric.localeCompare(b.metric),
    );

  const moved = classified.filter((d) => d.verdict !== "flat");
  const flat = classified.length - moved.length;
  const failures = classified.filter((d) => d.fails);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Run-over-run diff</h3>
        <p className="note">
          {failures.length === 0 ? (
            <>No metric regressed past its threshold.</>
          ) : (
            <>
              <strong className="over-budget">
                {failures.length} metric{failures.length === 1 ? "" : "s"} regressed past threshold
              </strong>
              {comparable
                ? " — this diff would fail CI."
                : " — but the runs are not comparable (see above), so this does not fail CI."}
            </>
          )}{" "}
          {flat} of {classified.length} metrics did not move.
        </p>
      </div>

      {moved.length === 0 ? (
        <p className="note">Nothing moved. Every metric scored identically in both runs.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>lang</th>
              <th>hop</th>
              <th>metric</th>
              <th>slice</th>
              <th className="num">base</th>
              <th className="num">head</th>
              <th className="num">Δ</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {moved.map((d) => (
              <tr key={`${d.lang}|${d.hop}|${d.metric}|${d.slice}`} className={rowClass(d)}>
                <td>{d.lang}</td>
                <td>{d.hop}</td>
                <td>
                  <code>{d.metric}</code>
                </td>
                <td className="muted">{d.slice}</td>
                <td className="num muted">{formatValue(d.metric, d.before)}</td>
                <td className="num">{formatValue(d.metric, d.after)}</td>
                <td className="num">{formatDelta(d.metric, d.delta)}</td>
                <td>
                  <span className={`verdict ${d.verdict}`} title={verdictTitle(d)}>
                    {VERDICT_LABEL[d.verdict]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function rowClass(d: DeltaVerdict): string {
  if (d.fails) return "row-fail";
  if (d.verdict === "appeared" || d.verdict === "disappeared") return "row-schema";
  return "";
}

/** The tooltip carries the *reason*, so "ungated" is never just an absence. */
function verdictTitle(d: DeltaVerdict): string {
  if (d.verdict === "ungated") {
    return NOT_GATED[d.metric] ?? `${d.metric} has no threshold: it is reported, not gated.`;
  }
  if (d.verdict === "appeared") {
    return "Scored in this run and not the baseline — a scorer or a language was added.";
  }
  if (d.verdict === "disappeared") {
    return "Scored in the baseline and not this run — a scorer stopped producing a number. Not a quality regression, but not nothing.";
  }
  if (d.threshold !== null) {
    return `threshold: ${d.threshold}`;
  }
  return "";
}
