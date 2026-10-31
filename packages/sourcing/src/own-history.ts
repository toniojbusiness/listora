/**
 * The household's own sales of items like this one, per marketplace: the `own_history` sold
 * data the item's price screen shows (docs/features/thrift-scan.md). Pure: the API loads the
 * sales that count (standing, in the window, on marketplaces whose sales history is on for the
 * account) and this decides which are similar and what they add up to.
 */
import { knownMarketplaceValues, type KnownMarketplace } from '@listora/api-contract';

import { brandKey } from './keys.ts';
import { priceStats, type PriceStats } from './stats.ts';

/** Only sales from this many days back count: older prices say little about today's. */
export const OWN_HISTORY_WINDOW_DAYS = 365;
/**
 * A marketplace's similar sales show on an item only from this many: one sale is a price, not
 * a range.
 */
export const MIN_OWN_HISTORY_SALES = 2;

/** One item the household sold, as the sale recorded it. */
export interface OwnSale {
  readonly itemId: string;
  readonly marketplace: KnownMarketplace;
  readonly brand: string;
  /** The canonical category path, when the item has one. */
  readonly category: string | null;
  readonly sizeLabel: string | null;
  /** What the buyer paid for this item. */
  readonly salePriceCents: number;
}

/** The item whose similar sales are wanted. */
export interface OwnHistoryItem {
  readonly itemId: string;
  readonly brand: string | null;
  readonly category: string | null;
}

/** The similar sales on one marketplace. */
export interface MarketplaceOwnHistory {
  readonly marketplace: KnownMarketplace;
  readonly stats: PriceStats;
}

/**
 * Whether `sale` is of an item like `item`: the same brand (by `brandKey`), and the same
 * category when the item has one. An item without a brand has no similar sales: brand is what
 * moves a resale price most, and without it a match is noise. The item's own sale never counts.
 */
export function isSimilarSale(item: OwnHistoryItem, sale: OwnSale): boolean {
  const key = brandKey(item.brand);
  if (key === null || sale.itemId === item.itemId) return false;
  if (brandKey(sale.brand) !== key) return false;
  return item.category === null || sale.category === item.category;
}

/**
 * The item's similar sales per marketplace, in `KnownMarketplace` order (never ranked), each
 * with at least `MIN_OWN_HISTORY_SALES`.
 */
export function ownHistoryFor(
  item: OwnHistoryItem,
  sales: readonly OwnSale[],
): MarketplaceOwnHistory[] {
  const prices = new Map<KnownMarketplace, number[]>();
  for (const sale of sales) {
    if (!isSimilarSale(item, sale)) continue;
    const list = prices.get(sale.marketplace) ?? [];
    list.push(sale.salePriceCents);
    prices.set(sale.marketplace, list);
  }
  return knownMarketplaceValues.flatMap((marketplace) => {
    const stats = priceStats(prices.get(marketplace) ?? []);
    return stats !== undefined && stats.count >= MIN_OWN_HISTORY_SALES
      ? [{ marketplace, stats }]
      : [];
  });
}
