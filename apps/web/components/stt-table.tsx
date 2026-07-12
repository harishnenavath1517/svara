import type { EvalScoreRow } from "@svara/db";
import { formatValue, pick, slicesIn, type ScoreIndex } from "../lib/format";

/**
 * The STT table — and the one component in this dashboard that has a *correctness*
 * requirement, not just a design one.
 *
 * **`wer` and `wer_romanized` are rendered side by side, always.** Rendering `wer`
 * alone for the code-mixed slice would make this page actively harmful. Saaras
 * hears "Aadhaar card" perfectly and writes it in Devanagari; token WER against a
 * Latin-script reference counts all four loanwords as substitutions. On the
 * baseline run that reads 0.234 script-sensitive and 0.021 script-invariant — the
 * *worst* slice and the *best* slice, from the same audio, from a transcription
 * with zero recognition errors. A reader shown only the first column goes off to
 * fix a model that works.
 *
 * So the gap between the two columns gets its own column, because the gap **is**
 * the finding (docs/EVAL_STRATEGY.md §1).
 */

/** Where the two columns diverge enough that the script effect is the story. */
const NOTABLE_GAP = 0.1;

export function SttTable({
  rows,
  index,
  lang,
}: {
  rows: EvalScoreRow[];
  index: ScoreIndex;
  lang: string;
}) {
  const slices = slicesIn(rows, "stt", "wer");
  if (slices.length === 0) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>STT — {lang}</h3>
        <p className="note">
          <code>wer</code> is the production <code>codemix</code> mode against the native-script
          reference — script choice and all. <code>wer_romanized</code> is <code>translit</code>{" "}
          mode against a hand-authored romanization: pure recognition error. Read them together.
          The gap is the script effect, not a model error.
        </p>
      </div>

      <table>
        <thead>
          <tr>
            <th>slice</th>
            <th className="num">wer</th>
            <th className="num">wer_romanized</th>
            <th className="num">gap</th>
            <th className="num">cer</th>
            <th className="num">empty</th>
            <th className="num">n</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((slice) => {
            const wer = pick(index, lang, "stt", "wer", slice);
            const rom = pick(index, lang, "stt", "wer_romanized", slice);
            const cer = pick(index, lang, "stt", "cer", slice);
            const empty = pick(index, lang, "stt", "empty_transcript_rate", slice);

            const gap =
              wer !== undefined && rom !== undefined ? wer.value - rom.value : null;
            const notable = gap !== null && Math.abs(gap) >= NOTABLE_GAP;

            return (
              <tr key={slice} className={slice === "all" ? "row-all" : ""}>
                <td>
                  {slice}
                  {slice === "code-mixed" && <span className="tag">the interesting cell</span>}
                </td>
                <td className="num">{formatValue("wer", wer?.value ?? null)}</td>
                <td className="num">{formatValue("wer", rom?.value ?? null)}</td>
                <td className={`num ${notable ? "gap-notable" : "muted"}`}>
                  {gap === null ? "—" : gap.toFixed(3)}
                </td>
                <td className="num muted">{formatValue("cer", cer?.value ?? null)}</td>
                <td className="num muted">{formatValue("rate", empty?.value ?? null)}</td>
                <td className="num muted">{wer?.n ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {slices.some((slice) => {
        const wer = pick(index, lang, "stt", "wer", slice);
        const rom = pick(index, lang, "stt", "wer_romanized", slice);
        return wer !== undefined && rom !== undefined && wer.value - rom.value >= NOTABLE_GAP;
      }) && (
        <p className="finding">
          A slice above scores much worse script-sensitive than script-invariant. That is Saaras
          writing loanwords in the native script, not Saaras mishearing them. Do not &ldquo;fix&rdquo;
          this model.
        </p>
      )}
    </div>
  );
}
