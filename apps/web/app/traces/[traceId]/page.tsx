import { traceDetail } from "@svara/db";
import { LATENCY_BUDGET_MS } from "@svara/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { shortHash, shortId } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * One turn, hop by hop, with the audio.
 *
 * The player streams the blob the hop actually stored — caller audio at 16kHz,
 * the agent's voice at 24kHz — through /api/audio, which resolves the ref from
 * the trace row rather than taking a path from the URL. Nothing here is
 * re-synthesized. Hearing the actual audio next to the actual transcript is the
 * whole reason the trace carries a ref at all: it is how you find out that the WER
 * you are staring at is a caller who mumbled, not a model that failed.
 *
 * Failed hops render *with* their latency, because `latency_ms` on a failed hop is
 * how long it took to fail, and a hop that failed slowly is a different bug from
 * one that failed instantly.
 */
export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const { turn, hops } = await traceDetail(traceId);

  if (turn === null && hops.length === 0) notFound();

  return (
    <main className="wide">
      <p className="crumb">
        <Link href="/traces">← live traces</Link>
      </p>

      <h1>
        Turn <code>{shortId(traceId)}</code>
      </h1>
      {turn !== null && (
        <p className="sub">
          session <code>{shortId(turn.session_id)}</code> · turn {turn.turn_index} · {turn.lang} ·
          first audio{" "}
          <strong
            className={
              turn.first_audio_ms !== null &&
              turn.first_audio_ms > LATENCY_BUDGET_MS.endToEndFirstAudio
                ? "over-budget"
                : "good"
            }
          >
            {turn.first_audio_ms === null ? "—" : `${turn.first_audio_ms} ms`}
          </strong>{" "}
          (budget {LATENCY_BUDGET_MS.endToEndFirstAudio} ms) · {turn.ok ? "ok" : "FAILED"}
        </p>
      )}

      {turn === null && (
        <div className="panel verdict-banner warn">
          No <code>turn</code> row for this trace — the hops emitted but the turn never closed.
          That is what a crashed or cancelled turn looks like, and the hops below are the
          explanation.
        </div>
      )}

      {hops.map((hop) => {
        const inRef = hop.input_ref;
        const outRef = hop.output_ref;
        return (
          <div key={hop.hop} className={`panel ${hop.error_code !== null ? "row-fail" : ""}`}>
            <div className="panel-head">
              <h3>
                {hop.hop.toUpperCase()} · <code>{hop.model}</code>
                {hop.mode !== null && (
                  <>
                    {" "}
                    · mode <code>{hop.mode}</code>
                  </>
                )}
              </h3>
              <p className="note">
                ttfb{" "}
                <strong className={overBudget(hop.ttfb_ms, hop.hop) ? "over-budget" : "good"}>
                  {hop.ttfb_ms === null ? "—" : `${hop.ttfb_ms} ms`}
                </strong>{" "}
                (budget {LATENCY_BUDGET_MS[hop.hop]} ms) · wall{" "}
                <span className="muted">{hop.latency_ms} ms</span>
                {hop.hop === "stt" && (
                  <span className="tag">wall spans the caller speaking — not model latency</span>
                )}{" "}
                · config <code>{shortHash(hop.config_hash)}</code>
              </p>
            </div>

            {hop.error_code !== null && (
              <p className="finding">
                <span className="tag bad">{hop.error_code}</span> {hop.error_message ?? ""} — the
                hop still emitted its trace, with its latency. A failed turn that vanishes from the
                eval plane is the one you can never explain.
              </p>
            )}

            {hop.text_in !== null && (
              <>
                <div className="label">in</div>
                <div className="line">{hop.text_in}</div>
              </>
            )}
            {hop.text_out !== null && (
              <>
                <div className="label">out</div>
                <div className="line">{hop.text_out}</div>
              </>
            )}

            {inRef !== null && (
              <div className="audio-row">
                <div className="label">
                  caller audio {hop.hop === "stt" && <span className="muted">16 kHz</span>}
                </div>
                <audio
                  controls
                  preload="none"
                  src={`/api/audio?trace=${hop.trace_id}&hop=${hop.hop}&dir=in`}
                />
              </div>
            )}
            {outRef !== null && (
              <div className="audio-row">
                <div className="label">
                  agent audio {hop.hop === "tts" && <span className="muted">24 kHz</span>}
                </div>
                <audio
                  controls
                  preload="none"
                  src={`/api/audio?trace=${hop.trace_id}&hop=${hop.hop}&dir=out`}
                />
              </div>
            )}
          </div>
        );
      })}
    </main>
  );
}

function overBudget(ttfb: number | null, hop: "stt" | "llm" | "tts"): boolean {
  return ttfb !== null && ttfb > LATENCY_BUDGET_MS[hop];
}
