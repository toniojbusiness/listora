/**
 * What an import takes from a Vinted item record (docs/features/imports.md), as the web API's
 * wardrobe and item reads give it (`api.ts`, modeled until the mapping, Vinted plan M2):
 *
 * - photos: `photos`, each with its `full_size_url` (else `url`), on Vinted's image CDN, in the
 *   listing's order (the first is its cover);
 * - `brand_title` (Vinted's "No brand" is none), `size_title`, and the condition, as `status`
 *   (its label, `Very good`) or `status_id`;
 * - the category as Vinted's `catalog_id`, which Listora reads into its own categories once the
 *   taxonomy snapshot exists (M2): until then an imported item has no category, and the seller
 *   adds it;
 * - the colours, `color1` and `color2` (or `colors[].title`), in Listora's terms.
 *
 * Every detail is optional: a record without one imports without it.
 */
import { z } from 'zod';

import type { ItemCondition, ListingDetails } from '@listora/marketplaces';

import { MAX_IMPORTED_PHOTOS } from '../../adapter/listing-import.ts';

/**
 * Vinted's conditions in Listora's terms, by label and by id, never claiming more than the
 * listing does: "Very good" is pre-owned, not new.
 */
const CONDITIONS: Readonly<Record<string, ItemCondition>> = {
  'new with tags': 'new_with_tags',
  'new without tags': 'new_without_tags',
  'very good': 'pre_owned_excellent',
  good: 'pre_owned_good',
  satisfactory: 'pre_owned_fair',
};
const CONDITION_IDS: Readonly<Record<string, ItemCondition>> = {
  '6': 'new_with_tags',
  '1': 'new_without_tags',
  '2': 'pre_owned_excellent',
  '3': 'pre_owned_good',
  '4': 'pre_owned_fair',
};

/** Vinted's colour names in Listora's terms (packages/analysis `COLORS`); the rest have none. */
const COLOURS: Readonly<Record<string, string>> = {
  black: 'black',
  grey: 'gray',
  gray: 'gray',
  white: 'white',
  cream: 'cream',
  beige: 'beige',
  brown: 'brown',
  red: 'red',
  burgundy: 'red',
  pink: 'pink',
  rose: 'pink',
  orange: 'orange',
  yellow: 'yellow',
  mustard: 'yellow',
  green: 'green',
  'dark green': 'green',
  mint: 'green',
  blue: 'blue',
  'light blue': 'blue',
  turquoise: 'blue',
  navy: 'navy',
  purple: 'purple',
  lilac: 'purple',
  gold: 'gold',
  silver: 'silver',
  multi: 'multicolor',
  multicolour: 'multicolor',
  multicolor: 'multicolor',
};

/** Vinted's brand for an item without one. */
const NO_BRAND = /^(no brand|other|unbranded)$/i;

const photo = z.object({ full_size_url: z.string().optional(), url: z.string().optional() });

export function listingDetails(
  record: Readonly<Record<string, unknown>>,
  sku: string | null,
): ListingDetails {
  const catalog = record['catalog_id'];
  return {
    photoUrls: photoUrls(record['photos']),
    brand: brand(record),
    size: text(record['size_title']),
    condition: condition(record),
    categoryRef:
      (typeof catalog === 'number' && Number.isSafeInteger(catalog)) ||
      (typeof catalog === 'string' && /^\d+$/.test(catalog))
        ? String(catalog)
        : null,
    categoryPath: [],
    colors: colours(record),
    originalPriceCents: null,
    sku,
  };
}

function photoUrls(value: unknown): string[] {
  const photos = z.array(z.unknown()).safeParse(value);
  if (!photos.success) return [];
  const urls = photos.data.flatMap((entry) => {
    const shown = photo.safeParse(entry);
    const url = shown.success ? (shown.data.full_size_url ?? shown.data.url) : undefined;
    return url !== undefined && /^https?:\/\//.test(url) ? [url] : [];
  });
  return [...new Set(urls)].slice(0, MAX_IMPORTED_PHOTOS);
}

function brand(record: Readonly<Record<string, unknown>>): string | null {
  const dto = record['brand_dto'];
  const shown =
    text(record['brand_title']) ??
    (dto !== null && typeof dto === 'object'
      ? text((dto as Record<string, unknown>)['title'])
      : null);
  return shown === null || NO_BRAND.test(shown) ? null : shown;
}

function condition(record: Readonly<Record<string, unknown>>): ItemCondition | null {
  const label = text(record['status'])?.toLowerCase();
  const byLabel = label === undefined ? undefined : CONDITIONS[label];
  if (byLabel !== undefined) return byLabel;
  const statusId = record['status_id'];
  return typeof statusId === 'number' || typeof statusId === 'string'
    ? (CONDITION_IDS[String(statusId)] ?? null)
    : null;
}

/** The item's colours that Listora's vocabulary has, in Vinted's order, each once. */
function colours(record: Readonly<Record<string, unknown>>): string[] {
  const named = [record['color1'], record['color2']].flatMap((value) => {
    const shown = text(value);
    return shown === null ? [] : [shown];
  });
  const listed = z.array(z.object({ title: z.string() })).safeParse(record['colors']);
  const names = named.length > 0 ? named : listed.success ? listed.data.map((c) => c.title) : [];
  const known = names.flatMap((name) => {
    const color = COLOURS[name.trim().toLowerCase()];
    return color === undefined ? [] : [color];
  });
  return [...new Set(known)];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
}
