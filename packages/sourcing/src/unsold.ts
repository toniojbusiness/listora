import { brandKey } from './brand.ts';
import type { ScanIdentity } from './own-history.ts';

/** An item of the account in inventory and not sold (ready or listed). */
export interface UnsoldItem {
  readonly brand: string | null;
  readonly category: string | null;
  readonly sizeLabel: string | null;
}

/** How many of the household's unsold items are like the scanned one, and how alike. */
export interface UnsoldLikeIt {
  readonly count: number;
  /** The same brand and category, or (for a read without a category) the same brand. */
  readonly level: 'brand_and_category' | 'brand';
}

/**
 * The household's unsold items like the scanned one (docs/features/thrift-scan.md,
 * "Duplicates"): the same brand (`brandKey`) and category, or the same brand when the read has no
 * category. Undefined without a brand or with none like it: the card then says nothing.
 */
export function unsoldLikeIt(
  identity: ScanIdentity,
  unsold: readonly UnsoldItem[],
): UnsoldLikeIt | undefined {
  const brand = brandKey(identity.brand);
  if (brand === undefined) return undefined;
  const level = identity.category === null ? 'brand' : 'brand_and_category';
  const count = unsold.filter(
    (item) =>
      brandKey(item.brand) === brand &&
      (identity.category === null || item.category === identity.category),
  ).length;
  return count === 0 ? undefined : { count, level };
}
