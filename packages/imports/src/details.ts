/**
 * The item a listing an import read becomes (docs/features/imports.md): its details from the
 * listing as the marketplace shows it, in Listora's terms where Listora's vocabulary has them
 * (the canonical category and department from the marketplace's category, the condition), so
 * the item lists on the other marketplaces through the same pre-fill and mappings as any item.
 * Pure: no I/O.
 */
import { CATEGORY_TREE } from '@listora/analysis';
import { importedCategory, splitSkuLine } from '@listora/automation';
import type { Marketplace } from '@listora/db';
import type { ItemCondition, ListedListing } from '@listora/marketplaces';
import { splitDepopDescription } from '@listora/shared';

/** The longest title an imported item gets (eBay's, Poshmark's, and Mercari's limit). */
export const IMPORTED_TITLE_LIMIT = 80;

/** A hashtag in a line of text (`#retro`, not `#1`), with the space before it. */
const HASHTAG = /(^|\s)#\p{L}[^\s#]*/gu;

/** Listora's canonical categories: every `<category>/<subcategory>`. */
const CANONICAL_PATHS: readonly string[] = Object.entries(CATEGORY_TREE).flatMap(
  ([category, subcategories]) => subcategories.map((subcategory) => `${category}/${subcategory}`),
);

/** An imported item's details and where they came from. */
export interface ImportedItem {
  title: string | null;
  description: string | null;
  brand: string | null;
  category: string | null;
  department: string | null;
  sizeLabel: string | null;
  sizeSystem: string | null;
  condition: ItemCondition | null;
  colors: string[];
  /** The listing's price before a markdown, so the item never lists elsewhere at a sale price. */
  listPriceCents: number | null;
  /** The detail fields set from the listing (their provenance is `marketplace`). */
  fromListing: string[];
}

/** The listing's own columns on its marketplace (`marketplace_listing`). */
export interface ImportedListingColumns {
  title: string | null;
  description: string | null;
  priceCents: number | null;
  categoryRef: string | null;
  condition: ItemCondition | null;
  sku: string | null;
}

export function importedItem(marketplace: Marketplace, listing: ListedListing): ImportedItem {
  const description = listingDescription(marketplace, listing);
  const own = listing.title?.trim() ?? '';
  const title = own === '' ? titleFrom(description) : own;
  const category = importedCategory(marketplace, listing.details.categoryRef, CANONICAL_PATHS);
  const item: Omit<ImportedItem, 'fromListing'> = {
    title: title === '' ? null : (title?.slice(0, IMPORTED_TITLE_LIMIT) ?? null),
    description: description === '' ? null : description,
    brand: listing.details.brand,
    category: category.category,
    department: category.department,
    sizeLabel: listing.details.size,
    sizeSystem: sizeSystem(listing.details.size),
    condition: listing.details.condition,
    colors: listing.details.colors,
    listPriceCents: listing.details.originalPriceCents ?? listing.priceCents,
  };
  const fromListing = Object.entries(item)
    .filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0))
    .map(([field]) => field);
  return { ...item, fromListing };
}

export function importedListingColumns(
  marketplace: Marketplace,
  listing: ListedListing,
): ImportedListingColumns {
  const category = importedCategory(marketplace, listing.details.categoryRef, CANONICAL_PATHS);
  return {
    title: listing.title,
    description: listingDescription(marketplace, listing),
    priceCents: listing.priceCents,
    categoryRef: category.marketplace?.ref ?? listing.details.categoryRef,
    condition: listing.details.condition,
    sku: listing.details.sku,
  };
}

/** The listing's own text: without Listora's SKU line, and on Depop without its hashtags. */
export function listingDescription(marketplace: Marketplace, listing: ListedListing): string {
  const text = splitSkuLine(listing.description ?? '').description;
  return marketplace === 'depop' ? splitDepopDescription(text).description.trim() : text.trim();
}

/**
 * A title for a listing without one (Depop's are all text): its first line without the
 * hashtags a seller put on it (`Graphic tee #retro #y2k`), up to the title limit at a word
 * boundary.
 */
export function titleFrom(description: string): string | null {
  const line = description
    .split(/\r?\n/)
    .map((part) => part.replace(HASHTAG, ' ').trim())
    .find((part) => part !== '');
  if (line === undefined) return null;
  const words = line.replace(/\s+/g, ' ');
  if (words.length <= IMPORTED_TITLE_LIMIT) return words;
  const cut = words.slice(0, IMPORTED_TITLE_LIMIT + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut.slice(0, IMPORTED_TITLE_LIMIT)).trim();
}

/**
 * The size system a marketplace's size reads as, the tag parsers' way: letters, a number, a
 * waist by inseam, or one size.
 */
export function sizeSystem(size: string | null): string | null {
  if (size === null) return null;
  const shown = size.trim().toUpperCase();
  if (/^(ONE SIZE|OS|O\/S)$/.test(shown)) return 'one_size';
  if (/^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)$/.test(shown)) return 'letter';
  if (/^\d{2}\s*[X×]\s*\d{2}$/.test(shown)) return 'waist_inseam';
  if (/^\d{1,2}(\.5)?$/.test(shown)) return 'numeric';
  return null;
}
