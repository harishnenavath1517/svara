# svara

A real-time Indic voice agent with a first-class evaluation harness.

Speak to it in Hindi, Tamil, Telugu, or code-mixed Hinglish — it transcribes, understands
intent, grounds the answer in a knowledge base, and replies with streamed speech in the
same language. Every hop (speech-to-text, LLM, text-to-speech) is traced and scored, so
quality regressions across 22 languages are caught before they ship.

Built on Sarvam's Indic model stack: Saaras v3 (STT), Sarvam-30B (LLM), Bulbul v3 (TTS).

## Why this exists

Most voice demos prove a happy path once and stop. This one proves it *stays* good:
word-error-rate per language, translation quality, end-to-end latency percentiles, and a
regression dashboard that diffs runs. The runtime loop is the demo; the eval harness is
the engineering.

## Architecture at a glance

```
        ┌── Client (web / phone) ──┐        audio streams both ways
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

Temporal owns the turn's *lifecycle*; the gateway owns its *bytes*. An activity can't be
handed a live microphone, so audio never crosses that boundary — which is also why the hops
can overlap (TTS speaks sentence 1 while the model writes sentence 2).

Full write-up in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart

```bash
git clone <this-repo> && cd svara
pnpm install
cp .env.example .env        # then paste your SARVAM_API_KEY
pnpm infra:up               # redpanda + temporal + qdrant, and create the topics
pnpm typecheck && pnpm test
```

`pnpm infra:up` waits on real healthchecks, so it returns only once the cluster is actually
serving. Local ports: Redpanda **19092** (9092 is in-network only), Redpanda Console 8080,
Temporal 7233, Temporal UI 8233, Qdrant 6333, Postgres 5432.

Then `pnpm dev` starts web + gateway + Temporal worker — open http://localhost:3000, allow
the mic, and speak. Talk over the agent to interrupt it. Once the harness lands (Phase 2),
`pnpm eval` scores the pipeline against the golden set and `pnpm eval:report` refreshes the
dashboard.

## Docs

| Doc | What's in it |
|-----|--------------|
| [`CLAUDE.md`](CLAUDE.md) | Steering context + guardrails (read first if using Claude Code) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, both planes, latency budget |
| [`docs/EVAL_STRATEGY.md`](docs/EVAL_STRATEGY.md) | Metrics, golden set, regression flow |
| [`docs/SARVAM_API.md`](docs/SARVAM_API.md) | Endpoints, models, language codes, deprecations |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased build plan with checklists |
| [`docs/DATA_CONTRACTS.md`](docs/DATA_CONTRACTS.md) | Trace schema, topics, tables, golden-set format |

## Status

**Phase 1 complete — the voice loop runs.** Speak Hindi into the browser and the agent
answers in Hindi, in speech, grounded in the scheme-helpline persona. Every hop emits a
trace to Redpanda, including when it fails.

Measured end to end, locally (Bulbul-synthesized caller audio driven through the real
gateway, so the numbers come from the actual loop):

| Turn | Transcript (codemix mode) | First audio out |
|------|---------------------------|-----------------|
| Hindi | "नमस्ते मुझे PM किसान योजना के लिए पात्रता जाननी है" | **860 ms** |
| Tamil | "வணக்கம் எனக்கு PM Kisan திட்டத்திற்கான தகுதி தெரிய வேண்டும்" | **799 ms** |

against a 800ms budget, measured from mic close. Barge-in: playback stops ~300ms after the
caller starts talking, the hops abort mid-call, and zero stale audio arrives afterwards.

Note both transcripts: the caller spoke pure Hindi and pure Tamil, and Saaras returned the
scheme name romanized inline — that code-mixing is the axis the eval harness exists to
measure. The Hindi turn's 60ms overshoot is the Saaras finalize, not the pipeline; Phase 2
is what holds that honest across languages instead of trusting two lucky turns. Three Sarvam
gotchas that cost real time are written up in [`docs/SARVAM_API.md`](docs/SARVAM_API.md);
the one that silently returns an empty reply is worth reading before you touch the LLM hop.

Use case: **government-scheme helpline** — eligibility, application status, how to apply,
required documents, grievances. Rationale in [`docs/ROADMAP.md`](docs/ROADMAP.md).

`pnpm eval` still exits non-zero until Phase 2 implements it — a green eval run that scored
nothing is worse than no eval run.

Follow the roadmap, and do not leave `main` unable to complete a voice turn.
