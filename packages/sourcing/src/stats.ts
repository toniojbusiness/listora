/**
 * A price range as the scan shows it: the low quartile, the median, and the high quartile of
 * real prices, never one price (docs/features/thrift-scan.md, "Wording").
 */
export interface PriceQuartiles {
  readonly count: number;
  readonly lowCents: number;
  readonly medianCents: number;
  readonly highCents: number;
}

/**
 * The quartiles of `prices` (whole cents, interpolated between neighbours and rounded), or
 * undefined when there are none. One price is its own range.
 */
export function quartiles(prices: readonly number[]): PriceQuartiles | undefined {
  for (const price of prices) {
    if (!Number.isSafeInteger(price) || price < 0) {
      throw new RangeError(`a price must be whole cents, got ${String(price)}`);
    }
  }
  if (prices.length === 0) return undefined;
  const sorted = [...prices].sort((a, b) => a - b);
  return {
    count: sorted.length,
    lowCents: quantile(sorted, 0.25),
    medianCents: quantile(sorted, 0.5),
    highCents: quantile(sorted, 0.75),
  };
}

/** The `q` quantile of sorted values, linear between the two nearest (R's type 7). */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const lower = sorted[below] ?? 0;
  const upper = sorted[Math.min(below + 1, sorted.length - 1)] ?? lower;
  return Math.round(lower + (upper - lower) * (position - below));
}

/** The median of whole-cent values, or undefined when there are none. */
export function medianCents(values: readonly number[]): number | undefined {
  return quartiles(values)?.medianCents;
}
