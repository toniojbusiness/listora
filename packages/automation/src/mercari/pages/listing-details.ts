/**
 * What an import takes from one of the seller's Mercari listings (docs/features/imports.md):
 * its record in the listing page's data (`ItemDetail:<id>`, item-page.ts), which Mercari's own
 * item page is drawn from.
 *
 * The listing page holds the item's photos, brand, size, condition, and category beside what a
 * read-back uses (read on the captain's own listing, 2026-10-27): `photos` (each with its
 * `imageUrl`), and `itemCondition`, `itemSize`, `brand`, and `itemCategoryHierarchy` (top level
 * first) as references to the page's other records (`{ "__ref": "ItemDetailItemSize:4" }`, the
 * Apollo cache Mercari's app draws from), each with its `name`. Every one is read leniently: a
 * detail Listora doesn't find imports as missing, and the seller adds it on the item.
 */
import type { ItemCondition, ListingDetails } from '@listora/marketplaces';

import { MAX_IMPORTED_PHOTOS } from '../../adapter/listing-import.ts';

/**
 * Mercari's conditions in Listora's terms (conditions.ts has their ids), never claiming more
 * than the listing does: Like new is not new.
 */
const CONDITIONS: Readonly<Record<number, ItemCondition>> = {
  1: 'new_with_tags',
  2: 'pre_owned_excellent',
  3: 'pre_owned_good',
  4: 'pre_owned_fair',
  5: 'pre_owned_fair',
};

export function listingDetails(
  shown: Readonly<Record<string, unknown>>,
  records: Readonly<Record<string, unknown>>,
  sku: string | null,
): ListingDetails {
  const record = resolved(shown, records, 0) as Readonly<Record<string, unknown>>;
  const categoryPath = categoryNames(record);
  const condition = conditionId(record);
  return {
    photoUrls: photoUrls(record['photos'] ?? record['photoUrls']),
    brand: named(record['brand']) ?? text(record['brandName']),
    size: named(record['itemSize']) ?? named(record['size']),
    condition: condition === null ? null : (CONDITIONS[condition] ?? null),
    categoryRef: categoryPath.length >= 2 ? categoryPath.join(' > ') : null,
    categoryPath,
    sku,
  };
}

function photoUrls(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  const urls = photos.flatMap((photo) => {
    if (typeof photo === 'string') return isImageUrl(photo) ? [photo] : [];
    if (photo === null || typeof photo !== 'object') return [];
    const record = photo as Record<string, unknown>;
    const url = [record['imageUrl'], record['url'], record['large'], record['thumbnail']].find(
      (value): value is string => typeof value === 'string' && isImageUrl(value),
    );
    return url === undefined ? [] : [url];
  });
  return [...new Set(urls)].slice(0, MAX_IMPORTED_PHOTOS);
}

function categoryNames(record: Readonly<Record<string, unknown>>): string[] {
  const hierarchy = record['itemCategoryHierarchy'] ?? record['categoryHierarchy'];
  if (Array.isArray(hierarchy)) {
    return hierarchy.flatMap((level) => {
      const name = named(level);
      return name === null ? [] : [name];
    });
  }
  const title = text(record['categoryTitle']);
  return title === null
    ? []
    : title
        .split('>')
        .map((name) => name.trim())
        .filter((name) => name !== '');
}

/** Mercari's condition names, for a condition record that gives its name but not its id. */
const CONDITION_NAMES: Readonly<Record<string, number>> = {
  new: 1,
  'like new': 2,
  good: 3,
  fair: 4,
  poor: 5,
};

function conditionId(record: Readonly<Record<string, unknown>>): number | null {
  const condition = record['itemCondition'];
  if (condition !== null && typeof condition === 'object') {
    const { id, name } = condition as Record<string, unknown>;
    const number = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN;
    if (Number.isInteger(number) && CONDITIONS[number] !== undefined) return number;
    if (typeof name === 'string') return CONDITION_NAMES[name.trim().toLowerCase()] ?? null;
  }
  return typeof record['conditionId'] === 'number' ? record['conditionId'] : null;
}

/** The record with its references to the page's other records replaced by those records. */
function resolved(
  value: unknown,
  records: Readonly<Record<string, unknown>>,
  depth: number,
): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => resolved(entry, records, depth + 1));
  const record = value as Record<string, unknown>;
  const ref = record['__ref'];
  if (typeof ref === 'string') return resolved(records[ref] ?? null, records, depth + 1);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, resolved(entry, records, depth + 1)]),
  );
}

function isImageUrl(value: string): boolean {
  return /^https?:\/\/[^/\s]+\/\S+$/.test(value);
}

function named(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return text(record['name']) ?? text(record['displayName']);
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
}
