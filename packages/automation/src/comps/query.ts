/**
 * What a comparison read searches for, built on the server from the scan's read
 * (docs/features/thrift-scan.md, "Marketplace comparisons"). A brand alone is never enough, so
 * there is no query without both a brand and an item type: the marketplace's own product types
 * for the item's category (in every department it may be, when the read could not tell), and the
 * words the type goes by.
 */
import { createHash } from 'node:crypto';

import { mapDepopCategory } from '../depop/categories.ts';
import type { ComparisonMarketplace, ComparisonQuery } from './types.ts';

/** What the scan read, as far as a comparison needs it. */
export interface ComparisonItem {
  readonly brand: string | null;
  /** "black high-rise straight jeans". */
  readonly item: string;
  /** The exact model or line ("501"). */
  readonly line: string | null;
  /** The canonical category path (`clothing/bottoms/jeans`). */
  readonly category: string | null;
  readonly department: string | null;
  readonly sizeLabel: string | null;
}

/** Departments tried when the read could not tell whose the item is. */
const ANY_DEPARTMENT = ['women', 'men'] as const;

/** Category words that name no item type ("other"). */
const VAGUE = new Set(['other', 'clothing']);

/** Each marketplace's own product types for a canonical category and department. */
const PRODUCT_TYPES: Readonly<
  Record<ComparisonMarketplace, (category: string, department: string | null) => string[]>
> = {
  depop: (category, department) => depopProductTypes(category, department),
  // eBay's results name no category: its listings are matched by their titles' words.
  ebay: () => [],
};

/** The query for one marketplace, or `null` without a brand or an item type. */
export function comparisonQuery(
  marketplace: ComparisonMarketplace,
  item: ComparisonItem,
): ComparisonQuery | null {
  const brand = item.brand?.trim() ?? '';
  if (brand === '' || item.category === null) return null;
  const productTypes = PRODUCT_TYPES[marketplace](item.category, item.department);
  const typeWords = typeWordsOf(item.category, item.item);
  if (productTypes.length === 0 && typeWords.length === 0) return null;
  const model = item.line?.trim() ?? '';
  const type = typeWords[0] ?? '';
  // As a buyer types it: "levis 501 jeans" (an apostrophe makes Depop's search much looser).
  const words = [brand, model, type]
    .filter((word) => word !== '')
    .join(' ')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const size = item.sizeLabel?.trim() ?? '';
  return {
    words,
    brand,
    model: model === '' ? null : model,
    sizeLabel: size === '' ? null : size,
    productTypes,
    typeWords,
  };
}

/**
 * The cache key of a query: the same item searched the same way, so a rack of one brand and
 * model costs one read.
 */
export function comparisonQueryKey(
  marketplace: ComparisonMarketplace,
  query: ComparisonQuery,
): string {
  const normal = {
    marketplace,
    words: query.words.toLowerCase().replace(/\s+/g, ' ').trim(),
    brand: query.brand.toLowerCase().trim(),
    model: query.model?.toLowerCase().trim() ?? null,
    size: query.sizeLabel?.toLowerCase().replace(/\s+/g, '') ?? null,
    types: [...query.productTypes].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex');
}

function depopProductTypes(category: string, department: string | null): string[] {
  const departments = department === null ? ANY_DEPARTMENT : [department];
  const types = new Set<string>();
  for (const one of departments) {
    const mapped = mapDepopCategory(category, one);
    if (mapped !== null) types.add(mapped.ids[2]);
  }
  return [...types];
}

/** The words the item type goes by: the category's own ("t_shirts" is "t shirts"), the item's noun. */
function typeWordsOf(category: string, item: string): string[] {
  const leaf = category.split('/').at(-1) ?? '';
  const words = new Set<string>();
  for (const part of leaf.split('_')) {
    if (part.length > 2 && !VAGUE.has(part)) words.add(part);
  }
  const noun = item
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .at(-1);
  if (noun !== undefined && noun.length > 2) words.add(noun);
  return [...words];
}
