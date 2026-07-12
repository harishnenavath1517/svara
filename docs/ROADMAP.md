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

- [x] `packages/sarvam`: typed client for `/speech-to-text` (WS), `/text-to-speech` (WS),
      `/chat/completions`. Streaming helpers. Uses `saaras:v3` / `bulbul:v3` only.
- [x] `apps/gateway`: WebSocket server; accept mic audio; **VAD**; **barge-in** (cancel
      in-flight TTS on user speech); session state keyed by `session_id`.
- [x] `packages/orchestrator`: Temporal turn workflow with `transcribe → respond →
      synthesize` activities, per-hop timeouts + retries.
- [x] Pipeline the hops: first LLM sentence → TTS.
- [x] `apps/web`: minimal call UI — connect, mic capture, audio playback, live transcript.
- [x] Barge-in verified end to end (speak over the agent, it stops).

Exit: speak in Hindi + one South-Indian language, get a coherent spoken reply, first audio
under ~1s locally. Record a screen capture — this is the shareable demo.

**Met, with one number to keep honest.** Driven end to end with synthesized caller audio
(Bulbul → gateway → Saaras → sarvam-30b → Bulbul → back), in both required languages:

| Turn | Transcript | Reply | First audio |
|------|-----------|-------|-------------|
| Hindi | "नमस्ते मुझे PM किसान योजना के लिए पात्रता जाननी है" | 2 sentences, 9.0s of speech | **860 ms** |
| Tamil | "வணக்கம் எனக்கு PM Kisan திட்டத்திற்கான தகுதி தெரிய வேண்டும்" | 2 sentences, 10.4s of speech | **799 ms** |

against a 800ms budget from mic close. Barge-in verified: the caller talks over the agent,
playback stops ~300ms later, the hops abort mid-call (TTS at 980ms instead of running 6.7s
to completion), the turn traces `error: {code: "cancelled"}`, and zero stale audio chunks
arrive after the stop.

Phase 1 notes — read these before touching a hop:

- **Where the streams live.** Temporal activities take serializable arguments and return
  serializable results; they cannot be handed a live microphone. So the gateway is the
  stream broker and Temporal is the control plane: audio and hop output ride an internal
  WebSocket between the gateway and the worker, while the workflow owns the turn's
  timeouts, retries, and cancellation. The three hops run *concurrently* and hand off
  through an in-worker turn bus. See `packages/orchestrator/src/protocol.ts` and `bus.ts`.
- **Barge-in cannot ride on Temporal cancellation.** Temporal delivers cancellation to an
  activity only in the response to a heartbeat, and heartbeats are throttled to ~80% of
  `heartbeatTimeout`. Measured: a cancelled turn's TTS kept streaming for five more
  seconds — silent to the caller, but still billing. The gateway now sends an in-band
  `cancel` frame that aborts the hops' sockets in the worker immediately; Temporal
  cancellation runs behind it for the workflow's own bookkeeping.
- **sarvam-30b thinks by default, and it will eat your whole turn.** Its reasoning tokens
  are billed against `max_tokens` and stream *before* any reply. At `max_tokens: 512` it
  never reaches a first word: empty reply, `finish_reason: "length"`, no error anywhere.
  `reasoning_effort` does not turn it off. `extra_body.chat_template_kwargs.enable_thinking
  = false` does: 0 reasoning tokens, ~340ms to first word. See `packages/sarvam/src/chat.ts`.
- **The 860ms is STT's, not ours.** Saaras only emits a transcript after the `flush` that
  the VAD endpoint triggers — no interim partials arrived on the WS. LLM (~450ms TTFT) and
  TTS (~500ms to first chunk) are inside budget; the STT finalize is the gap. Feeding
  partial transcripts to the LLM is worth revisiting when Saaras streams them.
- **The VAD is energy + hysteresis**, not a neural model — it runs in microseconds and
  barge-in latency is dominated by cancelling TTS, not by detection. Swap in Silero behind
  the same interface if a demo room is noisy.

## Phase 2 — Traces & the eval harness (the differentiator) (2–3 days)

- [x] Every hop emits a `svara.traces` event (schema in `DATA_CONTRACTS.md`), including on
      error. Add the emission in the same change as each Sarvam call.
- [x] Trace sink: consume `svara.traces` → Postgres rows + audio blobs to storage.
- [x] `evals/golden/`: ~20 utterances/language across clean / code-mixed / noisy / numbers /
      each intent. Bootstrap audio with Bulbul; QA it with Saaras (see notes — the ground
      truth is the *authored script*, not a Saaras transcript).
- [x] `packages/eval` runner + CLI (`pnpm eval [--lang] [--hop] [--against]`):
  - [x] STT: WER/CER per language, code-mixed reported separately.
  - [x] Translation: chrF + LLM-judge, plus metric↔judge agreement. **COMET: not done — see
        notes.**
  - [x] Intent accuracy + confusion matrix.
  - [x] TTS: round-trip intelligibility (synthesize → transcribe → WER).
  - [x] Latency: per-hop + e2e p50/p95/p99.
- [x] Write versioned `eval_runs` + `eval_scores` with `config_hash` and `git_sha`.

Exit: `pnpm eval` produces per-language scores for every hop and persists a run you can diff.
**Met.** Baseline run `58ab3e4c`, 40/40 golden records scored across hi-IN and ta-IN, every
hop, persisted and diffable (`pnpm eval --against <run_id>`).

### The headline finding: naive WER inverts the code-mixed result

The number this project exists to produce, and it is the opposite of what a naive harness
would have reported:

| hi-IN slice | WER (script-sensitive) | WER (script-invariant) |
|-------------|-----------------------:|-----------------------:|
| clean       | 0.093                  | 0.073                  |
| **code-mixed** | **0.234**           | **0.021**              |
| numbers     | 0.140                  | 0.053                  |
| noisy       | 0.119                  | 0.143                  |

Saaras hears "Aadhaar card" perfectly and writes it as "आधार कार्ड". Token WER against a
Latin-script reference scores all four loanwords in that utterance as substitutions — exactly
0.5 WER on a transcription with **zero recognition errors**. Aggregated, that makes code-mixed
look like the *worst* slice (0.234, 2.5× clean) when it is in fact the *best* (0.021).

A harness that reported only the first column would have concluded "Sarvam is bad at
Hinglish" and sent someone off to fix a model that is working. The harness reports both
columns and the gap between them, because the gap **is** the finding. Concretely: the
production `codemix` mode preserves Latin loanwords; the eval also runs `translit` mode and
scores it against a hand-authored romanization to get the script-invariant number.

Caveat, stated rather than buried: on ta-IN the romanized column carries a
**romanization-convention offset** (clean scores 0.032 native but 0.226 romanized — the
recognition is near-perfect, the hand-authored spelling simply differs from Saaras's). For
Tamil it is a *relative* regression detector, not an accuracy figure. Hindi's convention
happens to line up, so both columns are meaningful there.

### Phase 2 notes — read these before touching the eval plane

- **The golden set's ground truth is the authored script, not a model output.** The audio is
  Bulbul-synthesized, so building the "expected transcript" by running Saaras over it would be
  Saaras-vs-Saaras — a model marking its own homework, and a number that cannot fall no matter
  how bad the model gets. Saaras still runs over each clip, but only as a **QA gate** ("did
  Bulbul say what we asked?"), in `translit` mode — *not* the production `codemix` mode. A gate
  that grades a mode with itself quarantines precisely the records that mode is worst at and
  leaves a set of easy ones that scores green and measures nothing.
- **The QA gate scores CER, not WER.** Romanization has no single spelling convention: Saaras
  writes "maadhangalaaga" where a human writes "maathangalaaga". WER scores that pair 0.60 and
  quarantines a flawless record; CER sees ~0.1. An earlier revision of the gate quarantined all
  six code-mixed records, every one of which Bulbul had spoken correctly.
- **`/transliterate` is not a pure function and is not in the metric path.** For `ta-IN` it is
  non-deterministic and degenerates into a repetition loop ("… uraiya uraiya uraiya" ×80) on
  byte-identical input; `hi-IN` is stable. A metric that called it would report API jitter as a
  regression. The romanized reference is hand-authored instead. Saaras `translit` *mode*, by
  contrast, is deterministic across repeat calls on both languages — that one is safe.
- **Saaras returns an empty transcript, not an error, when you hammer it.** Opening 40
  WebSockets back-to-back made a third of them come back with nothing at all. An empty
  transcript is indistinguishable from "the caller said nothing", so a rate limiter would have
  silently poisoned the golden set with blank references and scored every one as a 100% model
  error. The build and the runner pace themselves and back off; that is not politeness, it is
  the difference between measuring a model and measuring a rate limiter.
- **The judge is saturated on Hindi and cannot gate anything there.** 19 of 20 records scored a
  flat 5.0, so chrF↔judge Spearman is 0.141 — there is nothing to correlate with. On Tamil the
  judge actually discriminates (2.5–5.0) and agreement rises to 0.473. This is the
  "metric + judge, never judge alone" rule earning its keep: low agreement is a *finding*, not
  a failure, and here it says the judge's Hindi scores are noise.
- **COMET is not implemented, and no fake number stands in for it.** It is a Python model
  (`unbabel-comet`, ~2GB checkpoint) with no TypeScript port; wiring it in means a Python
  sidecar, which is a real piece of work and not a Phase 2 line item. chrF + LLM-judge +
  their agreement ship instead. This is the one Phase 2 checklist item not delivered.
- **Live STT `latency_ms` is not model latency.** A live trace's STT hop spans the caller
  actually speaking — Saaras emits nothing until the VAD endpoint triggers a flush — so the
  5.2s in production traces is a human talking. The offline eval times STT from
  audio-feed-start instead. Never put the two on one chart without saying which is which.
- **Synthetic audio is a lower bound on difficulty.** TTS speech is cleaner than a real call
  from a field. `consent: "synthetic"` is truthful provenance and the set is a regression
  detector, not an accuracy claim. The `noisy` bucket is additive white noise at a stated
  10dB SNR — honest, and not a substitute for real room noise.
- **`pnpm dev` leaves a gateway bound to :8787.** A stale one silently steals the port from the
  next run, the new gateway fails to bind, and the smoke test then talks to a dead stack — which
  looks exactly like an intermittent voice-loop bug and cost an hour of chasing one. Kill the
  port, not the process name, before concluding the loop is broken.

## Phase 3 — Regression dashboard (1–2 days)

- [x] `apps/web` dashboard: per-language metric tables, run-over-run deltas, latency budget
      vs actuals, trace drill-down (play the audio, read transcript + reply).
- [x] Highlight regressions (red/green deltas) between two runs.
- [x] `pnpm eval:report` refreshes dashboard data from the latest run.
- [x] Wire `pnpm eval` into CI; fail the build on a regression past a threshold.

Exit: you can point at a run diff and name which hop/language moved and by how much.

Done. `/evals` lists every run (including the ones that scored nothing — those stay visibly
hollow); `/evals/<run>?against=<run>` is the diff. Four things the dashboard is built to
refuse to do, because each of them is a way for it to lie:

1. **It never shows `wer` without `wer_romanized`.** hi-IN code-mixed reads 0.234
   script-sensitive and 0.021 script-invariant — worst slice and best slice, from the same
   audio, from a transcription with no recognition errors. The gap gets its own column,
   because the gap *is* the finding.
2. **It never prints a judge mean without its `n` and its chrF agreement.** The judge is
   saturated on hi-IN (19 of 19 scored records flat at 5.0), so its mean cannot fall no
   matter how far quality degrades; the panel says so out loud, and renders a null
   correlation as "not computed" rather than as a blank that reads like zero.
3. **It never puts offline-eval and live-trace latency on one axis.** A live STT hop's wall
   clock spans the caller *speaking*; the 5.2s in real traces is a human talking. TTFB
   leads, wall time is greyed, and the live numbers stay on `/traces`.
4. **It re-synthesizes nothing.** The drill-down plays the WAV the hop actually stored
   (caller 16kHz, agent 24kHz), resolved from the trace row — `/api/audio` takes a trace id,
   never a path, so there is nothing in the URL to traverse.

CI: `.github/workflows/ci.yml`. `typecheck` + `test` on every PR; the eval gate replays the
golden set through the real hops and fails on a regression past threshold. The thresholds are
measured, not guessed, and the measurement is in `packages/eval/src/metrics/regression.ts` —
including why `ttfb_p99` and wall `latency_p95` are reported but deliberately **not** gated
(they moved 732ms and 2.7s between two runs of *identical code*; gating them would fail
builds at random). And if two runs differ in `config_hash` or `golden_set_version`, the diff
is stamped NOT COMPARABLE and does not fail the build: a metric that moved may be a
configuration change rather than a quality change, and the harness does not get to guess.

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
