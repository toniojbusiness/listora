/**
 * The trend read where a marketplace shows a visitor its sold listings (eBay's and Mercari's,
 * through the thrift scan's comparisons; docs/features/thrift-scan.md, "eBay" and "Mercari").
 * Apart from market.ts, which the phone runs, because it words what it rests on as sold data,
 * under the label guard's label. Where it has no numbers it never says "sold": an unknown read
 * may sit on a row of asking prices only, which the label guard holds to that.
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
    return { demand: 'unknown', basedOn: `${marketplace} gave no count of its sales` };
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

/**
 * Mercari's recent pace: of its latest sold results read (its sold search, newest first), the
 * share that sold within the window (30 days). Fast from two in three, slow at a quarter or
 * less: starting thresholds, to tune in the live test. Mercari's sold search reaches back years
 * and counts no window, so the latest sales' dates are what say how fast it sells now.
 */
export const LATEST_SOLD_FAST = 2 / 3;
export const LATEST_SOLD_SLOW = 0.25;
/** Fewest latest sold results a pace is read from. */
export const MIN_LATEST_SOLD = 5;

/**
 * The trend read from a marketplace's latest sales: `soldLately` of the `soldRead` latest sold
 * results sold in the last `windowDays`. Unknown without dates or with fewer than 5 read.
 */
export function latestSoldPace(
  soldLately: number | null,
  soldRead: number,
  windowDays: number,
  marketplace: string,
): MarketDemandRead {
  if (soldLately === null) {
    return { demand: 'unknown', basedOn: `${marketplace} gave no dates for its latest sales` };
  }
  if (soldRead < MIN_LATEST_SOLD) {
    return {
      demand: 'unknown',
      basedOn: `Too few of ${marketplace}'s latest sales to read a pace`,
    };
  }
  const lately = Math.min(soldLately, soldRead);
  const share = lately / soldRead;
  const demand: MarketDemand =
    share >= LATEST_SOLD_FAST ? 'strong' : share <= LATEST_SOLD_SLOW ? 'crowded' : 'steady';
  return {
    demand,
    ...(demand === 'strong'
      ? { label: `Sells fast on ${marketplace}` }
      : demand === 'crowded'
        ? { label: `Slow on ${marketplace}` }
        : {}),
    basedOn: `${marketSoldLabel(marketplace)}: ${String(lately)} of the latest ${String(soldRead)} sold in the last ${String(windowDays)} days`,
  };
}
