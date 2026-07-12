"use client";

import { LANGUAGE_NAMES, LATENCY_BUDGET_MS, SPEECH_LANGUAGES } from "@svara/shared/browser";
import type { TraceLanguage, TurnEndMessage } from "@svara/shared/browser";
import { useCallback, useRef, useState } from "react";
import { VoiceCall, type CallStatus } from "../lib/call";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787/voice";

/**
 * The call UI. Deliberately thin: it opens the socket, shows what the agent
 * heard and said, and puts the first-audio latency on screen against its budget.
 * The dashboard that diffs eval runs is Phase 3 and lives beside this page.
 */
export default function CallPage() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [lang, setLang] = useState<TraceLanguage>("unknown");
  const [heard, setHeard] = useState("");
  const [isFinal, setIsFinal] = useState(false);
  const [reply, setReply] = useState("");
  const [turn, setTurn] = useState<TurnEndMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useRef<VoiceCall | null>(null);

  const connect = useCallback(async () => {
    setError(null);
    setHeard("");
    setReply("");
    setTurn(null);

    const active = new VoiceCall({
      onStatus: setStatus,
      onTranscript: (text, final) => {
        // A new utterance overwrites the last one: this is a live caption, not a log.
        setHeard(text);
        setIsFinal(final);
        if (!final) setReply("");
      },
      onReply: setReply,
      onTurnEnd: setTurn,
      onError: setError,
    });
    call.current = active;

    try {
      // Everything else — STT mode, model, speaker, pace — stays at the gateway's
      // resolved default. Retuning the hops is what /flow is for.
      await active.start(GATEWAY_URL, { stt: { lang } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }, [lang]);

  const hangUp = useCallback(async () => {
    await call.current?.stop();
    call.current = null;
    setStatus("idle");
  }, []);

  const live = status === "live";
  const firstAudio = turn?.first_audio_ms ?? null;

  return (
    <main>
      <h1>svara — government scheme helpline</h1>
      <p className="sub">
        Speak in Hindi, Tamil, Telugu, or Hinglish. Talk over the agent to interrupt it.
      </p>

      <div className="controls">
        <select
          value={lang}
          onChange={(event) => setLang(event.target.value as TraceLanguage)}
          disabled={live || status === "connecting"}
        >
          <option value="unknown">Auto-detect language</option>
          {SPEECH_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {LANGUAGE_NAMES[code]}
            </option>
          ))}
        </select>

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
            {status === "connecting" ? "Connecting…" : "Call"}
          </button>
        )}
        <span className="label" style={{ margin: 0 }}>
          {status}
        </span>
      </div>

      {error !== null && (
        <div className="panel error">
          {error}
          {status === "idle" && " — is the gateway running? (pnpm dev)"}
        </div>
      )}

      <div className="panel">
        <div className="label">Caller</div>
        <div className={`line ${isFinal ? "" : "pending"}`}>{heard || "…"}</div>
      </div>

      <div className="panel">
        <div className="label">Agent</div>
        <div className="line">{reply || "…"}</div>
      </div>

      {turn !== null && (
        <div className="panel metrics">
          <div>
            <div className="label">First audio</div>
            <div
              className={`metric-value ${
                firstAudio !== null && firstAudio > LATENCY_BUDGET_MS.endToEndFirstAudio
                  ? "over-budget"
                  : ""
              }`}
            >
              {firstAudio === null ? "—" : `${firstAudio} ms`}
            </div>
          </div>
          <div>
            <div className="label">Budget</div>
            <div className="metric-value">{LATENCY_BUDGET_MS.endToEndFirstAudio} ms</div>
          </div>
          <div>
            <div className="label">Turn</div>
            <div className="metric-value">{turn.total_latency_ms} ms</div>
          </div>
          <div>
            <div className="label">Language</div>
            <div className="metric-value">{turn.lang}</div>
          </div>
        </div>
      )}
    </main>
  );
}
