/**
 * What an import takes from one of the seller's Depop listings (docs/features/imports.md), from
 * the two reads its own pages make (api.ts): the listing in the list of the seller's listings
 * for sale (its `sizes`), and the seller's own product as the edit page loads it
 * (`edit-listing`: its photos, brand, condition, category, colours, and pricing).
 *
 * Depop's logged-in API is only seen through a seller's own session, so these keys follow what
 * the edit page loaded on a real seller's session (2026-10-28), and every one is read
 * leniently: a detail Listora doesn't find imports as missing, and the seller adds it on the
 * item.
 *
 * - The category: Depop's own ids, `gender` (or `is_kids`), `group`, and `product_type`
 *   (`female`, `bottoms`, `jeans`), which always name the product type, as the `categoryRef`
 *   (`womenswear/bottoms/jeans`); `categories`, the names the listing shows
 *   (`["Womenswear", "Bottoms"]`), are its `categoryPath`, and its `categoryRef` only without
 *   the ids: they stop at two levels for many product types and use names the sell form no
 *   longer offers ("Lingerie", "Vests").
 * - The brand: `brand_name` ("Hollister Co."), before `brand`, Depop's slug of it
 *   (`hollister-co`); Depop's "Other" (`unbranded`) is no brand.
 * - The colours: `colour`, Depop's ids (`["white", "cream"]`), in Listora's terms.
 * - The price: a marked-down listing's `pricing` has its `original_price` beside the
 *   `discounted_price` a buyer pays now (api.ts reads that one as the listing's price).
 * - Photos: from whichever of the shapes Depop's APIs give pictures in (an image URL, `{ url }`,
 *   a list of sizes, or `formats` keyed by size), taking each picture's widest https image.
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

/** Depop's colour ids (taxonomy.json `colour`) in Listora's terms; khaki has none. */
const COLOURS: Readonly<Record<string, string>> = {
  black: 'black',
  grey: 'gray',
  white: 'white',
  brown: 'brown',
  tan: 'tan',
  cream: 'cream',
  yellow: 'yellow',
  red: 'red',
  burgundy: 'red',
  orange: 'orange',
  pink: 'pink',
  purple: 'purple',
  blue: 'blue',
  navy: 'navy',
  green: 'green',
  multi: 'multicolor',
  silver: 'silver',
  gold: 'gold',
};

/** Depop's departments by the edit data's `gender`. */
const GENDERS: Readonly<Record<string, string>> = { female: 'womenswear', male: 'menswear' };

/** Depop's departments by the first of the names in `categories`, former names included. */
const DEPARTMENT_NAMES: Readonly<Record<string, string>> = {
  womenswear: 'womenswear',
  women: 'womenswear',
  menswear: 'menswear',
  men: 'menswear',
  kidswear: 'kidswear',
  kids: 'kidswear',
  'everything else': 'everything-else',
};

/** Depop's brand slug for a listing without a brand, which it shows as "Other". */
const UNBRANDED = 'unbranded';

/** The details of a listing from its edit data and its record in the list of listings. */
export function listingDetails(
  edit: Readonly<Record<string, unknown>>,
  listed: Readonly<Record<string, unknown>>,
  sku: string | null,
): ListingDetails {
  const categoryPath = strings(edit['categories'] ?? edit['category']).slice(0, 3);
  const ids = categoryIds(edit, categoryPath);
  const condition = text(edit['condition']);
  return {
    photoUrls: photoUrls(
      edit['pictures'] ?? edit['pictures_data'] ?? listed['pictures'] ?? listed['preview'],
    ),
    brand: brand(edit),
    size:
      strings(listed['sizes'])[0] ??
      named(edit['size']) ??
      strings(edit['sizes']).at(0) ??
      variantSize(edit['variants']) ??
      null,
    condition: condition === null ? null : (CONDITIONS[condition] ?? null),
    categoryRef: ids ?? (categoryPath.length > 0 ? categoryPath.join(' > ') : null),
    categoryPath,
    colors: colours(edit['colour'] ?? edit['colours']),
    originalPriceCents: originalPrice(edit['pricing']),
    sku,
  };
}

/**
 * The listing's product type as Depop's ids name it, `department/group/product_type`
 * (`womenswear/bottoms/jeans`, a form `parseCategoryRef` reads): its department from
 * `is_kids`, else `gender`, else the first name in `categories`; `null` without all three. The
 * server checks it against Depop's taxonomy (`importedCategory`), which the phone doesn't carry.
 */
function categoryIds(
  edit: Readonly<Record<string, unknown>>,
  shown: readonly string[],
): string | null {
  const type = text(edit['product_type']);
  const group = text(edit['group']);
  if (type === null || group === null) return null;
  const gender = text(edit['gender'])?.toLowerCase();
  const department =
    edit['is_kids'] === true
      ? 'kidswear'
      : ((gender === undefined ? undefined : GENDERS[gender]) ??
        DEPARTMENT_NAMES[(shown[0] ?? '').toLowerCase()]);
  return department === undefined ? null : [department, group, type].join('/');
}

/** The brand's name as the listing shows it, before Depop's slug of it; "Other" is none. */
function brand(edit: Readonly<Record<string, unknown>>): string | null {
  const slug = typeof edit['brand'] === 'string' ? text(edit['brand']) : null;
  if (slug?.toLowerCase() === UNBRANDED) return null;
  return text(edit['brand_name']) ?? text(edit['brandName']) ?? named(edit['brand']);
}

/** The listing's colours that Listora's vocabulary has, in Depop's order, each once. */
function colours(value: unknown): string[] {
  const known = strings(value).flatMap((colour) => {
    const color = COLOURS[colour.toLowerCase()];
    return color === undefined ? [] : [color];
  });
  return [...new Set(known)];
}

/**
 * The price before the listing's markdown, in cents: `pricing.original_price` when the price a
 * buyer pays now (`final_price_key`) is another, lower one; `null` when it is not marked down.
 */
function originalPrice(pricing: unknown): number | null {
  if (pricing === null || typeof pricing !== 'object') return null;
  const record = pricing as Record<string, unknown>;
  const key = text(record['final_price_key']) ?? 'original_price';
  if (key === 'original_price') return null;
  const original = amountCents(record['original_price']);
  const final = amountCents(record[key]);
  return original !== null && final !== null && original > final ? original : null;
}

/** A Depop price's amount (`{ price_breakdown: { price: { amount: "15.00" } } }`) in cents. */
function amountCents(price: unknown): number | null {
  if (price === null || typeof price !== 'object') return null;
  const breakdown = (price as Record<string, unknown>)['price_breakdown'];
  if (breakdown === null || typeof breakdown !== 'object') return null;
  const shown = (breakdown as Record<string, unknown>)['price'];
  if (shown === null || typeof shown !== 'object') return null;
  const amount = (shown as Record<string, unknown>)['amount'];
  const match = typeof amount === 'string' ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount) : null;
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
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
