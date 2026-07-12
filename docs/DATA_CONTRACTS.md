# Data contracts

The interfaces that hold the two planes together. Implement against these; change them
deliberately and update this file in the same commit.

## Trace event (`svara.traces`)

Emitted once per hop, per turn, to Redpanda. This is what the eval plane consumes — a
missing or malformed event is a bug, not a minor issue.

```jsonc
{
  "trace_id": "uuid",          // one per turn
  "session_id": "uuid",        // one per call/conversation
  "turn_index": 0,             // 0-based within the session
  "hop": "stt",                // "stt" | "llm" | "tts"
  "lang": "ta-IN",             // BCP-47; "unknown" if not yet detected
  "model": "saaras:v3",        // exact model + mode used
  "mode": "codemix",           // stt mode when applicable, else null
  "input_ref": "s3://.../in.wav",   // audio blob (stt/tts) or null
  "output_ref": "s3://.../out.wav", // audio blob (tts) or null
  "text_in": "…",              // transcript into llm, or text into tts
  "text_out": "…",             // transcript (stt), reply (llm), or null (tts)
  "rag_context_ids": ["…"],    // qdrant point ids used (llm hop), else []
  "latency_ms": 312,           // wall time for this hop
  "ttfb_ms": 148,              // time to first byte/token (streaming hops)
  "config_hash": "sha256:…",   // models + modes + prompt versions
  "git_sha": "…",
  "ts": "2026-07-12T09:30:00Z",
  "error": null                // { code, message } on failure
}
```

Rules:
- Emit even on failure (set `error`, still record `latency_ms`). Failed turns are the most
  valuable eval data.
- `config_hash` must be identical across all hops of a run so metrics attribute to a
  specific configuration.
- Never put raw audio in the event — store the blob, reference it.

## Redpanda topics

| Topic | Producer | Consumer |
|-------|----------|----------|
| `svara.traces` | each hop activity | trace sink, online eval sampler |
| `svara.turns` | turn workflow (turn start/end summary) | dashboard live view |

Single partition is fine for local dev; key by `session_id` when you scale so a session's
events stay ordered.

## Postgres tables (Supabase)

DDL: `packages/db/src/schema.sql`. Applied idempotently by `pnpm db:migrate` (which
`pnpm infra:up` runs for you).

```
traces        -- one row per hop event (flattened from svara.traces). PK (trace_id, hop)
turns         -- one row per turn: session_id, turn_index, lang, total_latency_ms, ok
eval_runs     -- run_id, git_sha, config_hash, started_at, golden_set_version,
                 records_scored, notes
eval_scores   -- run_id, lang, hop, metric, slice, value, n   (long/tidy — easy to pivot)
eval_samples  -- per-record detail behind the aggregates: expected, actual, and the
                 judge's rationale. A number without a rationale can't be argued with.
```

`eval_scores` is intentionally tall (one row per metric per language per hop per **slice** per
run) so the dashboard can pivot without schema changes when you add a metric. `slice` is the
tag bucket (`clean` / `code-mixed` / `numbers` / `noisy`, or `all`) — it keeps the code-mixed
cell reportable separately without inventing a column per tag.

`records_scored` exists so a run that scored **nothing** can never be mistaken for a run that
scored well. `pnpm eval` exits non-zero when it is zero.

Both trace writes upsert on the event's natural key, so the sink is **idempotent** and can be
replayed from offset 0 (`pnpm --filter @svara/sink run backfill`). Postgres holds nothing the
Redpanda log cannot rebuild — a schema change is not a data-loss event.

## Audio blobs

A trace never carries audio; it carries a **reference** to audio. `input_ref` (caller audio,
STT hop) and `output_ref` (the agent's voice, TTS hop) are storage keys, written by the hop and
resolved against `STORAGE_DIR` (default: `.svara-storage/` at the repo root — anchored there
and *not* at `process.cwd()`, because every package runs from its own directory and a
cwd-relative root means the worker writes a blob where the dashboard will never look).

Capture is passive and best-effort: chunks are forwarded to the caller first and the WAV is
assembled only after the hop has finished streaming, so it can never delay first audio. A
failed write logs and yields a null ref — losing a blob costs a drill-down; failing a live call
to store one is not a trade worth making. Set `TRACE_AUDIO=false` to disable.

## Golden-set record

Two files per language. `evals/golden/source/<lang>.jsonl` is **hand-authored** — it is the
answer key, and it is the answer key precisely because no model produced it:

```jsonc
{
  "id": "ta-IN-0007",
  "intent": "check_status",
  "tags": ["numbers"],              // clean | code-mixed | noisy | numbers
  "text": "மார்ச் பதினைந்தாம் தேதி விண்ணப்பித்தேன் …",   // as spoken, native script + code-mixing
  "romanized": "March pathinainthaam thethi vinnappithen …", // hand-romanized; see below
  "reference_translation": "I applied on the fifteenth of March …"
}
```

`evals/golden/<lang>.jsonl` is **generated** by `pnpm golden:build` — the source line plus the
synthesized audio and the QA verdict:

```jsonc
{
  "id": "ta-IN-0007",
  "lang": "ta-IN",
  "audio_ref": "evals/golden/audio/ta-IN-0007.wav",
  "expected_transcript": "…",       // the AUTHORED script — ground truth. Not a transcript.
  "expected_romanized": "…",        // the authored romanization (script-invariant reference)
  "expected_intent": "check_status",
  "reference_translation": "…",
  "tags": ["numbers"],
  "consent": "synthetic",           // "synthetic" | "consented" — provenance required
  "speaker": "aditya",              // bulbul:v3 speaker; rotated so the set isn't one voice
  "snr_db": null,                   // dB of added noise; null unless tagged `noisy`
  "qa_transcript": "…",             // what Saaras `translit` heard — the QA gate, NOT the key
  "qa_cer": 0.04,                   // CER vs `expected_romanized`
  "usable": true                    // false = quarantined; the eval skips it
}
```

**`expected_transcript` is the script we fed the synthesizer, not a transcription of the
audio.** Building it by running Saaras over Bulbul's output would be Saaras-vs-Saaras — a model
grading its own homework. Saaras runs only as a **QA gate** ("did Bulbul say what we asked?"),
in `translit` mode rather than the production `codemix` mode, and scored with CER. Full
reasoning in `EVAL_STRATEGY.md`.

**`expected_romanized` is hand-authored, not generated.** Sarvam's `/transliterate` endpoint is
not a pure function — on `ta-IN` it is non-deterministic and degenerates into a repetition loop
on identical input — and a metric that calls it would report API jitter as a regression.

Keep it small and high-signal (~20 per language). When a real failure appears, add it here as a
permanent regression case — that's how the set earns its keep.

## Hop activity contract (Temporal)

A Temporal activity takes **serializable arguments and returns a serializable result**. It
cannot be handed a live microphone, and it cannot yield audio back as it produces it. So the
streams do not cross the activity boundary — only correlation ids and summaries do:

```
transcribe({ ctx, lang, mode })      -> { text, lang }
respond({ ctx, history })            -> { text, lang, ragContextIds }
synthesize({ ctx, speaker, pace })   -> { chunks, bytes, ttfb_ms }
endTurn({ ctx })                     -> void      // non-cancellable teardown
```

The bytes flow around Temporal, through two channels keyed by `trace_id`:

- **Gateway ↔ worker** — caller audio down, transcripts/tokens/TTS audio up (see below).
- **The turn bus** (`packages/orchestrator/src/bus.ts`) — an in-worker channel that carries
  STT → LLM (transcripts) and LLM → TTS (sentences), plus the detected language.

All three activities start **concurrently** and block on the bus. That is what makes the
pipeline overlap: `synthesize` is already subscribed when sentence 1 closes. A sequential
`await transcribe(); await respond(); await synthesize()` cannot hit the latency budget.

Each activity emits exactly **one** trace event as a side effect — on success and on failure
alike, including cancellation (`error: {code: "cancelled", message: "barge-in"}`).

Per-hop timeouts and retry policy are set on the Temporal activity options, not inside the
activity body. Retryability is per hop, and not arbitrary:

| Hop | Attempts | Why |
|-----|----------|-----|
| `transcribe` | 1 | The audio was consumed as it streamed. A second attempt has nothing to hear. |
| `respond` | 3 | Re-reads the transcript off the bus; its only side effect (the live-transcript frame) is cumulative and overwrites. |
| `synthesize` | 2, conditionally | Refuses its own retry once the caller has heard audio — a retry would speak the reply twice. |

**Consequence to respect:** the bus lives in one worker process, so a turn's three activities
must land on the same worker. True today. Before running more than one worker, move the bus
onto Redis/NATS or pin the turn with a Temporal worker session.

## Internal channel (gateway ↔ worker)

A second WebSocket (`/internal`), dialed by the worker on boot, multiplexed by `trace_id`.
Localhost, no auth — never expose it. Types: `packages/orchestrator/src/protocol.ts`.

| Direction | Frame | Meaning |
|-----------|-------|---------|
| gateway → worker | `audio` | base64 PCM16 mono @16kHz, one VAD-passed mic frame |
| gateway → worker | `audio_end` | VAD endpointed the utterance. Ends the STT stream, which is what makes Saaras flush and finalize. |
| gateway → worker | `cancel` | **Barge-in.** Aborts every hop's Sarvam socket in-process, now. |
| worker → gateway | `partial` / `final` | transcript so far; `final` unblocks the LLM hop |
| worker → gateway | `token` | the reply *so far* (cumulative, not a delta — so a retried `respond` overwrites rather than doubles) |
| worker → gateway | `reply` | the complete reply, once the LLM hop is done |
| worker → gateway | `tts_audio` | base64 PCM16 @24kHz, forwarded straight to the caller |

`cancel` exists because **Temporal cancellation is too slow to carry barge-in**: it reaches
an activity only in the response to a heartbeat, and heartbeats are throttled to ~80% of
`heartbeatTimeout`. Measured, that left a cancelled turn's TTS streaming for five more
seconds — inaudible to the caller but still billing, and still tracing as a clean turn.
Temporal's own `handle.cancel()` still runs, behind the in-band abort, for the workflow's
bookkeeping.
