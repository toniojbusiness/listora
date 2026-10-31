import type { CallBasis } from './call.ts';

/** One kept scan's call, as the run's estimate adds it up. */
export interface KeptScanCall {
  readonly basis: CallBasis;
  /** The range the call rests on, absent with nothing to go on. */
  readonly lowCents?: number;
  readonly highCents?: number;
  /** What the range's ends pay out after the marketplace's fees. */
  readonly conservativePayoutCents?: number;
  readonly optimisticPayoutCents?: number;
}

/** The kept items' estimated resale (docs/features/thrift-scan.md, "The run's summary"). */
export interface RunEstimate {
  /** The kept items with a range, which the sums cover. */
  readonly itemCount: number;
  readonly resaleLowCents: number;
  readonly resaleHighCents: number;
  readonly payoutLowCents: number;
  readonly payoutHighCents: number;
  /** How many of the ranges rest on each source. */
  readonly byBasis: Readonly<Record<Exclude<CallBasis, 'none'>, number>>;
  /** What the ranges rest on, as the seller reads it. */
  readonly basedOn: string;
  /** Shown with the numbers, always. */
  readonly label: string;
}

export const RUN_ESTIMATE_LABEL = 'Estimated';
export const RUN_ESTIMATE_AI_LABEL =
  'Estimated - includes the AI estimate, not based on sold listings';
export const RUN_PROFIT_LABEL = 'Estimated, after fees';

const BASIS_WORDS: Readonly<Record<Exclude<CallBasis, 'none'>, string>> = {
  own_history: 'from your own sales',
  market_sold: "from a marketplace's sold listings",
  web_info: 'from web info',
  ai_estimate: 'from the AI estimate',
};

/**
 * Adds up the kept scans' calls: the sums of their price ranges and of their payouts after fees.
 * A scan with nothing to go on (no range or no payout) is left out, so the estimate covers
 * `itemCount` of the kept items; undefined when none had a range. The order of the sources in
 * `basedOn` is the call's trust order: own sales, then a marketplace's sold listings (eBay's), then
 * web info, then the AI estimate.
 */
export function runEstimate(calls: readonly KeptScanCall[]): RunEstimate | undefined {
  const byBasis = { own_history: 0, market_sold: 0, web_info: 0, ai_estimate: 0 };
  let resaleLowCents = 0;
  let resaleHighCents = 0;
  let payoutLowCents = 0;
  let payoutHighCents = 0;
  let itemCount = 0;
  for (const call of calls) {
    if (
      call.basis === 'none' ||
      call.lowCents === undefined ||
      call.highCents === undefined ||
      call.conservativePayoutCents === undefined ||
      call.optimisticPayoutCents === undefined
    ) {
      continue;
    }
    itemCount += 1;
    byBasis[call.basis] += 1;
    resaleLowCents += call.lowCents;
    resaleHighCents += call.highCents;
    payoutLowCents += call.conservativePayoutCents;
    payoutHighCents += call.optimisticPayoutCents;
  }
  if (itemCount === 0) return undefined;
  const parts = (Object.keys(BASIS_WORDS) as (keyof typeof BASIS_WORDS)[])
    .filter((basis) => byBasis[basis] > 0)
    .map((basis) => `${String(byBasis[basis])} ${BASIS_WORDS[basis]}`);
  return {
    itemCount,
    resaleLowCents,
    resaleHighCents,
    payoutLowCents,
    payoutHighCents,
    byBasis,
    basedOn: parts.join(', '),
    label: byBasis.ai_estimate > 0 ? RUN_ESTIMATE_AI_LABEL : RUN_ESTIMATE_LABEL,
  };
}

/**
 * The haul's estimated profit: the kept items' estimated payout less what the whole haul cost.
 * Only with the haul's total, which is known at checkout, never before.
 */
export function runProfit(
  estimate: RunEstimate,
  haulTotalCents: number,
): { readonly lowCents: number; readonly highCents: number } {
  return {
    lowCents: estimate.payoutLowCents - haulTotalCents,
    highCents: estimate.payoutHighCents - haulTotalCents,
  };
}
