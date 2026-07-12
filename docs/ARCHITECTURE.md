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

Deploy on a platform that supports persistent connections (Fly.io / Railway). Edge runtimes
will drop the socket.

### Turn workflow (Temporal)
Each turn is a durable workflow, not a bare async function. The three model calls are
**activities** with independent timeouts, retries, and cancellation:

1. `transcribe` → Saaras v3 STT, streaming, `codemix`/`translate` mode. Emits partial and
   final transcripts.
2. `respond` → Sarvam-30B via LiteLLM. Takes the (partial) transcript + retrieved context
   from Qdrant, produces the reply. Streams tokens.
3. `synthesize` → Bulbul v3 TTS, streaming. Consumes the reply sentence-by-sentence and
   streams audio chunks back through the gateway to the client.

Why Temporal: a hung LLM call times out and the gateway can play a filler; a transient
Sarvam 5xx retries without dropping the call; barge-in cancels the whole saga cleanly. When
someone asks "what happens if a hop stalls," the workflow *is* the answer.

### RAG grounding (Qdrant)
Domain knowledge (scheme rules, FAQ, policy docs) is embedded into Qdrant. The `respond`
activity retrieves top-k context before generating, so the model answers from source
instead of hallucinating specifics. Keep the retrieval call inside the activity so its
latency shows up in traces.

### Streaming is mandatory
The hops must pipeline, not run sequentially:

- Feed **partial** transcripts to the LLM as they arrive.
- Start TTS on the **first sentence** of the LLM output, not the full response.

This is the only way to hit the first-audio budget below.

### Latency budget (first audio out)

| Hop | Target | Notes |
|-----|--------|-------|
| Saaras v3 STT | ~150 ms to first token | fast mode, WebSocket |
| Sarvam-30B LLM | ~300–500 ms TTFT | start TTS on first sentence |
| Bulbul v3 TTS | ~200 ms to first chunk | streaming |
| **End-to-end first audio** | **< 800 ms** | only reachable when pipelined |

Measure p50 and p95 per hop and end-to-end, and keep the table in the dashboard honest
with real numbers. Measuring this is part of the eval story, not separate from it.

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
