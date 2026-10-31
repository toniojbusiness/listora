/**
 * Sourcing insights, "What sells for you" (docs/features/thrift-scan.md, "Sourcing insights"):
 * the household's own sales and stock read as advice. The brand and item type pairs that sell
 * best and worst, by sell-through and days to sell, and the short "Look for" list for the bins.
 * Always a brand with a category, never a brand alone: a brand's leggings and its jackets sell
 * differently. Pure: the API loads the sales that count and the stock.
 */
import type {
  KnownMarketplace,
  SourcingInsightGroup,
  SourcingInsights,
} from '@listora/api-contract';
import { OWN_SALES_MAY_MODEL_PRICES } from '@listora/pricing';

import { brandKey } from './brand.ts';
import { DEFAULT_SCAN_CALL_SETTINGS, type ScanCallSettings } from './call.ts';
import type { OwnSale } from './own-history.ts';
import { medianCents } from './stats.ts';
import type { UnsoldItem } from './unsold.ts';

/** A pair needs this many items, sold or given time to sell, before it is judged. */
export const INSIGHT_MIN_ITEMS = 3;
/** The best sell at least this share (basis points): half or more of them sold. */
export const INSIGHT_GOOD_SELL_THROUGH_BP = 5000;
/** A median of this many days or more to sell is slow, whatever the sell-through. */
export const INSIGHT_SLOW_DAYS = 90;
/** An unsold item counts against its pair only once it had this many days to sell. */
export const INSIGHT_UNSOLD_MIN_AGE_DAYS = 30;
/** A median day count rests on at least this many sales with a known listing date. */
export const INSIGHT_MIN_DAYS_SALES = 2;
/** Each list's length (`SourcingInsights` `maxItems`). */
export const INSIGHT_LIST_LENGTH = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BRAND_LENGTH = 120;

export interface SourcingInsightsInput {
  /** The sales that count: standing, from the window, on marketplaces whose history is on. */
  readonly sales: readonly OwnSale[];
  /** The account's items in stock (ready or listed). */
  readonly unsold: readonly UnsoldItem[];
  readonly now: Date;
  /** A marketplace's estimated fees for one item at a price, as the scan's call works them. */
  readonly fees: (marketplace: KnownMarketplace) => (priceCents: number) => number;
  readonly settings?: ScanCallSettings | undefined;
}

interface Pair {
  readonly brandKey: string;
  readonly category: string;
  readonly spellings: Map<string, number>;
  soldCount: number;
  unsoldCount: number;
  inStockCount: number;
  readonly days: number[];
  readonly payouts: number[];
}

export function buildSourcingInsights(input: SourcingInsightsInput): SourcingInsights {
  const pairs = new Map<string, Pair>();
  const pairOf = (brand: string | null, category: string | null): Pair | undefined => {
    const key = brandKey(brand);
    if (key === undefined || brand === null || category === null) return undefined;
    const id = `${key}\u0000${category}`;
    const pair = pairs.get(id) ?? {
      brandKey: key,
      category,
      spellings: new Map<string, number>(),
      soldCount: 0,
      unsoldCount: 0,
      inStockCount: 0,
      days: [],
      payouts: [],
    };
    pairs.set(id, pair);
    const spelling = brand.trim().replace(/\s+/g, ' ').slice(0, MAX_BRAND_LENGTH);
    pair.spellings.set(spelling, (pair.spellings.get(spelling) ?? 0) + 1);
    return pair;
  };

  let soldCount = 0;
  let daysToSellCount = 0;
  for (const sale of input.sales) {
    const pair = pairOf(sale.brand, sale.category);
    if (pair === undefined) continue;
    soldCount += 1;
    pair.soldCount += 1;
    const days = daysToSell(sale);
    if (days !== undefined) {
      daysToSellCount += 1;
      pair.days.push(days);
    }
    if (OWN_SALES_MAY_MODEL_PRICES[sale.marketplace]) {
      const fee = input.fees(sale.marketplace)(sale.salePriceCents);
      pair.payouts.push(Math.max(0, sale.salePriceCents - fee));
    }
  }

  const givenTime = input.now.getTime() - INSIGHT_UNSOLD_MIN_AGE_DAYS * DAY_MS;
  for (const item of input.unsold) {
    const pair = pairOf(item.brand, item.category);
    if (pair === undefined) continue;
    pair.inStockCount += 1;
    // An item of unknown age counts as given time: the stock is the household's to judge.
    if (item.addedAt === undefined || item.addedAt.getTime() <= givenTime) pair.unsoldCount += 1;
  }

  const groups = [...pairs.values()]
    .filter((pair) => pair.soldCount + pair.unsoldCount >= INSIGHT_MIN_ITEMS)
    .map(groupView);
  const isBest = (group: SourcingInsightGroup) =>
    group.sellThroughBasisPoints >= INSIGHT_GOOD_SELL_THROUGH_BP &&
    (group.medianDaysToSell === undefined || group.medianDaysToSell < INSIGHT_SLOW_DAYS);
  const best = groups.filter(isBest).sort(bestFirst);
  const worst = groups.filter((group) => !isBest(group)).sort(worstFirst);
  const worthListingCents = (input.settings ?? DEFAULT_SCAN_CALL_SETTINGS).worthListingCents;

  return {
    soldCount,
    daysToSellCount,
    lookFor: best
      .filter((group) => (group.medianPayout?.amountCents ?? 0) >= worthListingCents)
      .slice(0, INSIGHT_LIST_LENGTH),
    best: best.slice(0, INSIGHT_LIST_LENGTH),
    worst: worst.slice(0, INSIGHT_LIST_LENGTH),
  };
}

/**
 * Whole days from the item's first listing through Listora to its sale; undefined without one
 * (an imported listing's date is when Listora read it, so the loader never sends it).
 */
function daysToSell(sale: OwnSale): number | undefined {
  const { listedAt, soldAt } = sale;
  if (listedAt === null || listedAt === undefined || soldAt === undefined) return undefined;
  return Math.max(0, Math.floor((soldAt.getTime() - listedAt.getTime()) / DAY_MS));
}

function groupView(pair: Pair): SourcingInsightGroup {
  const judged = pair.soldCount + pair.unsoldCount;
  const days = pair.days.length >= INSIGHT_MIN_DAYS_SALES ? medianCents(pair.days) : undefined;
  const payout = medianCents(pair.payouts);
  return {
    brand: mostCommon(pair.spellings) ?? pair.brandKey,
    brandKey: pair.brandKey,
    category: pair.category,
    soldCount: pair.soldCount,
    unsoldCount: pair.unsoldCount,
    inStockCount: pair.inStockCount,
    sellThroughBasisPoints: Math.round((pair.soldCount * 10000) / judged),
    ...(days === undefined ? {} : { medianDaysToSell: days }),
    ...(payout === undefined ? {} : { medianPayout: { amountCents: payout, currency: 'USD' } }),
  };
}

/** The highest sell-through first, then the fastest (a known day count first), then most sold. */
function bestFirst(a: SourcingInsightGroup, b: SourcingInsightGroup): number {
  return (
    b.sellThroughBasisPoints - a.sellThroughBasisPoints ||
    (a.medianDaysToSell ?? Infinity) - (b.medianDaysToSell ?? Infinity) ||
    b.soldCount - a.soldCount ||
    tieBreak(a, b)
  );
}

/** The lowest sell-through first, then the slowest, then the most left unsold. */
function worstFirst(a: SourcingInsightGroup, b: SourcingInsightGroup): number {
  return (
    a.sellThroughBasisPoints - b.sellThroughBasisPoints ||
    (b.medianDaysToSell ?? -1) - (a.medianDaysToSell ?? -1) ||
    b.unsoldCount - a.unsoldCount ||
    tieBreak(a, b)
  );
}

function tieBreak(a: SourcingInsightGroup, b: SourcingInsightGroup): number {
  return compare(a.brandKey, b.brandKey) || compare(a.category, b.category);
}

/** The spelling most items use; a tie goes to the one that sorts first, so it is stable. */
function mostCommon(counts: ReadonlyMap<string, number>): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of counts) {
    if (!best || entry[1] > best[1] || (entry[1] === best[1] && compare(entry[0], best[0]) < 0)) {
      best = entry;
    }
  }
  return best?.[0];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
