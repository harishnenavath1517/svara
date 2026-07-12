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
  normalizer change can look like a quality change.
- Use Saaras `verbatim` mode to build clean ground-truth alignments for the golden set.
- Report code-mixed segments separately (Hinglish/Tanglish) — that's where ASR is weakest
  and where Sarvam is supposed to win, so it's the most interesting cell in the table.

### 2. Translation / understanding
- **chrF** and **COMET** against `reference_translation` (when the turn involves
  translation).
- **LLM-as-judge** (Sarvam-105B or Claude) scoring adequacy + fluency on a 1–5 scale with a
  fixed rubric. Store the judge's rationale, not just the score.
- **Metric↔judge agreement**: correlation between chrF/COMET and the judge across the set.
  A low correlation is a finding, not a failure — surface it.

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

## Golden set

Location: `evals/golden/`. One record per line (JSONL), grouped by language. Schema in
`DATA_CONTRACTS.md`. Aim for a small, high-quality set first — ~20 utterances per language
covering: clean speech, code-mixed speech, numbers/dates (money, phone numbers), noisy
audio, and each supported intent. Grow it when a real failure surfaces (add the failing
case as a permanent regression test).

Record provenance and consent for any real audio. Synthetic golden audio (generated via
Bulbul, then hand-verified) is fine to bootstrap and avoids privacy issues.

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
can be attributed to a specific change.

## Online evals (later)

Sample a small fraction of live traffic, run the judge asynchronously off the trace stream,
and alert on drift. Keep it off the hot path — never let scoring add latency to a live turn.

## The sentence this buys you

The reason to build all of this: in an interview you can say something like *"we caught a
12% Tamil WER regression when we switched STT modes, the dashboard flagged it before merge,
and the golden set now has that case as a permanent guard."* That sentence is the hire
signal. Everything here exists to make it true.
