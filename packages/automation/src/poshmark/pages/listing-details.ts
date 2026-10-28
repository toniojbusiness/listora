/**
 * What an import takes from a Poshmark listing record (docs/features/imports.md), as closet,
 * listing, and browse pages embed it (read on a public category page, 2026-10-27):
 *
 * - photos: `cover_shot` and then `pictures`, each with its `url_large` (else `url`), on
 *   Poshmark's image CDN;
 * - `brand` and `size` as the listing shows them (the size also as the first of
 *   `inventory.size_quantities[].size_obj.display`);
 * - `condition`, Poshmark's code (`nwt`, `uln`, `ug`, `uf`, or `ret` for a boutique listing);
 * - `department`, `category_v2`, and the first of `category_features` (the subcategory), each
 *   as `{ display }` (also in `catalog`, as `department_obj`, `category_obj`, and
 *   `category_feature_objs`), which name the listing's place in the catalog exactly as a
 *   listing's `categoryRef` does (`Women/Dresses/Long Sleeve`).
 *
 * Every detail is optional: a record without one imports without it, and the seller adds it on
 * the item. Only a photo URL that is not an https address is refused, since the server fetches it.
 */
import { z } from 'zod';

import type { ItemCondition, ListingDetails } from '@listora/marketplaces';

import { MAX_IMPORTED_PHOTOS } from '../../adapter/listing-import.ts';
import { splitSkuLine } from '../../adapter/sku-line.ts';
import type { ListingRecord } from './state.ts';

const picture = z.object({
  url: z.string().optional(),
  url_large: z.string().optional(),
});
const display = z.object({ display: z.string().min(1) });
const catalogSchema = z.object({
  department_obj: display.optional(),
  category_obj: display.optional(),
  category_feature_objs: z.array(display).optional(),
});
/** The same place, as the record's own top-level keys name it. */
const topCatalogSchema = z.object({
  department: display.optional(),
  category_v2: display.optional(),
  category_features: z.array(display).optional(),
});
const sizeQuantitiesSchema = z.object({
  size_quantities: z.array(z.object({ size_obj: display.optional() })).optional(),
});

/**
 * Poshmark's conditions in Listora's terms, never claiming more than the listing does: "Like
 * New" is not new, and a boutique (retail) listing is new with tags.
 */
const CONDITIONS: Readonly<Record<string, ItemCondition>> = {
  nwt: 'new_with_tags',
  ret: 'new_with_tags',
  uln: 'pre_owned_excellent',
  ug: 'pre_owned_good',
  uf: 'pre_owned_fair',
};

export function listingDetails(record: ListingRecord): ListingDetails {
  const top = topCatalogSchema.safeParse(record);
  const catalog = catalogSchema.safeParse(record.catalog);
  const path =
    top.success && top.data.department !== undefined
      ? [
          top.data.department.display,
          top.data.category_v2?.display,
          top.data.category_features?.[0]?.display,
        ]
      : catalog.success
        ? [
            catalog.data.department_obj?.display,
            catalog.data.category_obj?.display,
            catalog.data.category_feature_objs?.[0]?.display,
          ]
        : [];
  const categoryPath: string[] = [];
  // A path stops at its first missing level, so it never skips one.
  for (const name of path) {
    if (name === undefined) break;
    categoryPath.push(name.trim());
  }
  return {
    photoUrls: photoUrls(record),
    brand: text(record.brand),
    size: text(record.size) ?? inventorySize(record.inventory),
    condition: typeof record.condition === 'string' ? (CONDITIONS[record.condition] ?? null) : null,
    categoryRef: categoryPath.length >= 2 ? categoryPath.join('/') : null,
    categoryPath,
    colors: [],
    originalPriceCents: null,
    sku: splitSkuLine(record.description).sku,
  };
}

function photoUrls(record: ListingRecord): string[] {
  const pictures = z.array(picture).safeParse(record.pictures);
  const cover = picture.safeParse(record.cover_shot);
  const all = [...(cover.success ? [cover.data] : []), ...(pictures.success ? pictures.data : [])];
  const urls = all.flatMap((shown) => {
    const url = shown.url_large ?? shown.url;
    return url !== undefined && /^https?:\/\//.test(url) ? [url] : [];
  });
  return [...new Set(urls)].slice(0, MAX_IMPORTED_PHOTOS);
}

function inventorySize(inventory: unknown): string | null {
  const parsed = sizeQuantitiesSchema.safeParse(inventory);
  return parsed.success ? text(parsed.data.size_quantities?.[0]?.size_obj?.display) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
}
