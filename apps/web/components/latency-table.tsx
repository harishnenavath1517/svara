import { LATENCY_BUDGET_MS } from "@svara/shared";
import { NOT_GATED } from "@svara/eval/regression";
import { formatValue, pick, type ScoreIndex } from "../lib/format";

/**
 * Latency, per hop, against the budget.
 *
 * Three things this component refuses to do, each of which a naive latency chart
 * does by default:
 *
 * 1. **It leads with TTFB, not wall time.** For a voice agent `ttfb_ms` is the
 *    number that matters: a TTS hop that takes 6s but starts speaking in 500ms is
 *    a good turn, and the reverse is a dead call. Wall time is shown greyed,
 *    second, where it belongs.
 *
 * 2. **It does not put offline-eval latency and live-trace latency on one axis.**
 *    They measure different things. A live STT hop's wall clock spans the caller
 *    actually *speaking* — Saaras emits nothing until the VAD endpoint triggers a
 *    flush — so the ~5s in live traces is a human talking, not a slow model. This
 *    table is the offline eval, which times STT from audio-feed-start, and it says
 *    so. The live numbers live on /traces, separately, and they stay there.
 *
 * 3. **It marks p99 as ungated rather than pretending it is a signal.** At n=20 the
 *    p99 is the maximum in disguise: it moved 732ms between two runs of *identical*
 *    code. It is shown, because a tail is worth looking at; it does not gate, and
 *    the page says which.
 */

const HOPS = ["stt", "llm", "tts"] as const;

export function LatencyTable({ index, lang }: { index: ScoreIndex; lang: string }) {
  const rows = HOPS.map((hop) => ({
    hop,
    ttfb50: pick(index, lang, hop, "ttfb_p50"),
    ttfb95: pick(index, lang, hop, "ttfb_p95"),
    ttfb99: pick(index, lang, hop, "ttfb_p99"),
    wall50: pick(index, lang, hop, "latency_p50"),
    wall95: pick(index, lang, hop, "latency_p95"),
    budget: LATENCY_BUDGET_MS[hop],
  })).filter((r) => r.ttfb50 !== undefined || r.wall50 !== undefined);

  if (rows.length === 0) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Latency — {lang}</h3>
        <p className="note">
          <strong>Offline eval timings.</strong> STT is timed from audio-feed-start here. This is
          not the same measurement as the STT hop on a live call, whose wall clock spans the caller
          speaking — see <a href="/traces">live traces</a>, and never put the two on one axis.
        </p>
      </div>

      <table>
        <thead>
          <tr>
            <th>hop</th>
            <th className="num">ttfb p50</th>
            <th className="num">budget</th>
            <th className="num">ttfb p95</th>
            <th className="num">
              ttfb p99 <span className="tag">ungated</span>
            </th>
            <th className="num muted">wall p50</th>
            <th className="num muted">wall p95</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const overBudget = r.ttfb50 !== undefined && r.ttfb50.value > r.budget;
            return (
              <tr key={r.hop}>
                <td>{r.hop.toUpperCase()}</td>
                <td className={`num ${overBudget ? "over-budget" : "good"}`}>
                  {formatValue("ttfb_p50", r.ttfb50?.value ?? null)}
                </td>
                <td className="num muted">{r.budget} ms</td>
                <td className="num">{formatValue("ttfb_p95", r.ttfb95?.value ?? null)}</td>
                <td className="num muted" title={NOT_GATED.ttfb_p99}>
                  {formatValue("ttfb_p99", r.ttfb99?.value ?? null)}
                </td>
                <td className="num muted">{formatValue("latency_p50", r.wall50?.value ?? null)}</td>
                <td className="num muted" title={NOT_GATED.latency_p95}>
                  {formatValue("latency_p95", r.wall95?.value ?? null)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="note">
        End-to-end first-audio budget: <strong>{LATENCY_BUDGET_MS.endToEndFirstAudio} ms</strong>{" "}
        (mic close → first audio at the caller). That one is measured on live turns, not here.
      </p>
    </div>
  );
}
