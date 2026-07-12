# Sarvam API reference (project cheat sheet)

Enough to build against without guessing. When in doubt, pull the live spec — the docs are
LLM-readable: append `.md` to any docs page URL for markdown, or `/llms.txt` to any URL for
a page index. Full dump: `https://docs.sarvam.ai/llms-full.txt`.

- Base URL: `https://api.sarvam.ai`
- Auth header: `api-subscription-key: <SARVAM_API_KEY>` (read from `process.env`, never
  hardcode). Python SDK calls this `api_subscription_key`.
- Dashboard / keys / pricing: `https://dashboard.sarvam.ai`, pricing at
  `https://docs.sarvam.ai/api-reference-docs/getting-started/pricing`.
- API status: `https://status.sarvam.ai`.

## Endpoints we use

| Purpose | Endpoint | Model | Transport |
|---------|----------|-------|-----------|
| Speech to text | `POST /speech-to-text` | `saaras:v3` | REST (<30s), WebSocket (real-time), Batch (up to ~1–2h) |
| Text to speech | `POST /text-to-speech` | `bulbul:v3` | REST, REST Stream, WebSocket |
| Text translation | `POST /translate` | `sarvam-translate` / `mayura` | REST |
| Chat / LLM | `POST /chat/completions` | `sarvam-30b` (swap `sarvam-105b` for agentic) | REST (OpenAI-compatible shape) |
| Transliteration | `POST /transliterate` | — | REST |
| Language ID | `POST /text-lid` | — | REST |

Streaming endpoints we depend on for the live loop:
- STT WebSocket: `/speech-to-text` WS — first token ~150 ms in fast mode.
- TTS WebSocket / REST Stream: `/text-to-speech` streaming — first chunk ~200 ms.

Avoid the legacy `/speech-to-text-translate` endpoint (it pins `saaras:v2.5`). Use
`/speech-to-text` with `mode="translate"` instead.

## Models — use these, avoid the deprecated ones

### STT — `saaras:v3`
Flexible output `mode` (this param is v3-only):
- `transcribe` — text in the spoken language (default use)
- `translate` — Indic speech in, English text out (one call)
- `verbatim` — every filler/hesitation/number exactly as spoken (use for building golden
  ground-truth alignments)
- `translit` — romanized output
- `codemix` — handles Hinglish/Tanglish mid-sentence switching (use for real call audio)

Features: speaker diarization, word-level timestamps, code-mixing, language auto-detect
(pass `unknown`). **Deprecated — do not use:** `saarika:v1`, `saarika:v2`, `saarika:flash`.
(`saarika:v2.5` still exists as a transcribe-only fallback but prefer `saaras:v3`.)

### TTS — `bulbul:v3`
Key params: `text`, `target_language_code` (BCP-47), `speaker`, `pace` (0.5–2.0),
`temperature` (0.01–2.0, default 0.6 — controls expressiveness), `speech_sample_rate`
(8000–48000; high rates REST-only), `pitch`, optional pronunciation-dictionary id.
Speaker names are **lowercase and case-sensitive** (`anushka`, not `Anushka`); default is
`shubh`. Output is base64 audio — decode before use. **Deprecated:** `bulbul:v1`. Note
`loudness` and a few params are v2-only and ignored by v3.

### Translation — `/translate`
`sarvam-translate` for formal 22-language coverage; `mayura` for colloquial / code-mixed
(Hinglish). Prefer having the LLM answer directly in the target language when possible, and
reserve `/translate` for when you need a dedicated translation hop.

### LLM — `/chat/completions`
`sarvam-30b` (2.4B active params, low latency, 64K context, native code-mixed input) for
the live loop. `sarvam-105b` for agentic/tool-use or as the eval judge. OpenAI-compatible
request/response shape, so route it through LiteLLM.

## Language codes (BCP-47)

TTS + LLM (11): `hi-IN`, `bn-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `od-IN`, `pa-IN`, `ta-IN`,
`te-IN`, `en-IN`, `gu-IN`. STT and `/translate` cover the full set of 22 scheduled
languages. Pass `unknown` to STT for auto-detection.

## SDKs

- Python: `sarvamai` (`pip install sarvamai`) — `client.text_to_speech.convert(...)`,
  `client.speech_to_text.transcribe(...)`, etc.
- TypeScript: use the REST/WebSocket APIs directly in `packages/sarvam`, or the Mastra
  `@mastra/voice-sarvam` adapter as a reference for param shapes. We wrap our own typed
  client so streaming and trace-emission are first-class.

## Pricing note

STT is roughly Rs. 1.5/min on the standard plan; free credits on signup. Keep the golden
set small and cache repeated eval audio (`enable_cached_responses` on TTS) so eval runs
don't burn credits. Confirm current numbers on the pricing page before relying on them.
