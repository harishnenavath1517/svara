# svara

A real-time Indic voice agent with a first-class evaluation harness.

Speak to it in Hindi, Tamil, or code-mixed Hinglish — it transcribes, understands intent, and
replies with streamed speech in the same language, first audio in about a second. Every hop
(STT → LLM → TTS) emits a trace, and an offline harness replays a golden set and scores the
pipeline so quality regressions are caught before they ship.

Built on Sarvam's Indic model stack: **Saaras v3** (STT), **Sarvam-30B** (LLM), **Bulbul v3** (TTS).

## Why this exists

Most voice demos prove a happy path once and stop. This one is built to prove it *stays*
good: word-error-rate per language, translation quality against an LLM judge, latency
percentiles per hop, and a dashboard that diffs two runs and names what moved.

The runtime loop is the demo. **The eval harness is the engineering** — and the most useful
thing it produced was a number that says the opposite of what a naive harness would have
reported.

## The headline finding: naive WER inverts the code-mixed result

Scored across 40 golden utterances in hi-IN and ta-IN:

| hi-IN slice | WER (script-sensitive) | WER (script-invariant) |
|-------------|-----------------------:|-----------------------:|
| clean       | 0.093                  | 0.073                  |
| **code-mixed** | **0.234**           | **0.021**              |
| numbers     | 0.140                  | 0.053                  |
| noisy       | 0.119                  | 0.143                  |

Saaras hears "Aadhaar card" perfectly and writes it in Devanagari as "आधार कार्ड". Token WER
against a Latin-script reference scores all four loanwords as substitutions — **0.5 WER on a
transcription with zero recognition errors.** Aggregated, that makes the code-mixed slice look
like the *worst* one (0.234, 2.5× clean) when it is in fact the *best* (0.021).

A harness reporting only the first column would have concluded "Sarvam is bad at Hinglish" and
sent someone off to fix a model that works. This one reports both columns and the gap between
them, **because the gap is the finding.** The dashboard is built to refuse to show one without
the other.

Two more results the harness is honest about rather than quiet about:

- **The LLM judge is saturated on Hindi and cannot gate anything there.** 19 of 20 records
  scored a flat 5.0, so chrF↔judge agreement is 0.141 — there is nothing to correlate with. On
  Tamil the judge actually discriminates (2.5–5.0) and agreement rises to 0.473. Low agreement
  is reported as a *finding*, not buried: it says the judge's Hindi scores are noise.
- **Romanized Tamil carries a convention offset.** ta-IN clean scores 0.032 native but 0.226
  romanized — the recognition is near-perfect, the hand-authored spelling simply differs from
  Saaras's. For Tamil that column is a *relative* regression detector, not an accuracy figure,
  and it says so.

Full reasoning: [`docs/EVAL_STRATEGY.md`](docs/EVAL_STRATEGY.md).

## What the harness has actually caught

Not a hypothetical. Adding the `/flow` builder made `config_hash` — the trace's claim about
*which configuration produced this number* — a function of a user-editable config. My first
version folded the caller's **language** into that hash, which looks obviously right (language
does change what STT emits) and is wrong: the smoke test showed the gateway advertising one
hash while every real call traced a different one, because callers always set a language.
Worse, hi-IN and ta-IN calls would have landed in *different config buckets*, and neither could
ever match an eval run's hash — live traffic would have read NOT COMPARABLE against the
baseline forever. Language is a property of the call, not the configuration; the trace already
carries it as a column. Caught before merge, and pinned in a test so it stays caught.

## Architecture

```
        ┌── Client (web) ──────────┐        audio streams both ways
        │   mic capture · playback │◄─────────────────────────────┐
        └────────────┬─────────────┘                              │
                     │ WebSocket                                  │
             ┌───────▼────────┐                                   │
             │  Voice gateway │  VAD · barge-in · session         │
             │  stream broker │◄──────────────┐                   │
             └───────┬────────┘   audio +     │ hop output        │
                     │ starts     transcripts │ (internal WS)     │
                     │ one workflow per turn  │                   │
   ┌─────────────────▼────────────────────────┴───────────────┐   │
   │  Temporal · durable turn workflow  (control plane)        │   │
   │                                                           │   │
   │   Saaras v3 STT ─┐                                        │   │
   │   Sarvam-30B LLM ┼─ three activities, running concurrently├───┘
   │   Bulbul v3 TTS ─┘  handing off through the turn bus      │
   │                     per-hop timeouts · retries · cancel   │
   └───────┬──────────────┬──────────────────┬────────────────┘
           │ trace        │ trace            │ trace   (on failure too)
        ┌──▼──────────────▼──────────────────▼──┐
        │  Redpanda · event bus (svara.traces)  │
        └────────────────────┬──────────────────┘
        ┌────────────────────▼──────────────────────────────┐
        │  Eval harness                                      │
        │   Trace sink ─► Eval runner ─► Regression dashboard│
        │   PG + audio    WER·chrF·judge   per-lang · latency│
        └────────────────────────────────────────────────────┘
```

Temporal owns the turn's *lifecycle*; the gateway owns its *bytes*. An activity can't be handed
a live microphone, so audio never crosses that boundary — which is also why the hops overlap
(TTS speaks sentence 1 while the model writes sentence 2). A sequential
`await transcribe(); await respond(); await synthesize()` cannot hit the latency budget.

Barge-in does **not** ride on Temporal cancellation: that reaches an activity only on a
heartbeat response, throttled to ~80% of the heartbeat timeout. Measured, it left a cancelled
turn's TTS streaming for five more seconds — silent to the caller, still billing. The gateway
aborts the hops in-band instead.

Full write-up: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The four surfaces

| Route | What it is |
|-------|------------|
| `/` | The call. Speak, get a spoken reply, talk over it to interrupt. |
| `/flow` | **Flow builder** — a React Flow canvas over the real turn: one node per Temporal activity, edges typed by the data contract, ▶ drives a live turn. Retune a hop and the next turn's traces carry a different `config_hash`. |
| `/evals` | Every eval run, and the run-over-run diff. Red/green deltas, regressions flagged past threshold. |
| `/traces` | Live turns, hop by hop — play the audio the hop actually stored, next to the transcript it actually produced. |

The flow builder's knobs are not a settings panel bolted to a picture: each node's config **is**
the object its activity takes as input, so one node = one config object = one activity input =
one trace row. Its edges deliberately **don't drag** — the three hops run concurrently over an
in-worker bus, so a user-drawn edge is not a pipeline the runtime could honour, and a canvas
that accepted one would be drawing a flow that does not exist.

## Quickstart

```bash
git clone https://github.com/harishnenavath1517/svara && cd svara
pnpm install
cp .env.example .env        # then paste your SARVAM_API_KEY
pnpm infra:up               # redpanda + temporal + qdrant + postgres schema
pnpm dev                    # web + gateway + temporal worker + trace sink
```

Open http://localhost:3000, allow the mic, and speak. Then:

```bash
pnpm --filter @svara/eval run smoke   # drive one real turn through the live loop
pnpm eval                             # score the golden set, persist a run
pnpm eval --against <run_id>          # diff two runs — this is the deliverable
pnpm typecheck && pnpm test && pnpm build
```

`pnpm infra:up` waits on real healthchecks, so it returns only once the cluster is serving.
Local ports: Redpanda **19092** (9092 is in-network only), Redpanda Console 8080, Temporal
7233, Temporal UI 8233, Qdrant 6333, Postgres 5432.

**If a turn hangs, count the workers before you debug the code.** The Temporal worker dials
*out* to the gateway and binds no port, so a stale one from a previous `pnpm dev` survives a
port kill and re-attaches. Two workers on the task queue means Temporal splits a turn's
activities across processes, the in-worker bus only ever sees half the turn, and the call hangs
with no error and no trace. Exactly one `[gateway] worker attached` line is correct.

## Deployment

The dashboard deploys; the voice loop does not, and that is architectural rather than lazy.
The gateway is a **long-lived WebSocket service** — an edge/serverless runtime drops the socket
and there is no voice loop without it. It needs an always-on host, alongside Temporal and
Redpanda.

So: the eval dashboard (`/evals`, `/traces`) runs on Vercel against a hosted Postgres, and the
live loop runs locally. Deploying the loop publicly would also mean an unauthenticated endpoint
billing calls to a real Sarvam key — a gate for that is a prerequisite, not a detail.

## Docs

| Doc | What's in it |
|-----|--------------|
| [`CLAUDE.md`](CLAUDE.md) | Steering context + the ten guardrails (read first if using Claude Code) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, both planes, latency budget |
| [`docs/EVAL_STRATEGY.md`](docs/EVAL_STRATEGY.md) | Metrics, golden set, why a model may never grade itself |
| [`docs/DATA_CONTRACTS.md`](docs/DATA_CONTRACTS.md) | Trace schema, flow config, topics, tables, wire protocol |
| [`docs/SARVAM_API.md`](docs/SARVAM_API.md) | Endpoints, models, language codes, deprecations |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased build plan, with what each phase actually found |

## Status

**Phases 0–4 complete.** The loop runs, every hop traces, the golden set scores, the dashboard
diffs, and `/flow` composes.

Latency, driven end to end through the real gateway with synthesized caller audio: first audio
lands in **~1.0–1.7 s** against an 800 ms budget. Per-hop, from the traces: LLM TTFB 312–390 ms
(inside its 500 ms budget), TTS TTFB 553–610 ms. The budget is currently missed, and the
Saaras finalize is where it goes — the model emits nothing until the VAD endpoint triggers a
flush, so there are no interim partials to feed the LLM early. Feeding partial transcripts
forward is the next real latency win.

Two numbers in here that look like bugs and are not, both because a wall clock is not a model
clock:

- **A live STT hop's `latency_ms` (~7.7 s) is the caller speaking**, not Saaras thinking. The
  offline eval times STT from audio-feed-start instead. The dashboard never puts the two on one
  axis.
- **`sarvam-30b` reasons by default**, and its thinking tokens are billed against `max_tokens`
  *before* any reply — at 512 tokens you get an empty reply, `finish_reason: "length"`, and no
  error anywhere. `thinking: false` is what turns it off. `/flow` exposes the toggle precisely
  so the cost is demonstrable.

Use case: **government-scheme helpline** — eligibility, application status, how to apply,
required documents, grievances. Chosen because the RAG corpus is real public documents, the
golden set is synthesizable with no PII, and code-mixing is native to the domain. Rationale in
[`docs/ROADMAP.md`](docs/ROADMAP.md).
