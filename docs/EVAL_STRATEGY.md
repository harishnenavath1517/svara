# Evaluation strategy

This is the differentiating part of the project. A voice agent that works once in a demo is
common; one that can *prove* it stays good across 22 languages is rare. Treat the eval
harness with the same care as the runtime loop.

## Principles

- **Measure every hop independently**, then end-to-end. A bad reply can come from STT, the
  LLM, or TTS; per-hop scoring tells you which.
- **Metric + judge, never judge alone.** Report an automatic metric *and* an LLM judge, and
  report their agreement. Knowing where they disagree is the point — it shows you
  understand judge bias instead of trusting a single number.
- **Per-language, always.** An aggregate WER hides that Tamil regressed while Hindi
  improved. Break every metric down by language.
- **Regressions are the deliverable.** The dashboard's job is to surface deltas between
  runs, not to show one pretty snapshot.

## Metrics by hop

### 1. Speech-to-text (Saaras v3)
- **WER / CER** per language against `expected_transcript`. Normalize before scoring
  (lowercase, strip punctuation, Unicode NFC) and keep the normalizer versioned — a
  normalizer change can look like a quality change. `NORMALIZER_VERSION` is stamped on every
  run for exactly that reason.
- Report code-mixed segments separately (Hinglish/Tanglish) — that's where ASR is weakest
  and where Sarvam is supposed to win, so it's the most interesting cell in the table.

- **You cannot score code-mixed ASR with naive WER. This is the most important paragraph in
  this document.** Saaras hears "Aadhaar card" perfectly and writes it in Devanagari as
  "आधार कार्ड". Token WER against a Latin-script reference counts every loanword as a
  substitution — 0.5 WER on a transcription with *zero* recognition errors. Measured on the
  real golden set, that makes hi-IN code-mixed look like the worst slice (0.234, 2.5× clean)
  when it is actually the best (0.021). A naive harness would conclude "Sarvam is bad at
  Hinglish" and send someone to fix a model that works.

  So the harness reports **two** columns and the gap between them:
  - `wer` — production `codemix` mode vs the native-script reference. What a caller-facing
    system actually produces, script choice and all.
  - `wer_romanized` — `translit` mode vs a **hand-authored** romanization. Script-invariant:
    pure recognition error.

  The romanized reference is hand-authored because Sarvam's `/transliterate` endpoint is
  **not a pure function** — on `ta-IN` it is non-deterministic and degenerates into a
  repetition loop on byte-identical input. A metric that calls it reports API jitter as a
  regression. (Saaras `translit` *mode* is deterministic; the `/transliterate` *endpoint* is
  not. They are different things.)

  Caveat on ta-IN: the romanized column carries a spelling-convention offset (clean scores
  0.032 native but 0.226 romanized — recognition is near-perfect, the conventions just
  differ). For Tamil, treat it as a relative regression detector, not an accuracy number.

### 2. Translation / understanding

The agent replies in the caller's language, so there is no translation step in the runtime
loop to score. The translation axis is real anyway: Saaras v3's `translate` mode is Indic
speech in, English text out — a genuine translation output, scored against a hand-authored
`reference_translation`.

- **chrF** against `reference_translation`. Chosen over BLEU deliberately: these are
  morphologically rich languages where one inflected token carries what English spreads over
  three, so a word-level metric loses every n-gram a single suffix touches. chrF counts
  character n-grams and degrades gracefully.
- **COMET — NOT IMPLEMENTED.** It is a Python model (`unbabel-comet`, ~2GB checkpoint) with no
  TypeScript port. Wiring it in means running a Python sidecar. That is honest work, not a
  line item, and it is deferred rather than faked. **No placeholder number stands in for it**;
  a fabricated COMET score would be worse than an absent one.
- **LLM-as-judge** (`sarvam-105b`) scoring adequacy and fluency on **two separate** 1–5 axes
  with a fixed rubric. Separate, because a model that drops half the sentence in beautiful
  English is *fluent and inadequate*, and one blended "quality" score averages that into a
  meaningless 3. The judge's **rationale is stored**, not just the number — a score you cannot
  argue with is a score you cannot act on. `JUDGE_RUBRIC_VERSION` is stamped on every run.
- **Metric↔judge agreement**: Spearman (rank) and Pearson between chrF and the judge.
  Spearman is the one to trust: chrF is continuous, the judge emits integers, and there is no
  reason to expect a *linear* relationship — only a monotonic one.

**What the agreement actually told us, and why the rule earns its keep.** On the baseline run
the judge scored 19 of 20 Hindi records a flat 5.0. Spearman is 0.141 — not because chrF and
the judge disagree, but because the judge has **no variance to correlate with**. It is
saturated and cannot gate anything on Hindi. On Tamil it discriminates (2.5–5.0) and agreement
rises to 0.473. Had we reported the judge alone, Hindi would look perfect. Had we reported
chrF alone, we would not know the judge was useless there. That is the whole argument for
reporting both plus their correlation — a low number is a **finding**, not a failure.

Judge failures are counted separately (`judge_unparseable_rate`), never scored as a 1. An API
hiccup must not be able to masquerade as a quality regression.

### 3. Intent accuracy
- Classify the turn's intent and compare to the golden label. Report accuracy + confusion
  matrix per language. This is what actually determines whether the agent *did the right
  thing*, independent of wording.

### 4. Text-to-speech (Bulbul v3)
- **Round-trip intelligibility**: synthesize the reply, transcribe the synthesized audio
  back with Saaras, and measure WER against the original text. High round-trip WER = the
  voice is mangling words even if it "sounds fine."
- Optional later: a MOS-predictor model for naturalness. Round-trip WER is the cheap,
  honest v1.

### 5. Latency
- Per-hop **p50 / p95 / p99** and end-to-end first-audio latency, per language.
- Track against the budget in `ARCHITECTURE.md`. A latency regression is a quality
  regression for voice.
- The trace event already carries what you need: `latency_ms` (wall time for the hop) and
  `ttfb_ms` (time to first token/chunk on the streaming hops). For a voice agent **`ttfb_ms`
  is the number that matters** — a TTS hop that takes 6s but starts speaking in 500ms is a
  good turn; the reverse is a dead call. Report both, lead with TTFB.
- End-to-end first audio is measured **mic close → first audio at the caller** and is
  emitted on `svara.turns` as `first_audio_ms`. Phase 1 measured 860ms (Hindi) and 799ms
  (Tamil) against a 800ms budget — a two-turn sample, which is exactly why this belongs in
  a harness and not in a README claim.
- **Know what you're actually measuring.** In Phase 1 the whole overshoot was the Saaras
  finalize: no interim partials arrive on the STT socket, so the transcript only lands after
  the `flush` that the VAD endpoint triggers. A latency regression here could just as easily
  be a VAD-hangover change as a model change — per-hop TTFB is what tells them apart.

### 6. Failed and cancelled turns

Every hop traces on failure too (`error: {code, message}`), including barge-in
(`code: "cancelled"`). Do not filter these out of the eval set — they are the most
informative rows in it:

- A rising **cancelled** rate means callers are interrupting the agent, which usually means
  it is too slow or too verbose. That is a quality signal no WER will show you.
- A rising **`empty_transcript`** rate means VAD is firing on noise.
- A hop that fails and traces `latency_ms` still tells you *where* the turn died.

## Golden set

Location: `evals/golden/`. Built with `pnpm golden:build`. 20 utterances per language
(hi-IN, ta-IN), covering clean / code-mixed / numbers / noisy speech and all five intents.
Schema in `DATA_CONTRACTS.md`.

**Two files per language, and the split is load-bearing:**

- `evals/golden/source/<lang>.jsonl` — **hand-authored.** The utterance, its romanization, its
  intent label, its English reference translation. No model has touched any of it.
- `evals/golden/<lang>.jsonl` — **generated.** The source line plus the synthesized audio and
  the QA verdict.

**The ground truth is the script we fed the synthesizer, not a transcript of it.** The audio is
Bulbul-synthesized; if the "expected transcript" were built by running Saaras over that audio,
the STT score would be Saaras-vs-Saaras — a model grading its own homework, producing a number
that cannot fall no matter how far the model degrades. We know exactly what was said, because
we wrote it.

Saaras still runs over every clip, as a **QA gate** answering one narrow question: *did Bulbul
actually say the thing we asked?* Two properties make that gate trustworthy:

- It runs in `translit` mode, **not** the production `codemix` mode. A gate that grades a mode
  using that same mode quarantines exactly the records the mode is worst at, leaving a set of
  easy records that scores green and measures nothing. That is the single most dangerous
  failure an eval harness has.
- It scores **CER, not WER**. Romanization has no canonical spelling: Saaras writes
  "maadhangalaaga", a human writes "maathangalaaga". WER scores that pair 0.60 and would
  quarantine a flawless record; CER sees it for what it is.

A clip that fails the gate is quarantined (`usable: false`) rather than scored later as a model
failure it isn't.

**Provenance.** All 40 records are `consent: "synthetic"` — truthful, and it sidesteps the
privacy regime that collecting real welfare-helpline calls would demand. The cost is honesty
about difficulty: **TTS speech is cleaner than a real call from a field, so these numbers are a
lower bound on real-world error.** The set is a *regression detector*, not an accuracy claim.
The `noisy` bucket is additive white noise at a stated 10dB SNR with a seeded PRNG (so a
rebuild is byte-reproducible) — honest, and not a substitute for real room noise.

`GOLDEN_SET_VERSION` is stamped on every run: if the answer key changes, two runs are not
comparable and the diff says so.

Grow the set when a real failure surfaces — add the failing case as a permanent regression
test. That is how it earns its keep.

## Runner

`packages/eval` exposes a CLI:

```bash
pnpm eval                       # full set, all languages
pnpm eval --lang ta-IN          # one language
pnpm eval --hop stt             # one hop
pnpm eval --against <run_id>    # diff a previous run
```

Each run:
1. Loads the golden set.
2. Executes the pipeline (or replays captured `svara.traces`).
3. Scores every hop with the metrics above.
4. Writes a versioned run row (metrics + config hash + git sha) to Postgres.
5. `eval:report` refreshes the dashboard.

Store the **config hash** (models, modes, prompt versions) with every run so a metric move
can be attributed to a specific change. It is computed in
`packages/orchestrator/src/config.ts` — anything that can change an output belongs in it.
When you add a knob that moves quality (a decoding param, a VAD threshold, thinking on/off),
add it to the hash in the same change, or two runs that scored differently will claim to
have been the same configuration.

The judge is the one place thinking should be **on**: `chat()` defaults to `thinking: false`
because the voice loop cannot afford it (see `docs/SARVAM_API.md`), but an LLM judge is
off the hot path and the reasoning is what you're paying for. Pass `thinking: true` there.

## Online evals (later)

Sample a small fraction of live traffic, run the judge asynchronously off the trace stream,
and alert on drift. Keep it off the hot path — never let scoring add latency to a live turn.

## The sentence this buys you

The reason to build all of this: in an interview you can say something like *"we caught a
12% Tamil WER regression when we switched STT modes, the dashboard flagged it before merge,
and the golden set now has that case as a permanent guard."* That sentence is the hire
signal. Everything here exists to make it true.
