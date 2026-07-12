import { chat, type SarvamClientConfig } from "@svara/sarvam";
import { MODELS, optionalEnv } from "@svara/shared";
import type { ChatMessage } from "@svara/shared";

/**
 * LLM-as-judge. Scores translation adequacy + fluency on a fixed 1-5 rubric and
 * **stores its reasoning**, because a score you cannot argue with is a score you
 * cannot act on.
 *
 * This is the one place in the project where thinking is deliberately ON.
 * `chat()` defaults to `thinking: false` because sarvam-30b's reasoning tokens
 * are billed against `max_tokens` and stream before any reply, which at 512
 * tokens means an empty answer and a dead voice loop (see packages/sarvam/chat.ts).
 * The judge is off the hot path: nobody is waiting on it, and the reasoning is
 * precisely what we are paying for. It also runs on the bigger model — grading is
 * a harder task than answering, and a judge that is weaker than the system it
 * grades is just an expensive random number generator.
 *
 * The judge is not trusted alone. Its score is reported next to chrF and the
 * correlation between them (metrics/agreement.ts); where they disagree is a
 * finding, not an error.
 */

export const JUDGE_RUBRIC_VERSION = "1";

export interface JudgeVerdict {
  /** 1-5. How much of the source meaning survived. */
  adequacy: number;
  /** 1-5. How natural the English reads. */
  fluency: number;
  /** Mean of the two, in [1,5]. What agreement is computed against. */
  score: number;
  /** Why. Persisted to eval_samples — the reason a number is arguable. */
  rationale: string;
}

/**
 * Two independent axes, scored separately and on purpose. A model that drops half
 * the sentence but writes beautiful English is *fluent and inadequate*, and a
 * single blended "quality" score would average that into a mediocre 3 and hide
 * the actual failure. Asking for them apart is what makes the judge diagnostic.
 */
const RUBRIC = `You are grading a machine translation of a spoken utterance from an Indian
government-scheme helpline. The caller speaks Hindi or Tamil, often mixing in English words.

You will be given the REFERENCE English translation (written by a human, authoritative) and
the CANDIDATE English translation (produced by a speech model).

Score two axes independently, each 1-5:

ADEQUACY — does the candidate preserve the meaning of the reference?
  5 = all meaning preserved, including numbers, scheme names, and the specific ask
  4 = meaning preserved, a minor detail softened or lost
  3 = the main intent survives but a material detail is wrong or missing
  2 = the intent is distorted; a caller acting on this would be misinformed
  1 = unrelated, empty, or contradicts the reference

FLUENCY — is the candidate natural, grammatical English?
  5 = fluent, idiomatic
  4 = minor awkwardness
  3 = understandable but clumsy
  2 = broken grammar, hard to read
  1 = not intelligible as English

Grade adequacy on MEANING, not wording. A different but faithful phrasing is a 5. Numbers,
dates, amounts and scheme names are meaning: getting "fifteenth of March" wrong is an
adequacy failure, not a fluency one.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"adequacy": <1-5>, "fluency": <1-5>, "rationale": "<one sentence, max 30 words>"}`;

interface RawVerdict {
  adequacy?: unknown;
  fluency?: unknown;
  rationale?: unknown;
}

export async function judgeTranslation(
  reference: string,
  candidate: string,
  config: SarvamClientConfig,
  signal: AbortSignal,
): Promise<JudgeVerdict> {
  // An empty candidate needs no model to grade. Spending a judge call — and, worse,
  // letting the model improvise a score for an empty string — buys nothing.
  if (candidate.trim().length === 0) {
    return {
      adequacy: 1,
      fluency: 1,
      score: 1,
      rationale: "Candidate translation was empty.",
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: RUBRIC },
    {
      role: "user",
      content: `REFERENCE: ${reference}\nCANDIDATE: ${candidate}`,
    },
  ];

  let raw = "";
  for await (const delta of chat(
    messages,
    {
      model: optionalEnv("JUDGE_MODEL", MODELS.judge),
      // ON, and the only place in this repo where that is true. See the note above.
      thinking: true,
      // Room for the reasoning AND the reply. Thinking tokens are billed against
      // this ceiling and stream first, so a judge budget sized like the voice
      // loop's (512) returns an empty verdict and no error at all.
      maxTokens: 4096,
      // The judge must be as close to deterministic as the API allows. A judge
      // that re-scores the same pair differently on a rerun manufactures
      // regressions that never happened.
      temperature: 0,
      signal,
    },
    config,
  )) {
    raw += delta;
  }

  return parseVerdict(raw);
}

/**
 * Models wrap JSON in prose and markdown fences no matter how firmly you ask them
 * not to. Extract the object rather than trusting the whole reply to parse.
 */
export function parseVerdict(raw: string): JudgeVerdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return unparseable(raw);
  }

  let parsed: RawVerdict;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as RawVerdict;
  } catch {
    return unparseable(raw);
  }

  const adequacy = clampScore(parsed.adequacy);
  const fluency = clampScore(parsed.fluency);
  if (adequacy === null || fluency === null) return unparseable(raw);

  return {
    adequacy,
    fluency,
    score: (adequacy + fluency) / 2,
    rationale:
      typeof parsed.rationale === "string" && parsed.rationale.length > 0
        ? parsed.rationale
        : "(no rationale given)",
  };
}

/**
 * A judge that failed to answer is NOT a translation that scored 1. Conflating
 * them would let an API hiccup masquerade as a quality regression — the exact
 * class of lie this harness exists to prevent. NaN propagates: it is dropped from
 * the aggregates and counted separately as a judge failure.
 */
function unparseable(raw: string): JudgeVerdict {
  return {
    adequacy: Number.NaN,
    fluency: Number.NaN,
    score: Number.NaN,
    rationale: `JUDGE_UNPARSEABLE: ${raw.slice(0, 200)}`,
  };
}

function clampScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}
