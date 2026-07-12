# Data contracts

The interfaces that hold the two planes together. Implement against these; change them
deliberately and update this file in the same commit.

## Trace event (`svara.traces`)

Emitted once per hop, per turn, to Redpanda. This is what the eval plane consumes — a
missing or malformed event is a bug, not a minor issue.

```jsonc
{
  "trace_id": "uuid",          // one per turn
  "session_id": "uuid",        // one per call/conversation
  "turn_index": 0,             // 0-based within the session
  "hop": "stt",                // "stt" | "llm" | "tts"
  "lang": "ta-IN",             // BCP-47; "unknown" if not yet detected
  "model": "saaras:v3",        // exact model + mode used
  "mode": "codemix",           // stt mode when applicable, else null
  "input_ref": "s3://.../in.wav",   // audio blob (stt/tts) or null
  "output_ref": "s3://.../out.wav", // audio blob (tts) or null
  "text_in": "…",              // transcript into llm, or text into tts
  "text_out": "…",             // transcript (stt), reply (llm), or null (tts)
  "rag_context_ids": ["…"],    // qdrant point ids used (llm hop), else []
  "latency_ms": 312,           // wall time for this hop
  "ttfb_ms": 148,              // time to first byte/token (streaming hops)
  "config_hash": "sha256:…",   // models + modes + prompt versions
  "git_sha": "…",
  "ts": "2026-07-12T09:30:00Z",
  "error": null                // { code, message } on failure
}
```

Rules:
- Emit even on failure (set `error`, still record `latency_ms`). Failed turns are the most
  valuable eval data.
- `config_hash` must be identical across all hops of a run so metrics attribute to a
  specific configuration.
- Never put raw audio in the event — store the blob, reference it.

## Redpanda topics

| Topic | Producer | Consumer |
|-------|----------|----------|
| `svara.traces` | each hop activity | trace sink, online eval sampler |
| `svara.turns` | turn workflow (turn start/end summary) | dashboard live view |

Single partition is fine for local dev; key by `session_id` when you scale so a session's
events stay ordered.

## Postgres tables (Supabase)

```
traces        -- one row per hop event (flattened from svara.traces)
turns         -- one row per turn: session_id, turn_index, lang, total_latency_ms, ok
eval_runs     -- run_id, git_sha, config_hash, started_at, golden_set_version, notes
eval_scores   -- run_id, lang, hop, metric, value   (long/tidy format — easy to pivot)
```

`eval_scores` is intentionally tall (one row per metric per language per hop per run) so the
dashboard can pivot without schema changes when you add a metric.

## Golden-set record (`evals/golden/<lang>.jsonl`)

One JSON object per line:

```jsonc
{
  "id": "ta-IN-0007",
  "lang": "ta-IN",
  "audio_ref": "evals/golden/audio/ta-IN-0007.wav",
  "expected_transcript": "…",      // verbatim ground truth (built via saaras verbatim mode)
  "expected_intent": "check_status",
  "reference_translation": "…",    // English reference, when translation is scored
  "tags": ["code-mixed", "numbers"],// e.g. clean | code-mixed | noisy | numbers
  "consent": "synthetic"           // "synthetic" | "consented" — provenance required
}
```

Keep it small and high-signal (~20 per language) to start. When a real failure appears, add
it here as a permanent regression case — that's how the set earns its keep.

## Hop activity contract (Temporal)

Each hop activity is pure w.r.t. the workflow: takes typed input, returns typed output,
emits exactly one trace event as a side effect. Signatures live in `packages/shared`.

```
transcribe(audioStream, opts)  -> { text, lang, isFinal }[]   // streaming
respond(text, ctx, opts)       -> { tokenStream, ragContextIds }
synthesize(sentenceStream, opts) -> audioChunkStream
```

Per-hop timeouts and retry policy are set on the Temporal activity options, not inside the
activity body.
