/**
 * The trend read where a marketplace shows a visitor its sold listings (eBay's, through the
 * thrift scan's comparisons; docs/features/thrift-scan.md, "eBay"). Apart from market.ts, which
 * the phone runs, because it words what it rests on as sold data, under the label guard's label.
 */
import { marketSoldLabel } from '@listora/pricing';

import type { MarketDemand, MarketDemandRead } from './market.ts';

/**
 * A search's sell-through on a marketplace that shows sold listings (eBay): how many it sold in
 * its sold window for each one for sale now. Fast from one (as many sold lately as are listed),
 * slow at a quarter or less: starting thresholds, to tune in the live test.
 */
export const SELL_THROUGH_FAST = 1;
export const SELL_THROUGH_SLOW = 0.25;

/**
 * The trend read on a marketplace that shows sold listings: its search's sold count over its
 * sold window (eBay's 90 days) against its count for sale now. Strong (sells fast) from a
 * sell-through of one, crowded (slow) at a quarter or less, steady between; unknown without
 * both counts.
 */
export function marketSoldPace(
  soldTotal: number | null,
  forSaleTotal: number | null,
  windowDays: number,
  marketplace: string,
): MarketDemandRead {
  if (soldTotal === null || forSaleTotal === null) {
    return { demand: 'unknown', basedOn: `${marketplace} gave no count of sold listings` };
  }
  const sellThrough = forSaleTotal === 0 ? Number.POSITIVE_INFINITY : soldTotal / forSaleTotal;
  const demand: MarketDemand =
    sellThrough >= SELL_THROUGH_FAST
      ? 'strong'
      : sellThrough <= SELL_THROUGH_SLOW
        ? 'crowded'
        : 'steady';
  const count = (value: number) => value.toLocaleString('en-US');
  return {
    demand,
    ...(demand === 'strong'
      ? { label: `Sells fast on ${marketplace}` }
      : demand === 'crowded'
        ? { label: `Slow on ${marketplace}` }
        : {}),
    basedOn: `${marketSoldLabel(marketplace)}: ${count(soldTotal)} in the last ${String(windowDays)} days; ${count(forSaleTotal)} for sale now`,
  };
}
