import type { EvalSampleRow } from "@svara/db";
import { formatValue, pick, type ScoreIndex } from "../lib/format";

/**
 * The translation/judge panel, built around one rule: **never print a judge score
 * without its `n` and its agreement with the automatic metric.**
 *
 * On the baseline run the judge scored 19 of 20 Hindi records a flat 5.0. A mean
 * of 4.95 rendered on its own is a number that cannot fall no matter how far the
 * model degrades — it is saturated, it has no variance to correlate with, and the
 * chrF↔judge Spearman of 0.141 is telling you exactly that. It is *not* evidence
 * of quality, and a dashboard that shows it as a big green figure is selling
 * something it does not have.
 *
 * So this panel does three things a naive one would not:
 *  - it prints `n` next to every judge mean;
 *  - it prints the chrF↔judge agreement, and prints "not computed" rather than a
 *    blank when it is null (a missing correlation is a fact, not an empty cell);
 *  - it reads the per-record judge scores back out of `eval_samples` and says out
 *    loud when the distribution is saturated.
 */

/** A judge whose modal score covers this much of the set has stopped discriminating. */
const SATURATION_FRACTION = 0.9;

/** Below this, chrF and the judge are not agreeing about what "good" means. */
const WEAK_AGREEMENT = 0.3;

interface Saturation {
  saturated: boolean;
  modal: number;
  modalCount: number;
  total: number;
  distinct: number;
}

/** Reads the judge's actual score distribution — not its mean. */
function saturation(samples: EvalSampleRow[]): Saturation | null {
  const values = samples
    .filter((s) => s.metric === "judge" && s.value !== null)
    .map((s) => s.value as number);
  if (values.length === 0) return null;

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  let modal = values[0] as number;
  let modalCount = 0;
  for (const [value, count] of counts) {
    if (count > modalCount) {
      modal = value;
      modalCount = count;
    }
  }

  return {
    saturated: modalCount / values.length >= SATURATION_FRACTION,
    modal,
    modalCount,
    total: values.length,
    distinct: counts.size,
  };
}

export function JudgePanel({
  index,
  samples,
  lang,
}: {
  index: ScoreIndex;
  samples: EvalSampleRow[];
  lang: string;
}) {
  const chrf = pick(index, lang, "llm", "chrf");
  const adequacy = pick(index, lang, "llm", "judge_adequacy");
  const fluency = pick(index, lang, "llm", "judge_fluency");
  const unparseable = pick(index, lang, "llm", "judge_unparseable_rate");
  const spearman = pick(index, lang, "llm", "chrf_judge_spearman");
  const pearson = pick(index, lang, "llm", "chrf_judge_pearson");
  const intent = pick(index, lang, "llm", "intent_accuracy");

  if (chrf === undefined && adequacy === undefined) return null;

  const sat = saturation(samples.filter((s) => s.lang === lang));
  const weak = spearman !== undefined && Math.abs(spearman.value) < WEAK_AGREEMENT;

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Translation &amp; understanding — {lang}</h3>
        <p className="note">
          Metric <em>and</em> judge, never judge alone — and their agreement, because knowing
          where they disagree is the point.
        </p>
      </div>

      <div className="stat-row">
        <Stat label="chrF" value={formatValue("chrf", chrf?.value ?? null)} n={chrf?.n} />
        <Stat
          label="judge — adequacy"
          value={formatValue("judge_adequacy", adequacy?.value ?? null)}
          n={adequacy?.n}
        />
        <Stat
          label="judge — fluency"
          value={formatValue("judge_fluency", fluency?.value ?? null)}
          n={fluency?.n}
        />
        <Stat
          label="intent accuracy"
          value={formatValue("intent_accuracy", intent?.value ?? null)}
          n={intent?.n}
        />
      </div>

      <div className="stat-row">
        <Stat
          label="chrF ↔ judge (Spearman)"
          // A null correlation is a fact — "not computed, fewer than 3 paired
          // records" — and it must never render as a blank cell that reads as zero.
          value={spearman === undefined ? "not computed" : spearman.value.toFixed(3)}
          n={spearman?.n}
          muted={spearman === undefined}
        />
        <Stat
          label="chrF ↔ judge (Pearson)"
          value={pearson === undefined ? "not computed" : pearson.value.toFixed(3)}
          n={pearson?.n}
          muted={pearson === undefined}
        />
        <Stat
          label="judge unparseable"
          value={formatValue("rate", unparseable?.value ?? null)}
          n={unparseable?.n}
          // Counted separately and never scored as a 1: an API hiccup must not be
          // able to masquerade as a quality regression.
          bad={unparseable !== undefined && unparseable.value > 0}
        />
      </div>

      {sat?.saturated === true && (
        <p className="finding">
          <strong>The judge is saturated here and cannot gate anything.</strong> {sat.modalCount} of{" "}
          {sat.total} records scored a flat {sat.modal.toFixed(1)} ({sat.distinct} distinct value
          {sat.distinct === 1 ? "" : "s"} across the whole set). The mean above is not evidence of
          quality — it is a number with no variance, and it cannot fall no matter how far the model
          degrades. Trust chrF on this language.
        </p>
      )}

      {weak && sat?.saturated !== true && (
        <p className="finding">
          chrF and the judge agree only weakly here (ρ ={" "}
          {(spearman?.value ?? 0).toFixed(3)}). That is a finding, not a failure: the records where
          they diverge are the ones worth reading.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  n,
  muted = false,
  bad = false,
}: {
  label: string;
  value: string;
  n?: number;
  muted?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`stat-value ${muted ? "muted" : ""} ${bad ? "over-budget" : ""}`}>{value}</div>
      {/* n is not decoration. A mean without its sample size is a claim without evidence. */}
      <div className="stat-n">{n === undefined ? "n = —" : `n = ${n}`}</div>
    </div>
  );
}
