# Architecture

Two planes joined by an event bus: a **runtime plane** that carries the live voice loop,
and an **eval plane** that consumes traces of that loop and scores quality offline.

## Runtime plane

### Client
Web (and later telephony) client. Captures microphone audio, streams it over a WebSocket,
plays synthesized audio back, and stops playback immediately on barge-in.

### Voice gateway
A standalone, stateful Node service — **not** a serverless/edge function, because it holds
a long-lived WebSocket per session. Responsibilities:

- Terminate the client WebSocket; frame and forward audio.
- Voice-activity detection (VAD) and **barge-in**: the instant the user starts speaking,
  cancel any in-flight TTS and the current turn.
- Session state: conversation history, language, caller context (kept in Supabase/Redis,
  keyed by session id).
- Start one Temporal turn workflow per user utterance.
- **Broker the streams** (below).

Deploy on a platform that supports persistent connections (Fly.io / Railway). Edge runtimes
will drop the socket.

### The gateway brokers the streams; Temporal controls the turn

A Temporal activity takes serializable arguments and returns a serializable result. It
cannot be handed a live microphone, and it cannot yield audio back as it produces it. So
the bytes do not go through Temporal at all:

```
caller ──audio──► gateway ──audio (internal WS)──► worker ──► Saaras
caller ◄──audio── gateway ◄──transcripts, tokens, TTS audio── worker ◄── Bulbul
```

Temporal owns the turn's *lifecycle* — per-hop timeouts, retries, cancellation — while the
gateway owns its *bytes*. The internal channel is a second WebSocket (`/internal`) that the
worker dials on boot, multiplexed by `trace_id`. Contract:
`packages/orchestrator/src/protocol.ts`.

### Turn workflow (Temporal)
Each turn is a durable workflow, not a bare async function. The three model calls are
**activities** with independent timeouts, retries, and cancellation:

1. `transcribe` → Saaras v3 STT, streaming, `codemix` mode. Emits partial and final
   transcripts.
2. `respond` → Sarvam-30B via LiteLLM. Takes the transcript + (Phase 2) retrieved context
   from Qdrant, produces the reply. Streams tokens, cut into sentences as they close.
3. `synthesize` → Bulbul v3 TTS, streaming. Consumes the reply sentence-by-sentence and
   streams audio chunks back through the gateway to the client.

They run **concurrently, not in sequence**. All three activities start at once and hand off
through an in-worker *turn bus* (`bus.ts`): `respond` is already subscribed when the first
final transcript lands, and `synthesize` is already subscribed when sentence 1 closes. That
overlap is the latency budget — a sequential `await transcribe(); await respond(); await
synthesize()` cannot hit it.

The bus lives inside one worker process, so a turn's three activities must land on the same
worker. True today (one worker, and `pnpm dev` starts one). Before scaling the worker out,
move the bus onto Redis/NATS or pin a turn with a Temporal worker session.

Why Temporal: a hung LLM call times out and the gateway can play a filler; a transient
Sarvam 5xx retries without dropping the call; the turn's history is inspectable in the
Temporal UI when someone asks what happened. When someone asks "what happens if a hop
stalls," the workflow *is* the answer.

### Barge-in does not ride on Temporal cancellation

Temporal delivers cancellation to an activity only in the *response to a heartbeat*, and
heartbeats are throttled to ~80% of `heartbeatTimeout`. Measured here: after a barge-in, a
cancelled turn's TTS activity kept streaming for five more seconds — inaudible to the caller
(the gateway had already stopped forwarding) but still paying Sarvam, and still writing a
trace that claimed the turn succeeded.

So barge-in is three things, fastest first:

1. `stop_audio` to the client — kills every scheduled audio buffer. This is what the caller
   hears, and it is immediate.
2. A `cancel` frame down the internal channel — the worker aborts the hops' Sarvam sockets
   in-process, in milliseconds. Each hop then traces `error: {code: "cancelled"}`.
3. `handle.cancel()` on the workflow — correct, durable, and far too slow to be the thing
   the feature depends on.

### RAG grounding (Qdrant)
Domain knowledge (scheme rules, FAQ, policy docs) is embedded into Qdrant. The `respond`
activity retrieves top-k context before generating, so the model answers from source
instead of hallucinating specifics. Keep the retrieval call inside the activity so its
latency shows up in traces.

### Streaming is mandatory
The hops must pipeline, not run sequentially:

- Feed transcripts to the LLM the moment STT endpoints — not when the STT activity finishes
  tearing its socket down.
- Start TTS on the **first sentence** of the LLM output, not the full response.

This is the only way to hit the first-audio budget below.

### Latency budget (first audio out)

| Hop | Target | Measured (Phase 1, local, Hindi) | Notes |
|-----|--------|----------------------------------|-------|
| Saaras v3 STT | ~150 ms to first token | **~500 ms** endpoint → transcript | no interim partials arrive; the transcript comes after our `flush` |
| Sarvam-30B LLM | ~300–500 ms TTFT | ~450 ms | only with thinking disabled — see `docs/SARVAM_API.md` |
| Bulbul v3 TTS | ~200 ms to first chunk | ~500 ms | streaming, `linear16` |
| **End-to-end first audio** | **< 800 ms** | **860 ms** | mic close → first audio at the caller |

We are 60ms over, and the gap is the STT finalize, not the pipeline. Don't "fix" it by
loosening the budget — the eval harness exists to hold this number honest, and Phase 2
measures p50/p95/p99 per hop across languages rather than one lucky local turn.

## Eval plane

### Event bus (Redpanda)
Every hop publishes a trace event to the `svara.traces` topic (schema in
`DATA_CONTRACTS.md`). Redpanda gives us two things from one write: live observability and a
replayable log the eval harness consumes. Emit the trace in the same code path as the
Sarvam call — a missing trace is a bug.

### Trace sink
A consumer that lands structured trace rows in Postgres (Supabase) and raw audio in object
storage. This is the substrate both the dashboard and the offline runner read from.

### Eval runner
Replays a **golden set** — `(audio, expected_transcript, expected_intent,
reference_translation)` per language — through the pipeline (or through captured traces)
and scores each hop. See `EVAL_STRATEGY.md` for the metrics. Runs in CI and on demand.

### Regression dashboard
A Next.js view that diffs eval runs: per-language WER, translation scores, intent accuracy,
TTS intelligibility, and latency percentiles, with deltas highlighted. The goal is to be
able to say "Tamil WER regressed 12% on this change" *before* merging.

## Why the pipeline is composed as discrete stages

STT, LLM, and TTS are independent Temporal activities with a clean data contract between
them. That buys two things:

- **Swappability** — LiteLLM lets you change the LLM; the STT/TTS activities can point at a
  different provider without touching the workflow.
- **A visual builder for free** — the React Flow / node-canvas variation (for the Sim
  angle) is a UI layer over these same stages: one node per activity, edges are the
  contract. It is not a rewrite.

## Deployment

| Component | Where |
|-----------|-------|
| `apps/web` | Vercel or Cloudflare Pages |
| `apps/gateway` | Fly.io / Railway (persistent WS) |
| Temporal | Temporal Cloud or self-hosted worker |
| Redpanda | Redpanda Cloud or self-hosted |
| Qdrant | Qdrant Cloud |
| Postgres + storage | Supabase |

Local dev runs Redpanda, Temporal, and Qdrant from `infra/docker-compose.yml`; the web,
gateway, and Temporal worker run via `pnpm dev`.

### Local ports

`pnpm infra:up` runs compose with `--wait`, so it returns only once every healthcheck
passes, then creates the `svara.traces` and `svara.turns` topics (idempotently).

| Service | Host port | Notes |
|---------|-----------|-------|
| Redpanda (Kafka API) | **19092** | `9092` is the in-network listener and is **not** reachable from the host. `REDPANDA_BROKERS` must say `localhost:19092`. |
| Redpanda Console | 8080 | Browse topics and trace events. |
| Temporal | 7233 | gRPC; `TEMPORAL_ADDRESS`. |
| Temporal UI | 8233 | Inspect turn workflows and retries. |
| Qdrant | 6333 (HTTP), 6334 (gRPC) | |
| Postgres | 5432 | Backs Temporal *and* holds the svara schema locally. In production that role is Supabase. |
