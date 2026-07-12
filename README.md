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
                     │ WebSocket                                   │
             ┌───────▼────────┐                                    │
             │  Voice gateway │  VAD · barge-in · session          │
             └───────┬────────┘                                    │
   ┌─────────────────▼────────────────────────────────────────┐   │
   │  Temporal · durable turn workflow                         │   │
   │   Saaras v3 STT ─► Sarvam-30B LLM ─► Bulbul v3 TTS ───────┼───┘
   │   stream·codemix   intent·+Qdrant     stream audio out    │
   └───────┬──────────────┬──────────────────┬────────────────┘
           │ trace        │ trace            │ trace
        ┌──▼──────────────▼──────────────────▼──┐
        │  Redpanda · event bus (svara.traces)  │
        └────────────────────┬──────────────────┘
        ┌────────────────────▼──────────────────────────────┐
        │  Eval harness                                      │
        │   Trace sink ─► Eval runner ─► Regression dashboard│
        │   PG + audio    WER·chrF·judge   per-lang · latency│
        └────────────────────────────────────────────────────┘
```

Full write-up in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart

```bash
git clone <this-repo> && cd svara
pnpm install
cp .env.example .env        # then paste your SARVAM_API_KEY
pnpm infra:up               # redpanda + temporal + qdrant via docker-compose
pnpm dev                    # web + gateway + temporal worker
```

Open http://localhost:3000, allow the mic, and speak. Then:

```bash
pnpm eval                   # score the pipeline against the golden set
pnpm eval:report            # refresh the dashboard
```

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

Pre-alpha. Follow the roadmap. Do not leave `main` unable to complete a voice turn.
