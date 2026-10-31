/**
 * A sample of sale prices as a range: the lower quartile, the median, and the upper quartile,
 * never a single price. The quartiles are nearest-rank, so each is a price a buyer really paid;
 * only an even sample's median can fall between two.
 */

export interface PriceStats {
  readonly count: number;
  readonly lowCents: number;
  readonly medianCents: number;
  readonly highCents: number;
}

/** The stats of `cents`, or undefined for an empty sample. */
export function priceStats(cents: readonly number[]): PriceStats | undefined {
  if (cents.length === 0) return undefined;
  const sorted = [...cents].sort((a, b) => a - b);
  return {
    count: sorted.length,
    lowCents: nearestRank(sorted, 0.25),
    medianCents: median(sorted),
    highCents: nearestRank(sorted, 0.75),
  };
}

/** The median of a sorted, non-empty sample; an even one's two middle values averaged, rounded. */
export function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return Math.round(((sorted[middle - 1] ?? 0) + upper) / 2);
}

function nearestRank(sorted: readonly number[], quantile: number): number {
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1] ?? 0;
}
