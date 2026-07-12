import { chat, type SarvamClientConfig } from "@svara/sarvam";
import { MODELS, optionalEnv } from "@svara/shared";
import type { ChatMessage } from "@svara/shared";
import { INTENTS, isIntent, type Intent } from "./golden.js";

/**
 * Intent classification and its confusion matrix.
 *
 * This is the metric that asks whether the agent *did the right thing*, which is
 * a different question from whether it said the right words. A turn can score a
 * beautiful WER and still route a grievance to the eligibility flow — the caller
 * gets a fluent, well-pronounced answer to a question they did not ask. No STT or
 * TTS metric in this harness would notice.
 *
 * Classified from the **transcript the STT hop actually produced**, not from the
 * golden text. That is deliberate: it measures the intent accuracy the live system
 * would really have, ASR errors included. Feeding it the perfect transcript would
 * measure a classifier we do not ship.
 */

export const INTENT_PROMPT_VERSION = "1";

const SYSTEM = `You classify a caller's utterance to an Indian government welfare-scheme
helpline into exactly one intent. The caller may speak Hindi, Tamil, or a mix with English.

The intents:
- check_eligibility — am I eligible / do I qualify / can I get this scheme
- check_status — what happened to my application / where is my money / when is my instalment
- how_to_apply — how do I apply / where do I apply / what is the process or deadline
- document_list — which documents / papers / cards do I need
- grievance — a complaint: money not received, no response, officials unhelpful

Distinguish check_status from grievance by what the caller wants: asking where the money is
is check_status; complaining that it never came and demanding action is grievance.

Reply with ONLY the intent name, lowercase, nothing else.`;

export interface IntentPrediction {
  predicted: Intent | null;
  raw: string;
}

export async function classifyIntent(
  transcript: string,
  config: SarvamClientConfig,
  signal: AbortSignal,
): Promise<IntentPrediction> {
  if (transcript.trim().length === 0) return { predicted: null, raw: "" };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: transcript },
  ];

  let raw = "";
  for await (const delta of chat(
    messages,
    {
      // The classifier deliberately runs on the *serving* model, not the judge:
      // it is standing in for a routing decision the live agent would make, so it
      // should be as good as the live agent, not better.
      model: optionalEnv("LLM_MODEL", MODELS.llm),
      // Off. A one-word classification does not need reasoning, and thinking
      // tokens would eat the whole budget before the word arrived.
      thinking: false,
      maxTokens: 32,
      temperature: 0,
      signal,
    },
    config,
  )) {
    raw += delta;
  }

  return { predicted: extractIntent(raw), raw: raw.trim() };
}

/** Models add punctuation, quotes, and explanation however firmly you forbid it. */
export function extractIntent(raw: string): Intent | null {
  const cleaned = raw.toLowerCase().replace(/[^a-z_]/gu, " ");
  for (const intent of INTENTS) {
    // Word-boundary match: `check_status` must not match inside a longer token.
    if (new RegExp(`\\b${intent}\\b`, "u").test(cleaned)) return intent;
  }
  const first = cleaned.trim().split(/\s+/u)[0] ?? "";
  return isIntent(first) ? first : null;
}

export interface ConfusionMatrix {
  /** matrix[expected][predicted] = count. `null` predictions land in `unclassified`. */
  matrix: Record<Intent, Record<Intent, number>>;
  unclassified: Record<Intent, number>;
  correct: number;
  total: number;
  accuracy: number;
}

export function emptyConfusion(): ConfusionMatrix {
  const matrix = {} as Record<Intent, Record<Intent, number>>;
  const unclassified = {} as Record<Intent, number>;
  for (const expected of INTENTS) {
    unclassified[expected] = 0;
    matrix[expected] = {} as Record<Intent, number>;
    for (const predicted of INTENTS) matrix[expected][predicted] = 0;
  }
  return { matrix, unclassified, correct: 0, total: 0, accuracy: 0 };
}

export function addToConfusion(
  confusion: ConfusionMatrix,
  expected: Intent,
  predicted: Intent | null,
): void {
  confusion.total += 1;
  if (predicted === null) {
    // A refusal to classify is not a wrong class — it is a missing answer, and
    // burying it in the diagonal's off-cells would make the matrix lie about
    // *which* intents the model confuses.
    confusion.unclassified[expected] += 1;
  } else {
    confusion.matrix[expected][predicted] += 1;
    if (expected === predicted) confusion.correct += 1;
  }
  confusion.accuracy = confusion.total === 0 ? 0 : confusion.correct / confusion.total;
}

/** Renders the matrix for the CLI. Rows are truth, columns are prediction. */
export function formatConfusion(confusion: ConfusionMatrix): string {
  const short = (intent: string): string =>
    intent
      .split("_")
      .map((part) => part.slice(0, 4))
      .join(".");

  const header = ["expected \\ predicted".padEnd(22), ...INTENTS.map((i) => short(i).padStart(10)), "  ?"].join("");
  const rows = INTENTS.map((expected) => {
    const cells = INTENTS.map((predicted) => {
      const n = confusion.matrix[expected][predicted];
      return (n === 0 ? "." : String(n)).padStart(10);
    });
    const missing = confusion.unclassified[expected];
    return [expected.padEnd(22), ...cells, `  ${missing === 0 ? "." : String(missing)}`].join("");
  });
  return [header, ...rows].join("\n");
}
