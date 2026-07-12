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
  specific configuration, and it must **differ** the moment anything that can change an output
  differs. It is `configHashOf(flow)` — a function of the turn's resolved `FlowConfig`, not a
  constant. See "Flow config" below; this is the rule the `/flow` builder lives or dies by.
- Never put raw audio in the event — store the blob, reference it.

## Flow config (`FlowConfig`)

`packages/shared/src/flow.ts`. The per-hop knobs that can change what a hop produces — what
the `/flow` canvas edits, what the gateway resolves, and what each activity takes as input.

```jsonc
{
  "stt": { "mode": "codemix", "lang": "unknown" },
  "llm": { "model": "sarvam-30b", "temperature": 0.2, "maxTokens": 512, "thinking": false },
  "tts": { "speaker": "shubh", "pace": 1 }
}
```

One node = one config object = one activity input = one trace row. A knob that the runtime
doesn't read has nowhere to hide, and neither does a parameter the canvas doesn't show.

Rules:
- **The client is never the authority.** A flow arriving on the wire is a *request*. The
  gateway runs `sanitizeFlow(patch, serverDefaultFlow())` — total, never throws — and echoes
  the resolved flow back (`ready` / `flow_ack`). A bulbul:v2 speaker becomes `shubh` rather
  than a 400 mid-call; `pace: 99` clamps to 2; `temperature: "hot"` falls back rather than
  reaching the model as `NaN`. The UI renders what came back, never what it sent.
- **Every field is hashed into `config_hash`** (`flowFingerprint`, versioned `v: 2`).
  `flow.test.ts` fails if you add a field and forget — a knob that moves an output without
  moving the hash files one configuration's results under another's name, undetectably.
- **`stt.lang` is the one deliberate exclusion.** It changes STT's output, but `config_hash`
  answers "are these two numbers comparable?", and language is a property of the call, not the
  configuration — the trace carries `lang` as its own column, and every eval score slices by
  it. Hashing it puts hi-IN and ta-IN calls in different config buckets and stops live traffic
  from ever matching an eval run's hash.
- The topology is **fixed**. The three hops run concurrently and hand off through the in-worker
  bus; an arbitrary user-drawn edge is not a pipeline the runtime can honour.

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
transcribe({ ctx, stt })             -> { text, lang }
respond({ ctx, history, llm })       -> { text, lang, ragContextIds }
synthesize({ ctx, tts })             -> { chunks, bytes, ttfb_ms }
endTurn({ ctx })                     -> void      // non-cancellable teardown
```

`stt` / `llm` / `tts` are the corresponding node of `FlowConfig` (above), handed straight
through by the workflow. The workflow resolves **no defaults of its own**: a default applied
there would be a difference in output that `ctx.config_hash` never attested to.

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

Know what this looks like when it breaks, because it does not look like a bus problem: a
**second worker** on the task queue makes Temporal spread a turn's activities across two
processes, the bus in each only ever sees half the turn, and the call simply hangs until the
smoke test times out — no error, no trace, nothing to grep. It is easy to do by accident: the
worker dials *out* to the gateway and binds no port, so killing `:8787` does not kill it, and a
stale one from a previous `pnpm dev` survives and re-attaches to the new gateway. If the loop
hangs, count the `[gateway] worker attached` lines before you debug anything else.

## Client channel (caller ↔ gateway)

`/voice`. Audio is raw binary PCM16 up, base64 in an `audio` message down; control is JSON both
ways (`packages/shared/src/wire.ts`).

| Direction | Message | Meaning |
|-----------|---------|---------|
| client → gateway | `start` | Opens the call. Optional `flow` (a `FlowPatch`) and `lang` (sugar for `flow.stt.lang`; the explicit flow wins). |
| client → gateway | `configure` | Retune the hops from the `/flow` canvas. Applies from the **next** turn — never to a turn already in flight, whose traces have already claimed a `config_hash`. |
| client → gateway | `stop` | Hang up. |
| gateway → client | `ready` | The call is up, carrying the **resolved** `flow` and its `config_hash`. |
| gateway → client | `flow_ack` | The resolved flow after a `configure`. The client renders this, never its own optimistic copy. |
| gateway → client | `partial` / `final` / `reply` / `audio` / `stop_audio` / `turn_end` | The turn, as the caller experiences it. |

`GET /flow` on the gateway's HTTP port returns the same `{ flow, config_hash }` for the server
default. The canvas seeds from it rather than from its own copy of the defaults, because only
that process knows its own `LLM_MODEL` and `TTS_SPEAKER` — a canvas seeded from the client's
constants would show the wrong speaker on any deployment that overrode one, and would show it
right up until the call was made.

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
