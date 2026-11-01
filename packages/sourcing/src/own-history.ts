import { knownMarketplaceValues, type KnownMarketplace } from '@listora/api-contract';
import { OWN_SALES_MAY_MODEL_PRICES } from '@listora/pricing';

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
  /** When it sold, for the trend; absent where unknown. */
  readonly soldAt?: Date | undefined;
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
  /**
   * When the item was first listed through Listora, before it sold: the start of its days to
   * sell. Absent when it never was (an imported listing's date is when Listora read it).
   */
  readonly listedAt?: Date | null | undefined;
}

/** The item whose own sales the price screen shows; a scanned item has no id yet. */
export interface OwnHistoryItem extends ScanIdentity {
  readonly itemId?: string | undefined;
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

/** The thrift scan's own history of the scanned item. */
export interface ScanOwnHistory {
  /**
   * The sales the call rests on: `ownHistoryComparisons` over every marketplace whose own
   * sales may model a price (`OWN_SALES_MAY_MODEL_PRICES`: not eBay's).
   */
  readonly forCall: OwnHistoryComparisons | undefined;
  /**
   * Whose fees the payouts are after: the marketplace with the most of `forCall`'s sales, ties
   * and no sales going to Depop (the scan's AI estimate is a Depop price), then the rest in
   * `KnownMarketplace` order.
   */
  readonly payoutMarketplace: KnownMarketplace;
  /** The card's lines: `ownHistoryByMarketplace` (eBay's shown, never feeding the call). */
  readonly byMarketplace: readonly MarketplaceOwnHistory[];
}

const PAYOUT_ORDER: readonly KnownMarketplace[] = [
  'depop',
  ...knownMarketplaceValues.filter((marketplace) => marketplace !== 'depop'),
];

/**
 * Whose fees a call's payouts are after: the marketplace with the most of its sales, ties and no
 * sales going to Depop (the scan's AI estimate is a Depop price), then the rest in
 * `KnownMarketplace` order.
 */
export function payoutMarketplaceOf(
  counts: ReadonlyMap<KnownMarketplace, number>,
): KnownMarketplace {
  let payoutMarketplace: KnownMarketplace = 'depop';
  for (const marketplace of PAYOUT_ORDER) {
    if ((counts.get(marketplace) ?? 0) > (counts.get(payoutMarketplace) ?? 0)) {
      payoutMarketplace = marketplace;
    }
  }
  return payoutMarketplace;
}

/** The scanned item's own history (docs/features/thrift-scan.md, "The scan"). */
export function scanOwnHistory(identity: ScanIdentity, sales: readonly OwnSale[]): ScanOwnHistory {
  const modelable = sales.filter((sale) => OWN_SALES_MAY_MODEL_PRICES[sale.marketplace]);
  const forCall = ownHistoryComparisons(identity, modelable);
  const counts = new Map<KnownMarketplace, number>();
  const matched = new Set(forCall?.saleIds ?? []);
  for (const sale of modelable) {
    if (matched.has(sale.id)) counts.set(sale.marketplace, (counts.get(sale.marketplace) ?? 0) + 1);
  }
  return {
    forCall,
    payoutMarketplace: payoutMarketplaceOf(counts),
    byMarketplace: ownHistoryByMarketplace(
      { brand: identity.brand, category: identity.category },
      sales,
    ),
  };
}

/** What identifies an item's exact model for its web research. */
export interface ResearchItem {
  readonly brand: string | null;
  readonly category: string | null;
  /** The exact model or line ("501"), its printed style number, and its era ("vintage 1990s"). */
  readonly line: string | null;
  readonly styleNumber: string | null;
  readonly era: string | null;
}

/**
 * What an item's web facts (its retail price, what it resells for) are cached by
 * (docs/features/thrift-scan.md, "Web info"): the brand's match key, the item type (category),
 * the exact model or line, the style number, and the era, each lowercased without punctuation.
 * One brand makes many models in every category (a Levi's 501 is not a 505), so without a model
 * or a style number there is no key: such an item is looked up afresh every time.
 */
export function itemResearchKey(item: ResearchItem): string | undefined {
  const brand = brandKey(item.brand);
  if (brand === undefined) return undefined;
  const words = (text: string | null) =>
    (text ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '')
      .join(' ');
  const model = words(item.line);
  const styleNumber = words(item.styleNumber);
  if (model === '' && styleNumber === '') return undefined;
  return [brand, item.category ?? '', model, styleNumber, words(item.era)].join('|').slice(0, 400);
}

/** What a brand's web facts (how well it resells) are cached by: the brand's match key alone. */
export function brandResearchKey(brand: string | null): string | undefined {
  return brandKey(brand);
}
