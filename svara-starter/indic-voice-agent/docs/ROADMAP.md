# Roadmap

Build in order. Each phase ends with something demonstrable. Don't start a phase until the
previous one's exit check passes. Keep `main` able to complete a voice turn from Phase 1 on.

## Phase 0 — Scaffold & infra (½ day)

- [] Init pnpm workspace: `apps/{web,gateway}`, `packages/{sarvam,orchestrator,eval,shared}`.
- [ ] `shared`: trace-event type, hop signatures, language-code enum, constants.
- [ ] `infra/docker-compose.yml`: Redpanda, Temporal, Qdrant. `pnpm infra:up` brings them up.
- [ ] `.env` from `.env.example`; verify `SARVAM_API_KEY` loads and is never logged.
- [ ] Root scripts: `dev`, `infra:up`, `eval`, `eval:report`, `typecheck`, `test`.
- [ ] Pick and record the use case (scheme helpline / triage / KYC) at the top of this file.

Exit: `pnpm infra:up` healthy; `pnpm typecheck` green on empty packages.

## Phase 1 — The voice loop (the demo) (2–3 days)

- [ ] `packages/sarvam`: typed client for `/speech-to-text` (WS), `/text-to-speech` (stream),
      `/chat/completions`. Streaming helpers. Uses `saaras:v3` / `bulbul:v3` only.
- [ ] `apps/gateway`: WebSocket server; accept mic audio; **VAD**; **barge-in** (cancel
      in-flight TTS on user speech); session state keyed by `session_id`.
- [ ] `packages/orchestrator`: Temporal turn workflow with `transcribe → respond →
      synthesize` activities, per-hop timeouts + retries.
- [ ] Pipeline the hops: partial transcript → LLM; first LLM sentence → TTS.
- [ ] `apps/web`: minimal call UI — connect, mic capture, audio playback, live transcript.
- [ ] Barge-in verified end to end (speak over the agent, it stops).

Exit: speak in Hindi + one South-Indian language, get a coherent spoken reply, first audio
under ~1s locally. Record a screen capture — this is the shareable demo.

## Phase 2 — Traces & the eval harness (the differentiator) (2–3 days)

- [ ] Every hop emits a `svara.traces` event (schema in `DATA_CONTRACTS.md`), including on
      error. Add the emission in the same change as each Sarvam call.
- [ ] Trace sink: consume `svara.traces` → Postgres rows + audio blobs to storage.
- [ ] `evals/golden/`: ~20 utterances/language across clean / code-mixed / noisy / numbers /
      each intent. Build ground truth with Saaras `verbatim` mode; bootstrap audio with
      Bulbul where you lack consented recordings.
- [ ] `packages/eval` runner + CLI (`pnpm eval [--lang] [--hop] [--against]`):
  - [ ] STT: WER/CER per language, code-mixed reported separately.
  - [ ] Translation: chrF + COMET + LLM-judge, plus metric↔judge agreement.
  - [ ] Intent accuracy + confusion matrix.
  - [ ] TTS: round-trip intelligibility (synthesize → transcribe → WER).
  - [ ] Latency: per-hop + e2e p50/p95/p99.
- [ ] Write versioned `eval_runs` + `eval_scores` with `config_hash` and `git_sha`.

Exit: `pnpm eval` produces per-language scores for every hop and persists a run you can diff.

## Phase 3 — Regression dashboard (1–2 days)

- [ ] `apps/web` dashboard: per-language metric tables, run-over-run deltas, latency budget
      vs actuals, trace drill-down (play the audio, read transcript + reply).
- [ ] Highlight regressions (red/green deltas) between two runs.
- [ ] `pnpm eval:report` refreshes dashboard data from the latest run.
- [ ] Wire `pnpm eval` into CI; fail the build on a regression past a threshold.

Exit: you can point at a run diff and name which hop/language moved and by how much.

## Phase 4 — Stretch (pick per target role)

- [ ] **Sim angle — React Flow builder:** node canvas over the existing activities (one node
      per hop, edges = the data contract), run a composed flow live. Closes the
      node-editor gap for Sim directly.
- [ ] **Content angle — localizer:** paste a YouTube/podcast link → STT → translate → TTS
      re-dub into 5 languages. Lower depth, high shareability; use as the post, not the repo.
- [ ] Online evals: sample live traffic, judge async off the trace stream, alert on drift.
- [ ] Telephony ingress (SIP) for a real "call the number" demo.

## Definition of done (for the portfolio)

A running voice agent, a green eval run across languages, a dashboard showing a real
run-over-run diff, and a README that states one concrete regression the harness caught. If
you can say that sentence truthfully in an interview, the project has done its job.
