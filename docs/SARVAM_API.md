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
| Chat / LLM | `POST /v1/chat/completions` | `sarvam-30b` (swap `sarvam-105b` for agentic) | REST (OpenAI-compatible shape) |
| Transliteration | `POST /transliterate` | — | REST |
| Language ID | `POST /text-lid` | — | REST |

Note the chat path is **`/v1/chat/completions`**, not `/chat/completions` — the `/v1` prefix
is the OpenAI-compatible surface, and it's the one LiteLLM expects. `GET /v1/models` lists
what your key can actually call (today: `sarvam-30b`, `sarvam-105b` — nothing else).

Streaming endpoints the live loop depends on (both are what `packages/sarvam` uses):

| | URL | Notes |
|-|-----|-------|
| STT | `wss://api.sarvam.ai/speech-to-text/ws` | query: `model`, `mode`, `language-code`, `sample_rate` (16000\|8000). Client sends `{"audio":{"data":<base64 PCM16>,"sample_rate":"16000","encoding":"audio/wav"}}`, then `{"type":"flush"}` to force finalize. Server sends `{"type":"data","data":{"transcript","language_code",…}}`. |
| TTS | `wss://api.sarvam.ai/text-to-speech/ws` | query: `model`. Client sends `{"type":"config","data":{…}}`, then `{"type":"text","data":{"text"}}` per sentence, then `{"type":"flush"}`. Server sends `{"type":"audio","data":{"audio":<base64>}}`. There is no end-of-stream message — close on quiet. |

Measured, not marketed (local, one Hindi turn): STT ~150ms is the *processing* latency, but
the transcript only arrives after your `flush` — no interim partials came down the socket,
so plan the endpoint-to-transcript gap into the budget. LLM ~450ms TTFT with thinking off
(see below). TTS ~500ms to first chunk.

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
(8000–48000; high rates REST-only), `output_audio_codec`, optional pronunciation-dictionary
id (`dict_id`). Output is base64 audio — decode before use. **Deprecated:** `bulbul:v1`.
`pitch`, `loudness` and `enable_preprocessing` are **not supported on v3** (v2-only).

Speaker names are **lowercase and case-sensitive**, and the v3 roster is not the v2 roster:
`anushka` and `meera` are v2 speakers and are **rejected by v3** with a 400. v3 speakers
include `shubh` (default), `ritu`, `aditya`, `priya`, `neha`, `rahul`, `kavya`, `amit`,
`ishita`, `shreya`, and ~25 more. When one 400s, the error body lists the whole valid set.

For the live loop we ask for `output_audio_codec: "linear16"` at `speech_sample_rate:
"24000"`: headerless PCM16, so chunks concatenate and play as they arrive. `wav` would put
a RIFF header on every chunk and the client would have to decode each one separately.

### Translation — `/translate`
`sarvam-translate` for formal 22-language coverage; `mayura` for colloquial / code-mixed
(Hinglish). Prefer having the LLM answer directly in the target language when possible, and
reserve `/translate` for when you need a dedicated translation hop.

### LLM — `/v1/chat/completions`
`sarvam-30b` (2.4B active params, low latency, 64K context, native code-mixed input) for
the live loop. `sarvam-105b` for agentic/tool-use or as the eval judge. OpenAI-compatible
request/response shape, so route it through LiteLLM.

**Both models are reasoning models, and this will silently break a voice loop.** Thinking
tokens stream as `delta.reasoning_content` and are billed against `max_tokens` *before* any
`delta.content`. On a real scheme question the model spends 1100–1900 tokens thinking, so
at `max_tokens: 512` it never reaches a first word — you get an empty reply, a
`finish_reason: "length"`, and **no error at all**. The hop looks fine and says nothing.

Turning it off is not where you'd expect:

| Attempt | Result |
|---------|--------|
| `reasoning_effort: "low"` / `"medium"` / `"high"` | still reasons at length (1100–1900 tokens, 4–7s to first word) |
| `reasoning_effort: "none"` | 400 — only low/medium/high are valid |
| `/no_think` in the system or user prompt | no effect |
| `chat_template_kwargs: {enable_thinking: false}` at top level | silently ignored |
| **`extra_body: {chat_template_kwargs: {enable_thinking: false}}`** | **0 reasoning tokens, ~340ms to first word** |

That last row is the one the voice loop runs on (`thinking: false` is the default in
`packages/sarvam`'s `chat()`). Turn thinking back on for the eval judge, where the seconds
buy something.

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
