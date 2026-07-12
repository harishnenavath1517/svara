import { MODELS, optionalEnv } from "@svara/shared";
import type { ChatMessage } from "@svara/shared";
import { authHeaders, SarvamError, type SarvamClientConfig } from "./config.js";

/**
 * Chat completions — POST {llmBaseUrl}/chat/completions, OpenAI-compatible.
 * `llmBaseUrl` defaults to Sarvam's own /v1 but points at LiteLLM in any
 * deployment that wants to swap the model out from under the hop.
 */
export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Let the model think before it answers. Off by default, and that default is
   * the single most important line in this file for the latency budget.
   *
   * sarvam-30b is a reasoning model. Its thinking tokens stream as
   * `reasoning_content` and are billed against `max_tokens` before one word of
   * the reply appears. Measured against a real scheme question:
   *
   *   thinking on  →  ~1100-1900 reasoning tokens, 4-7s to first word
   *   thinking off →  0 reasoning tokens, ~340ms to first word
   *
   * At `max_tokens: 512` with thinking on, the model never gets past its own
   * reasoning: it returns `finish_reason: "length"` and an EMPTY reply, with no
   * error anywhere. `reasoning_effort` does not prevent this — "low", "medium"
   * and "high" all reason at length, and there is no "none". Only the
   * `enable_thinking` chat-template flag, and only via `extra_body`, turns it
   * off. `chat_template_kwargs` at the top level is silently ignored.
   *
   * Turn this on for the eval judge (Phase 2), where the extra seconds buy
   * something. Never turn it on in the voice loop.
   */
  thinking?: boolean;
  signal: AbortSignal;
}

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

/** Yields content deltas. Feed them straight to `sentences()` — never buffer the reply. */
export async function* chat(
  messages: ChatMessage[],
  opts: ChatOptions,
  config: SarvamClientConfig,
): AsyncIterable<string> {
  const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? optionalEnv("LLM_MODEL", MODELS.llm),
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 512,
      ...(opts.thinking === true
        ? { reasoning_effort: "low" }
        : { extra_body: { chat_template_kwargs: { enable_thinking: false } } }),
    }),
    signal: opts.signal,
  });

  if (!response.ok || response.body === null) {
    throw new SarvamError(
      `llm_http_${response.status}`,
      `chat/completions failed: ${response.status} ${await response.text().catch(() => "")}`.trim(),
    );
  }

  for await (const event of sseEvents(response.body, opts.signal)) {
    if (event === "[DONE]") return;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(event) as ChatChunk;
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta != null && delta.length > 0) yield delta;
  }
}

/** Minimal SSE reader: yields the `data:` payload of each event, in order. */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    if (signal.aborted) return;
    buffer += decoder.decode(bytes, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
