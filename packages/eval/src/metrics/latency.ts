/**
 * Latency percentiles.
 *
 * For a voice agent, **TTFB is the number that matters** and mean is the number
 * that lies. A TTS hop that streams for 6 seconds but starts speaking in 500ms is
 * a good turn; one that takes 800ms total but says nothing for 700ms of it is a
 * dead call. The harness reports both, and leads with TTFB.
 */

export interface Percentiles {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
}

export const EMPTY_PERCENTILES: Percentiles = {
  n: 0,
  p50: null,
  p95: null,
  p99: null,
  min: null,
  max: null,
};

/**
 * Nulls are dropped, not coerced to zero. A hop with no TTFB (it never produced a
 * first byte) is *missing* a measurement, not fast — and counting it as 0ms would
 * make a broken hop look like the best-performing one in the table.
 */
export function percentiles(values: Array<number | null | undefined>): Percentiles {
  const sorted = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);

  if (sorted.length === 0) return { ...EMPTY_PERCENTILES };

  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * Linear interpolation between the two straddling ranks — the same definition as
 * Postgres's `percentile_cont`, so the offline eval's numbers and the dashboard's
 * live-trace numbers are computed identically and can be put on one chart without
 * anyone having to ask which kind of p95 they're looking at.
 */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;

  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;

  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * weight;
}
