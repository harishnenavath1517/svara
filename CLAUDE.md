# CLAUDE.md

Steering context for Claude Code. Read this before touching anything. When a task
is ambiguous, prefer the conventions here over your defaults.

## What we're building

`svara` — a real-time Indic voice agent with a first-class evaluation harness.

A caller speaks in their language (Hindi, Tamil, Telugu, code-mixed Hinglish/Tanglish);
the agent understands intent, grounds its answer in a knowledge base, and replies with
streamed speech in the same language. Every hop is measured, so quality drift is caught
before it ships.

Use case (pick one and commit in `docs/ROADMAP.md`): government-scheme helpline,
hospital appointment/triage line, or KYC/support bot. All three are markets Sarvam sells
into, which is deliberate — the project should read as market-aware, not a toy demo.

The eval harness is the point of this project, not a nice-to-have. It is the thing that
differentiates this repo from every other student voice demo. Do not deprioritize it.

## Two planes

1. **Runtime plane** — the live voice loop. Client → gateway → `STT → LLM → TTS`,
   orchestrated as a durable Temporal workflow. Streams end to end.
2. **Eval plane** — every hop emits a trace event to Redpanda. Traces land in Postgres +
   object storage. An offline eval runner replays a golden set and scores quality; a
   dashboard diffs runs and flags regressions.

Full design: `docs/ARCHITECTURE.md`. Eval detail: `docs/EVAL_STRATEGY.md`.

## Tech stack (pinned — do not swap without asking)

- Package manager: `pnpm` workspaces (monorepo)
- Frontend + dashboard: Next.js 15 (App Router), React 19, TypeScript strict
- Voice gateway: standalone Node service (long-lived WebSocket; NOT an edge function)
- Orchestration: Temporal (TypeScript SDK)
- AI: Sarvam APIs — `saaras:v3` (STT), `bulbul:v3` (TTS), `sarvam-translate`/`mayura`
  (translation), `sarvam-30b` (LLM). See `docs/SARVAM_API.md`.
- LLM routing: LiteLLM in front of the LLM hop so models are swappable
- Vectors / RAG: Qdrant
- Event bus: Redpanda (Kafka API)
- Relational + auth + object storage: Supabase (Postgres)
- Local infra: docker-compose (Redpanda, Temporal, Qdrant)

## Repo structure

```
apps/
  web/          Next.js 15 — call UI + eval dashboard
  gateway/      Node WS service — VAD, barge-in, session, streams to orchestrator
  sink/         Consumes svara.traces + svara.turns → Postgres. Idempotent; replayable.
packages/
  sarvam/       Typed Sarvam client (STT/TTS/translate/chat/transliterate), streaming helpers
  orchestrator/ Temporal workflows + activities (the turn saga)
  eval/         Golden-set loader + builder, scorers (WER/chrF/judge/latency), runner CLI, smoke
  db/           Postgres schema + typed access. Shared by sink, eval, and the dashboard.
  shared/       Types, trace-event schema, language codes, constants, WAV + blob store
infra/          docker-compose + Temporal/Redpanda/Qdrant config
evals/golden/   Golden dataset: hand-authored source + synthesized audio, per language
docs/           Architecture, eval strategy, API ref, roadmap, data contracts
```

`shared` has no internal deps and everything imports it.

There is **no build step for internal packages**. They resolve straight to TypeScript source
(`"main": "./src/index.ts"`), and apps transpile them (`tsx` for gateway/worker,
`transpilePackages` for Next). Don't add a `dist`/`tsc -b` pipeline — there's nothing to
build and nothing to go stale.

## Commands

```bash
pnpm install
pnpm infra:up          # docker-compose up + create topics + apply the Postgres schema
pnpm infra:down
pnpm dev               # web + gateway + temporal worker + trace sink, in parallel
pnpm golden:build      # synthesize the golden set (Bulbul) and QA it (Saaras). Caches audio.
pnpm eval              # run the offline eval harness against the golden set
pnpm eval --against <run_id>          # diff two runs — this is the deliverable
pnpm eval:report       # write/refresh dashboard data from the latest run
pnpm --filter @svara/eval run smoke   # drive one real turn through the live loop
pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` is `next build`, and it is not optional in the gate: it is the only check that
compiles the browser bundle, and `typecheck` + `test` both stayed green for two phases on a
dashboard `next build` could not compile (guardrail 10).

`pnpm eval` is the model harness; it calls the hops directly and would stay green while the
orchestration underneath it was broken. `run smoke` is the check that the thing we *ship* still
works — it plays a golden clip into the gateway as a caller and asserts a full turn comes back.
Run it after touching a hop, the bus, or the gateway.

If the loop suddenly can't complete a turn: **check the port before you debug the code.** A
stale `pnpm dev` keeps :8787 bound, the new gateway silently fails to bind, and the smoke test
then talks to a dead stack — which is indistinguishable from an intermittent product bug and
has already cost an hour once. Kill the port, not the process name.

Local ports (from `infra/docker-compose.yml`): Redpanda **19092** (9092 is in-network only —
`REDPANDA_BROKERS` must say 19092), Redpanda Console 8080, Temporal 7233, Temporal UI 8233,
Qdrant 6333, Postgres 5432.

Two of these don't do the full job yet, on purpose: `pnpm dev` only starts what exists (the
Next app lands in Phase 1), and `pnpm eval` exits non-zero until Phase 2 — a green eval run
that scored nothing is worse than no eval run. Don't "fix" either by making it exit 0.

## Guardrails — these are not optional

1. **Sarvam models.** Use `saaras:v3` and `bulbul:v3` ONLY. `saarika:v1/v2/flash` and
   `bulbul:v1` are DEPRECATED and will fail. Model ids, STT modes, and language codes are
   pinned in `packages/shared` (`MODELS`, `STT_MODES`, `SPEECH_LANGUAGES`) — import them,
   don't retype string literals. When unsure about any Sarvam endpoint, param, or model,
   pull the current spec from `https://docs.sarvam.ai/llms-full.txt` (append `/llms.txt` to
   any Sarvam docs URL for a page index). Do not invent params.
2. **Never commit secrets.** `SARVAM_API_KEY` lives in `.env` (git-ignored); `.env.example`
   carries a placeholder and is committed, so never paste a real key into it. Read the key
   via `sarvamApiKey()` from `packages/shared`, which returns a `Secret` — it redacts itself
   in logs, `JSON.stringify`, and template literals, and yields the raw value only from an
   explicit `.reveal()` at the call site that sets the `api-subscription-key` header. Don't
   reach for `process.env.SARVAM_API_KEY` directly; that's how it ends up in a log line.
   Never put the key in a URL query string.
3. **Stream every hop.** Do not buffer a full transcript before calling the LLM, or a full
   LLM response before calling TTS. Partial transcript → LLM, first sentence → TTS. The
   <800ms first-audio budget is unreachable otherwise. Two things that budget depends on and
   that look like noise if you don't know: `sarvam-30b` **reasons by default**, and its
   thinking tokens are billed against `max_tokens` *before* any reply — at 512 tokens you get
   an empty reply and no error. The `thinking: false` default in `packages/sarvam`'s `chat()`
   is what turns it off; don't remove it. And **barge-in cannot ride on Temporal
   cancellation** (heartbeat-throttled, seconds late) — the gateway aborts the hops in-band.
9. **The config hash follows the config.** `config_hash` is the trace's claim about *which
   configuration produced this number*. It is `configHashOf(flow)` — a function of the turn's
   resolved `FlowConfig` — never a constant. If you add a knob that can change a hop's output,
   add it to `flowFingerprint` in the same change, or you have built a machine that files one
   configuration's results under another's name, silently and undetectably from downstream.
   `packages/shared/src/flow.test.ts` fails if you forget. The one deliberate exclusion is
   `stt.lang`: language is a property of the *call*, not the configuration, and the trace
   already carries it as a column — hashing it stops live traffic from ever matching an eval
   run. Client-supplied flows are `sanitizeFlow`d server-side; the browser is never the
   authority, and the gateway echoes back what it actually resolved.
10. **Client components import `@svara/shared/browser`, not `@svara/shared`.** The root barrel
   re-exports `blob.ts` → `node:fs`/`node:path`; a `"use client"` file that pulls the barrel
   drags those into the browser bundle and **`next build` fails** — while `next dev` serves the
   page happily, so nothing notices until you ship. (That is exactly how a dashboard that could
   not be production-built stayed green for two phases.) The `/browser` entry is the pure half:
   constants, types, the wire contract, and the flow config. It also keeps `sarvamApiKey()` off
   the client's import graph entirely.
4. **Every hop emits a trace event** to Redpanda (`svara.traces`) with the schema in
   `docs/DATA_CONTRACTS.md`, typed as `TraceEvent` in `packages/shared`. Emit on failure too
   (set `error`, still record `latency_ms`) — failed turns are the most valuable eval data.
   The eval plane is dead without this. Treat a missing trace as a bug, not an optimization.
   Concretely: **the whole hop body goes inside the `try`, including the part that waits on the
   bus.** `respond` used to wait for STT *above* its try block, so a hop that stalled there
   emitted nothing at all — no error, no latency — and the turn simply vanished from the eval
   plane at the exact moment it most needed explaining.
8. **Never score a model with itself.** The golden set's ground truth is the hand-authored
   script, not a Saaras transcript of Bulbul's audio — that would be one model grading its own
   homework, and a number that cannot fall no matter how far quality degrades. The QA gate runs
   in a *different* STT mode (`translit`) from the one it grades (`codemix`), for the same
   reason. And **naive WER cannot score code-mixed ASR**: Saaras hears "Aadhaar card" perfectly
   and writes it in Devanagari, which token WER counts as four substitutions. Report the
   script-sensitive and script-invariant numbers side by side; the gap is the finding. See
   `docs/EVAL_STRATEGY.md`.
5. **Barge-in is a P0 feature**, not polish. The gateway must cancel in-flight TTS the
   moment VAD detects the user speaking.
6. **Temporal owns the turn.** STT/LLM/TTS are activities with per-hop timeouts and
   retries — not bare awaits. This is what makes the "what if the LLM hangs" answer real.
7. TypeScript strict everywhere. No `any` without a `// reason:` comment.

## How to work

- Follow `docs/ROADMAP.md` phase by phase. Each phase has a checklist; do them in order.
- One concern per commit. Keep the voice loop working at every step — never leave `main`
  in a state where `pnpm dev` can't complete a turn.
- Run `pnpm eval` before merging anything that touches a hop. Note any metric movement in
  the PR description — that habit is half the value of this project.
- When you add a Sarvam call, add a matching trace emission in the same change.
