/**
 * The trend read where a marketplace shows a visitor its sold listings (eBay's, Poshmark's, and
 * Mercari's, through the thrift scan's comparisons; docs/features/thrift-scan.md, "eBay",
 * "Poshmark", and "Mercari"). Apart from market.ts, which the phone runs, because it words what
 * it rests on as sold data, under the label guard's label. Where it has no numbers it never says
 * "sold": an unknown read may sit on a row of asking prices only, which the label guard holds to
 * that.
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
 * Close matches sold in 30 days that make "sells fast" on a marketplace that dates its sold
 * listings (Poshmark), and at most how many make "slow" while close matches are for sale:
 * starting thresholds, to tune in the live test.
 */
export const RECENT_SOLD_FAST = 8;
export const RECENT_SOLD_SLOW = 1;
/** The month the recent pace is counted over. */
export const RECENT_PACE_DAYS = 30;
/** Close matches for sale that make a slow pace "slow" rather than just few of them about. */
export const RECENT_SLOW_MIN_FOR_SALE = 3;

/** What the recent pace reads of one marketplace's comparisons. */
export interface RecentSoldInput {
  /** Close matches sold in the sold window, and how many days back the oldest of them sold. */
  readonly soldCount: number;
  readonly windowDays: number | null;
  /** Close matches for sale now, and the whole for-sale search's own count. */
  readonly forSaleCount: number;
  readonly forSaleTotal: number | null;
}

/**
 * The trend read on a marketplace that dates its sold listings but counts every sale it ever
 * had (Poshmark): how many close matches sold lately, per 30 days over the days they span (at
 * least 30, so a burst of a few days is never read as more). Strong (sells fast) from 8 a month,
 * crowded (slow) at one or none while at least 3 like it are for sale, steady otherwise. The
 * sold page shows 48 results, so a busy search's count is a floor: it can miss "fast", never
 * invent it.
 */
export function marketRecentSoldPace(
  input: RecentSoldInput,
  marketplace: string,
): MarketDemandRead {
  const span = Math.max(input.windowDays ?? RECENT_PACE_DAYS, RECENT_PACE_DAYS);
  const perMonth = (input.soldCount * RECENT_PACE_DAYS) / span;
  const demand: MarketDemand =
    perMonth >= RECENT_SOLD_FAST
      ? 'strong'
      : perMonth <= RECENT_SOLD_SLOW && input.forSaleCount >= RECENT_SLOW_MIN_FOR_SALE
        ? 'crowded'
        : 'steady';
  const sold =
    input.soldCount === 0
      ? `none like it in the last ${String(span)} days`
      : `${String(input.soldCount)} like it in the last ${String(span)} days`;
  const supply =
    input.forSaleTotal === null
      ? ''
      : `; ${input.forSaleTotal.toLocaleString('en-US')} for sale now`;
  return {
    demand,
    ...(demand === 'strong'
      ? { label: `Sells fast on ${marketplace}` }
      : demand === 'crowded'
        ? { label: `Slow on ${marketplace}` }
        : {}),
    basedOn: `${marketSoldLabel(marketplace)}: ${sold}${supply}`,
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
