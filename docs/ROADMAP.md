# Roadmap

Build in order. Each phase ends with something demonstrable. Don't start a phase until the
previous one's exit check passes. Keep `main` able to complete a voice turn from Phase 1 on.

## Use case (committed) — government-scheme helpline

A citizen calls to ask about a welfare scheme in their own language and gets a grounded
answer: am I eligible, what's my application status, how do I apply, which documents do I
need, how do I raise a grievance.

Chosen over hospital triage and KYC because it maximises the parts of the project that are
actually being evaluated, and minimises the parts that are liabilities:

- **The RAG story is honest.** Scheme rules are public documents, so the Qdrant corpus is
  real source material rather than invented FAQ text.
- **The golden set is buildable.** Utterances can be synthesized with Bulbul and labelled
  with Saaras `verbatim` — no consented-recording problem, no PII, no PHI. `consent:
  "synthetic"` is a truthful provenance for the whole set.
- **Code-mixing is native to the domain.** Real scheme queries are Hinglish/Tanglish, which
  is exactly the axis the eval harness is built to measure.
- **No safety tax.** A wrong triage answer is a clinical-safety incident; a wrong scheme
  answer is a quality regression the harness is designed to catch.

Intents: `check_eligibility`, `check_status`, `how_to_apply`, `document_list`, `grievance`.

## Phase 0 — Scaffold & infra (½ day)

- [x] Init pnpm workspace: `apps/{web,gateway}`, `packages/{sarvam,orchestrator,eval,shared}`.
- [x] `shared`: trace-event type, hop signatures, language-code enum, constants.
- [x] `infra/docker-compose.yml`: Redpanda, Temporal, Qdrant. `pnpm infra:up` brings them up.
- [x] `.env` from `.env.example`; verify `SARVAM_API_KEY` loads and is never logged.
- [x] Root scripts: `dev`, `infra:up`, `eval`, `eval:report`, `typecheck`, `test`.
- [x] Pick and record the use case (scheme helpline / triage / KYC) at the top of this file.

Exit: `pnpm infra:up` healthy; `pnpm typecheck` green on empty packages. **Met.**

Phase 0 notes:
- `apps/web` is a stub package — Next.js is installed in Phase 1, when there's a page to
  render. Everything else in the workspace is real.
- Internal packages resolve to TypeScript source (`main: ./src/index.ts`), so there is no
  build step to keep in sync. Apps transpile them (`tsx` / Next `transpilePackages`).
- `pnpm eval` exits non-zero until Phase 2 implements it, on purpose: a green eval run that
  scored nothing is worse than no eval run.
- Redpanda's host listener is **19092** (9092 is in-network only). `REDPANDA_BROKERS` in
  `.env` reflects this.

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
