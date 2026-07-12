import { errorRates, hopLatencies, listTurns } from "@svara/db";
import { LATENCY_BUDGET_MS } from "@svara/shared";
import Link from "next/link";
import { shortId } from "../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Live turns — the runtime plane, kept deliberately separate from the eval plane.
 *
 * These latencies are NOT the ones on a run page and must never be charted on the
 * same axis. A live STT hop's wall clock spans the caller actually *speaking*:
 * Saaras emits nothing until the VAD endpoint triggers a flush, so a 5.2s STT
 * `latency_ms` here is a human talking, not a slow model. The offline eval times
 * STT from audio-feed-start instead, which is the number that can be compared
 * across runs. Both are true; they measure different things; the page says which.
 *
 * Failed and cancelled turns are listed, not filtered. A rising cancel rate means
 * callers are talking over the agent — it is too slow or too verbose — and no WER
 * will ever show you that (docs/EVAL_STRATEGY.md §6).
 */
export default async function TracesPage() {
  const [turns, latencies, errors] = await Promise.all([
    listTurns(),
    hopLatencies(),
    errorRates(),
  ]);

  return (
    <main className="wide">
      <h1>Live traces</h1>
      <p className="sub">
        Real turns off the bus. Click one to hear what the caller actually said and what the agent
        actually replied — the stored audio, not a re-synthesis.
      </p>

      <div className="panel">
        <div className="panel-head">
          <h3>Latency on live traffic</h3>
          <p className="note">
            <strong>`ttfb_ms` is the number that matters here, not `latency_ms`.</strong> A live STT
            hop&rsquo;s wall clock spans the caller speaking, so its <code>latency_ms</code> is
            roughly utterance duration — a person talking, not a slow model. These are not the same
            measurement as the offline eval&rsquo;s STT timings on the{" "}
            <Link href="/evals">run pages</Link>, and the two do not belong on one axis.
          </p>
        </div>
        <table>
          <thead>
            <tr>
              <th>hop</th>
              <th>lang</th>
              <th className="num">n</th>
              <th className="num">ttfb p50</th>
              <th className="num">budget</th>
              <th className="num">ttfb p95</th>
              <th className="num muted">wall p50</th>
            </tr>
          </thead>
          <tbody>
            {latencies.map((l) => {
              const budget = LATENCY_BUDGET_MS[l.hop];
              const over = l.ttfb_p50 !== null && l.ttfb_p50 > budget;
              return (
                <tr key={`${l.hop}|${l.lang}`}>
                  <td>{l.hop.toUpperCase()}</td>
                  <td>{l.lang}</td>
                  <td className="num muted">{l.n}</td>
                  <td className={`num ${over ? "over-budget" : "good"}`}>{ms(l.ttfb_p50)}</td>
                  <td className="num muted">{budget} ms</td>
                  <td className="num">{ms(l.ttfb_p95)}</td>
                  <td
                    className="num muted"
                    title={
                      l.hop === "stt"
                        ? "Spans the caller speaking. This is utterance duration, not model latency."
                        : undefined
                    }
                  >
                    {ms(l.latency_p50)}
                    {l.hop === "stt" && <span className="tag">not model latency</span>}
                  </td>
                </tr>
              );
            })}
            {latencies.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No traces yet. Make a call, or run{" "}
                  <code>pnpm --filter @svara/eval run smoke</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {errors.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>Failures &amp; cancellations</h3>
            <p className="note">
              A rising <code>cancelled</code> rate means callers are talking over the agent. A rising{" "}
              <code>empty_transcript</code> rate means VAD is firing on noise and the agent is being
              handed silence to answer. Neither shows up in any WER.
            </p>
          </div>
          <table>
            <thead>
              <tr>
                <th>hop</th>
                <th>lang</th>
                <th>error</th>
                <th className="num">n</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e) => (
                <tr key={`${e.hop}|${e.lang}|${e.error_code}`}>
                  <td>{e.hop}</td>
                  <td>{e.lang}</td>
                  <td>
                    <span className="tag bad">{e.error_code}</span>
                  </td>
                  <td className="num">{e.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>Recent turns</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>trace</th>
              <th>session</th>
              <th className="num">turn</th>
              <th>lang</th>
              <th className="num">first audio</th>
              <th className="num">total</th>
              <th>ok</th>
              <th>when</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => (
              <tr key={t.trace_id} className={t.ok ? "" : "row-fail"}>
                <td>
                  <Link href={`/traces/${t.trace_id}`}>
                    <code>{shortId(t.trace_id)}</code>
                  </Link>
                </td>
                <td className="muted">
                  <code>{shortId(t.session_id)}</code>
                </td>
                <td className="num muted">{t.turn_index}</td>
                <td>{t.lang}</td>
                <td
                  className={`num ${
                    t.first_audio_ms !== null &&
                    t.first_audio_ms > LATENCY_BUDGET_MS.endToEndFirstAudio
                      ? "over-budget"
                      : "good"
                  }`}
                >
                  {ms(t.first_audio_ms)}
                </td>
                <td className="num muted">{ms(t.total_latency_ms)}</td>
                <td>{t.ok ? "✓" : <span className="tag bad">failed</span>}</td>
                <td className="muted">{new Date(t.ts).toLocaleString()}</td>
              </tr>
            ))}
            {turns.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No turns recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}
