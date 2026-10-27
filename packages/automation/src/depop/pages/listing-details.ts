/**
 * What an import takes from one of the seller's Depop listings (docs/features/imports.md), from
 * the two reads its own pages make (api.ts): the listing in the list of the seller's listings
 * for sale (its `sizes`), and the seller's own product as the edit page loads it
 * (`edit-listing`: its photos, brand, condition, and categories).
 *
 * Depop's logged-in API is only seen through a seller's own session, so these keys follow the
 * fake Depop (which models what the edit page loaded on the captain's session, 2026-10-27), and
 * every one is read leniently: a detail Listora doesn't find imports as missing, and the seller
 * adds it on the item. Photos are read from whichever of the shapes Depop's APIs give pictures
 * in (an image URL, `{ url }`, a list of sizes, or `formats` keyed by size), taking each
 * picture's widest https image.
 */
import type { ItemCondition, ListingDetails } from '@listora/marketplaces';

import { MAX_IMPORTED_PHOTOS } from '../../adapter/listing-import.ts';

/**
 * Depop's conditions in Listora's terms, never claiming more than the listing does: Depop's
 * "Brand new" says nothing about tags.
 */
const CONDITIONS: Readonly<Record<string, ItemCondition>> = {
  brand_new: 'new_without_tags',
  used_like_new: 'pre_owned_excellent',
  used_excellent: 'pre_owned_excellent',
  used_good: 'pre_owned_good',
  used_fair: 'pre_owned_fair',
};

/** The details of a listing from its edit data and its record in the list of listings. */
export function listingDetails(
  edit: Readonly<Record<string, unknown>>,
  listed: Readonly<Record<string, unknown>>,
  sku: string | null,
): ListingDetails {
  const categoryPath = strings(edit['categories'] ?? edit['category']).slice(0, 3);
  const condition = text(edit['condition']);
  return {
    photoUrls: photoUrls(
      edit['pictures'] ?? edit['pictures_data'] ?? listed['pictures'] ?? listed['preview'],
    ),
    brand: named(edit['brand']) ?? text(edit['brand_name']) ?? text(edit['brandName']),
    size:
      strings(listed['sizes'])[0] ??
      named(edit['size']) ??
      strings(edit['sizes']).at(0) ??
      variantSize(edit['variants']) ??
      null,
    condition: condition === null ? null : (CONDITIONS[condition] ?? null),
    categoryRef: categoryPath.length > 0 ? categoryPath.join(' > ') : null,
    categoryPath,
    sku,
  };
}

/** Each picture's widest https image, in order. */
export function photoUrls(pictures: unknown): string[] {
  if (!Array.isArray(pictures)) return [];
  const urls = pictures.flatMap((picture) => {
    const best = widest(picture);
    return best === null ? [] : [best];
  });
  return [...new Set(urls)].slice(0, MAX_IMPORTED_PHOTOS);
}

/** The widest https image URL anywhere in one picture's data (the first, when none says). */
function widest(picture: unknown): string | null {
  const found: { url: string; width: number }[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (isImageUrl(value)) found.push({ url: value, width: 0 });
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const url = record['url'];
    if (typeof url === 'string' && isImageUrl(url)) {
      found.push({ url, width: typeof record['width'] === 'number' ? record['width'] : 0 });
    }
    for (const [key, entry] of Object.entries(record)) {
      if (key !== 'url') visit(entry, depth + 1);
    }
  };
  visit(picture, 0);
  let best: { url: string; width: number } | null = null;
  for (const candidate of found)
    if (best === null || candidate.width > best.width) best = candidate;
  return best?.url ?? null;
}

function isImageUrl(value: string): boolean {
  return /^https?:\/\/[^/\s]+\/\S+$/.test(value) && !/\.(mp4|mov|m3u8)(\?|$)/i.test(value);
}

/** A name as Depop gives it: a string, or an object with its `name`. */
function named(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return text(record['name']) ?? text(record['label']) ?? text(record['display']);
  }
  return null;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return text(value) === null ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = named(entry);
    return name === null ? [] : [name];
  });
}

/** The first variant's size (`{ size: "M" }` or `{ size: { name: "M" } }`). */
function variantSize(variants: unknown): string | null {
  const first: unknown = Array.isArray(variants)
    ? variants[0]
    : variants !== null && typeof variants === 'object'
      ? Object.values(variants)[0]
      : undefined;
  if (first === null || typeof first !== 'object') return null;
  const record = first as Record<string, unknown>;
  return named(record['size']) ?? text(record['size_name']) ?? null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
}
