import { knownMarketplaceValues, type KnownMarketplace } from '@listora/api-contract';

import { brandKey } from './brand.ts';
import { quartiles, type PriceQuartiles } from './stats.ts';

/** One of the seller's own sales, as the comparisons read it. */
export interface HistorySale {
  readonly id: string;
  readonly brand: string | null;
  /** The canonical category path, for example `clothing/bottoms/jeans`. */
  readonly category: string | null;
  /** What the buyer paid for the item. */
  readonly salePriceCents: number;
}

/** What the scan identified: the brand and the canonical category path, each null when unsure. */
export interface ScanIdentity {
  readonly brand: string | null;
  readonly category: string | null;
}

/** How closely the comparisons match the item, tightest first. */
export const MATCH_LEVELS = ['brand_and_category', 'brand', 'category'] as const;
export type MatchLevel = (typeof MATCH_LEVELS)[number];

/** Fewest sales a range rests on before a looser match is tried. */
export const MIN_COMPARISONS = 3;

export interface OwnHistoryComparisons {
  readonly level: MatchLevel;
  readonly saleIds: readonly string[];
  readonly prices: PriceQuartiles;
}

/**
 * The seller's own sales like the identified item: the tightest match level with at least
 * `minComparisons` sales, or, when no level has that many, the tightest with any (a thin
 * range, which the call trusts less). Undefined when nothing matches at all, including when
 * the identity has neither a brand nor a category.
 */
export function ownHistoryComparisons(
  identity: ScanIdentity,
  history: readonly HistorySale[],
  options: { readonly minComparisons?: number } = {},
): OwnHistoryComparisons | undefined {
  const minComparisons = options.minComparisons ?? MIN_COMPARISONS;
  const brand = brandKey(identity.brand);
  const category = identity.category;
  const matches: Record<MatchLevel, HistorySale[]> = {
    brand_and_category: [],
    brand: [],
    category: [],
  };
  for (const sale of history) {
    const sameBrand = brand !== undefined && brandKey(sale.brand) === brand;
    const sameCategory = category !== null && sale.category === category;
    if (sameBrand && sameCategory) matches.brand_and_category.push(sale);
    if (sameBrand) matches.brand.push(sale);
    if (sameCategory) matches.category.push(sale);
  }
  const level =
    MATCH_LEVELS.find((candidate) => matches[candidate].length >= minComparisons) ??
    MATCH_LEVELS.find((candidate) => matches[candidate].length > 0);
  if (level === undefined) return undefined;
  const sales = matches[level];
  const prices = quartiles(sales.map((sale) => sale.salePriceCents));
  if (prices === undefined) return undefined;
  return { level, saleIds: sales.map((sale) => sale.id), prices };
}

/** Only sales from this many days back count: older prices say little about today's. */
export const OWN_HISTORY_WINDOW_DAYS = 365;
/**
 * A marketplace's own sales show on an item's price screen only from this many matching ones:
 * one sale is a price, not a range.
 */
export const MIN_OWN_HISTORY_SALES = 2;

/** One item the household sold, as the price screen and the sourcing kit read it. */
export interface OwnSale extends HistorySale {
  /** The sold item; its own sale is never compared with it. */
  readonly itemId: string;
  readonly marketplace: KnownMarketplace;
  readonly sizeLabel: string | null;
}

/** The item whose own sales the price screen shows. */
export interface OwnHistoryItem extends ScanIdentity {
  readonly itemId: string;
}

/** The matching own sales on one marketplace. */
export interface MarketplaceOwnHistory {
  readonly marketplace: KnownMarketplace;
  /** `brand_and_category` or `brand`: the price screen names the brand, so never `category`. */
  readonly level: Exclude<MatchLevel, 'category'>;
  readonly prices: PriceQuartiles;
}

/**
 * The item price screen's own history (docs/features/thrift-scan.md, "On the item's price
 * screen"): per marketplace, in `KnownMarketplace` order (never ranked), the seller's own sales
 * like the item as `ownHistoryComparisons` matches them, at the tightest level with at least
 * `MIN_OWN_HISTORY_SALES`. Only a match on the item's brand shows, since the label names it, so
 * an item without a brand has none. The item's own sale never counts.
 */
export function ownHistoryByMarketplace(
  item: OwnHistoryItem,
  sales: readonly OwnSale[],
): MarketplaceOwnHistory[] {
  return knownMarketplaceValues.flatMap((marketplace) => {
    const found = ownHistoryComparisons(
      item,
      sales.filter((sale) => sale.marketplace === marketplace && sale.itemId !== item.itemId),
      { minComparisons: MIN_OWN_HISTORY_SALES },
    );
    if (found === undefined || found.level === 'category') return [];
    if (found.prices.count < MIN_OWN_HISTORY_SALES) return [];
    return [{ marketplace, level: found.level, prices: found.prices }];
  });
}
