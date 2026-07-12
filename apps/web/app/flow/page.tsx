"use client";

import { DEFAULT_FLOW, LATENCY_BUDGET_MS, sanitizeFlow } from "@svara/shared/browser";
import type { FlowConfig, FlowNodeId, FlowPatch, TurnEndMessage } from "@svara/shared/browser";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlowCanvas, type HopState, type HopTrace } from "../../components/flow-canvas";
import { VoiceCall, type CallStatus } from "../../lib/call";
import { shortHash, shortId } from "../../lib/format";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787/voice";
const GATEWAY_HTTP = GATEWAY_URL.replace(/^ws/u, "http").replace(/\/[^/]*$/u, "");

const IDLE_STATES: Record<FlowNodeId, HopState> = {
  caller: "idle",
  stt: "idle",
  llm: "idle",
  tts: "idle",
  speaker: "idle",
};

/** The trace goes hop → Redpanda → sink → Postgres. It lands a beat after turn_end. */
const TRACE_POLL_MS = 500;
const TRACE_POLL_TRIES = 8;

interface TraceApiResponse {
  hops: Array<{
    hop: FlowNodeId;
    latency_ms: number;
    ttfb_ms: number | null;
    model: string;
    error_code: string | null;
  }>;
}

/**
 * The flow builder: compose the turn on a canvas, then run it live.
 *
 * The thing that makes this more than a diagram is that the knobs are the same
 * object the activities take as input (`FlowConfig`), resolved by the gateway and
 * hashed into every trace the turn emits. Retune the LLM and the next turn's rows
 * carry a different `config_hash` — so the eval plane files them separately from
 * the baseline instead of averaging a retuned run into it. A node editor that
 * *didn't* do that would be a machine for quietly corrupting the harness this
 * whole project is built around.
 */
export default function FlowPage() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [flow, setFlow] = useState<FlowConfig>(DEFAULT_FLOW);
  const [configHash, setConfigHash] = useState<string | null>(null);
  const [states, setStates] = useState<Record<FlowNodeId, HopState>>(IDLE_STATES);
  const [traces, setTraces] = useState<Partial<Record<FlowNodeId, HopTrace>>>({});
  const [traceStatus, setTraceStatus] = useState<"idle" | "waiting" | "landed" | "missing">("idle");
  const [turn, setTurn] = useState<TurnEndMessage | null>(null);
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);

  const call = useRef<VoiceCall | null>(null);
  const live = status === "live";

  /**
   * Seed from the gateway, not from our own copy of the defaults. Only that process
   * knows its own LLM_MODEL and TTS_SPEAKER, and a canvas showing a speaker the
   * server won't use is a canvas describing a call that won't happen.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${GATEWAY_HTTP}/flow`);
        if (!response.ok) throw new Error(`gateway returned ${response.status}`);
        const body = (await response.json()) as { flow: FlowConfig; config_hash: string };
        if (cancelled) return;
        setFlow(body.flow);
        setConfigHash(body.config_hash);
      } catch {
        if (!cancelled) setError("gateway unreachable — is `pnpm dev` running?");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A knob moved.
   *
   * Live, the gateway is the authority: send the patch and let the `flow_ack`
   * drive the UI, so what you see is what it resolved (a clamped pace, a rejected
   * speaker) rather than what you asked for. Idle, there is no socket to ask — so
   * resolve locally with `sanitizeFlow`, which is the *same pure function the
   * gateway runs*. The preview cannot drift from the decision.
   */
  const onChange = useCallback(
    (patch: FlowPatch) => {
      if (live) {
        call.current?.configure(patch);
        return;
      }
      setFlow((current) => sanitizeFlow(patch, current));
      setConfigHash(null); // unresolved until a gateway confirms it
    },
    [live],
  );

  /** Poll until the hop's own trace rows land, and say so plainly if they never do. */
  const loadTraces = useCallback(async (traceId: string) => {
    setTraceStatus("waiting");
    for (let attempt = 0; attempt < TRACE_POLL_TRIES; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, TRACE_POLL_MS));
      try {
        const response = await fetch(`/api/turn?trace=${traceId}`);
        if (!response.ok) continue;
        const { hops } = (await response.json()) as TraceApiResponse;
        if (hops.length === 0) continue;

        setTraces(
          Object.fromEntries(
            hops.map((hop) => [
              hop.hop,
              {
                latency_ms: hop.latency_ms,
                ttfb_ms: hop.ttfb_ms,
                model: hop.model,
                error_code: hop.error_code,
              },
            ]),
          ),
        );
        // A hop that failed is only visible here: the inferred live states never
        // saw it, because it produced nothing for them to see.
        setStates((current) => ({
          ...current,
          ...Object.fromEntries(
            hops.map((hop) => [hop.hop, hop.error_code === null ? "done" : "failed"]),
          ),
        }));
        setTraceStatus("landed");
        return;
      } catch {
        // Keep polling: the sink may simply not have caught up yet.
      }
    }
    // Never draw zeros. A zero is a claim; a blank is the truth.
    setTraceStatus("missing");
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setHeard("");
    setReply("");
    setTurn(null);
    setTraces({});
    setTraceStatus("idle");
    setStates({ ...IDLE_STATES, caller: "active" });

    const active = new VoiceCall({
      onStatus: setStatus,
      onFlow: (resolved, hash) => {
        setFlow(resolved);
        setConfigHash(hash);
      },
      onTranscript: (text, isFinal) => {
        setHeard(text);
        // Saaras emits nothing until the VAD endpoint flushes it (Phase 1 notes),
        // so in practice STT goes straight to `done` — no partials ever arrive.
        // That's an observation about the model, not a gap in the wiring.
        setStates((s) => ({
          ...s,
          stt: isFinal ? "done" : "active",
          llm: isFinal ? "active" : s.llm,
        }));
        if (!isFinal) setReply("");
      },
      onReply: (text) => {
        setReply(text);
        setStates((s) => ({ ...s, llm: "active" }));
      },
      onAudio: () => setStates((s) => ({ ...s, llm: "done", tts: "active", speaker: "active" })),
      onTurnEnd: (ended) => {
        setTurn(ended);
        setStates((s) => ({
          ...s,
          stt: settle(s.stt, ended.ok),
          llm: settle(s.llm, ended.ok),
          tts: settle(s.tts, ended.ok),
          speaker: "idle",
        }));
        void loadTraces(ended.trace_id);
      },
      onError: setError,
    });
    call.current = active;

    try {
      // Empty patch: take the gateway's default and let it tell us what that is.
      // Any knob already moved on the canvas rides along in `flow`.
      await active.start(GATEWAY_URL, flow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
      setStates(IDLE_STATES);
    }
  }, [flow, loadTraces]);

  const hangUp = useCallback(async () => {
    await call.current?.stop();
    call.current = null;
    setStatus("idle");
    setStates((s) => ({ ...IDLE_STATES, stt: s.stt, llm: s.llm, tts: s.tts }));
  }, []);

  const firstAudio = turn?.first_audio_ms ?? null;
  const overBudget =
    firstAudio !== null && firstAudio > LATENCY_BUDGET_MS.endToEndFirstAudio;

  return (
    <main className="wide">
      <h1>Flow builder</h1>
      <p className="sub">
        The turn, as a canvas — one node per Temporal activity, edges typed by the data contract.
        Retune a hop and run it live; the numbers that land on the nodes are the hops&apos; own
        trace rows.
      </p>

      <div className="controls">
        {live ? (
          <button className="danger" onClick={() => void hangUp()}>
            Hang up
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => void connect()}
            disabled={status === "connecting"}
          >
            {status === "connecting" ? "Connecting…" : "▶ Run flow"}
          </button>
        )}
        <span className="label" style={{ margin: 0 }}>
          {live ? "live — speak, then stop" : status}
        </span>
        <span className="flow-hash">
          config{" "}
          {configHash === null ? (
            <span className="muted">unresolved</span>
          ) : (
            <code>{shortHash(configHash)}</code>
          )}
        </span>
      </div>

      {error !== null && <div className="panel error">{error}</div>}

      <FlowCanvas flow={flow} states={states} traces={traces} onChange={onChange} />

      <p className="finding">
        <strong>The config hash follows the config.</strong> Every knob above is a field of{" "}
        <code>FlowConfig</code>, the object the activities take as input — and every field of it is
        hashed into the <code>config_hash</code> on each trace this turn emits. Move one and the
        next turn&apos;s rows land in a different bucket, so a retuned run can never be averaged
        into the baseline. Before this page existed the hash was a module constant, which was safe
        only for exactly as long as the configuration was one too.
      </p>

      <p className="note">
        The edges don&apos;t drag, on purpose. The three hops start <em>concurrently</em> and hand
        off through an in-worker bus (the teal edges) — TTS is already subscribed before the LLM
        has written a word. An edge you drew from TTS back to STT is not a pipeline the runtime can
        honour, and a canvas that accepted it would be drawing a flow that does not exist. Node
        states while the turn runs are <em>inferred</em> from the caller&apos;s socket; the
        millisecond figures are not — those are fetched back from Postgres.
      </p>

      {(heard.length > 0 || reply.length > 0) && (
        <div className="panel">
          <div className="label">Caller</div>
          <div className="line">{heard || "…"}</div>
          <div className="label" style={{ marginTop: 12 }}>
            Agent
          </div>
          <div className="line">{reply || "…"}</div>
        </div>
      )}

      {turn !== null && (
        <div className="panel metrics">
          <div>
            <div className="label">First audio</div>
            <div className={`metric-value ${overBudget ? "over-budget" : "good"}`}>
              {firstAudio === null ? "—" : `${firstAudio} ms`}
            </div>
            <div className="stat-n">budget {LATENCY_BUDGET_MS.endToEndFirstAudio} ms</div>
          </div>
          <div>
            <div className="label">Turn</div>
            <div className="metric-value">{turn.total_latency_ms} ms</div>
            <div className="stat-n">{turn.ok ? "ok" : (turn.error ?? "failed")}</div>
          </div>
          <div>
            <div className="label">Traces</div>
            <div className="metric-value">
              {traceStatus === "landed" ? (
                <Link href={`/traces/${turn.trace_id}`}>{shortId(turn.trace_id)}</Link>
              ) : (
                <span className="muted">
                  {traceStatus === "waiting" ? "landing…" : traceStatus}
                </span>
              )}
            </div>
            <div className="stat-n">
              {traceStatus === "missing"
                ? "no rows — is the sink running? (pnpm dev)"
                : "hop rows from Postgres"}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * A hop that was mid-flight when the turn ended didn't necessarily fail — it may
 * simply never have been reached. Only the trace row knows, and it overwrites this
 * a moment later; until then, don't assert more than we saw.
 */
function settle(state: HopState, ok: boolean): HopState {
  if (state === "idle") return "idle";
  if (state === "done") return "done";
  return ok ? "done" : "failed";
}
