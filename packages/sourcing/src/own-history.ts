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
