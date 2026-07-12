import { HOPS, SPEECH_LANGUAGES } from "@svara/shared";
import type { Hop, LanguageCode } from "@svara/shared";

/**
 * Golden-set loader, scorers (WER/CER, chrF, COMET, LLM-judge, latency), and
 * the run/diff machinery. Built in Phase 2 — this is the differentiator, see
 * docs/EVAL_STRATEGY.md.
 */

/** One row of `eval_scores`: tall/tidy, so a new metric needs no schema change. */
export interface EvalScore {
  run_id: string;
  lang: LanguageCode;
  hop: Hop;
  metric: string;
  value: number;
}

export interface EvalRun {
  run_id: string;
  git_sha: string;
  config_hash: string;
  started_at: string;
  golden_set_version: string;
  notes: string | null;
}

export const SCORED_HOPS: readonly Hop[] = HOPS;
export const SCORED_LANGUAGES: readonly LanguageCode[] = SPEECH_LANGUAGES;
