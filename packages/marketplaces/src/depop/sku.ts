/**
 * How Listora names and addresses Depop listings. Depop creates a product under the SKU the
 * seller's tool sends (`PUT /api/v1/products/by-sku/{sku}/`) and addresses it by that SKU, and
 * "SKU of the product. Must be unique. It can't be reused." (Selling API openapi.yaml). So every
 * Depop listing Listora makes gets a SKU of its own, the item's SKU plus the listing's
 * generation: `AJ-000184-D1` for the first, `AJ-000184-D2` after a relist, and so on. That SKU
 * is the listing's id in Listora (`externalListingId`), named before the create is sent (the
 * engine stores it first), so a read-back finds the listing even when the create's answer is
 * lost.
 *
 * A listing the user posted on Depop and linked from a share has no Listora SKU; Listora knows it
 * by its product slug (`parseListingUrl`), which the Selling API also addresses
 * (`/api/v1/products/by-slug/{slug}/`). Slugs are lowercase words and digits joined by hyphens;
 * Listora's SKUs are uppercase, so the two can't be confused.
 */

/** Depop's `sku` path parameter: `maxLength: 50`. */
export const DEPOP_SKU_MAX_LENGTH = 50;

/** A Listora Depop SKU: the item's SKU (`AJ-000184`), `-D`, and the listing's generation. */
const LISTORA_SKU = /^(.+)-D([1-9]\d{0,8})$/;

/** A Depop product slug, as a share link names it. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The SKU of an item's `generation`-th Depop listing. Throws when it would be too long. */
export function depopSku(itemSku: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError('a Depop listing generation is a positive integer');
  }
  const sku = `${itemSku}-D${String(generation)}`;
  if (sku.length > DEPOP_SKU_MAX_LENGTH) {
    throw new RangeError(`Depop SKUs are at most ${String(DEPOP_SKU_MAX_LENGTH)} characters`);
  }
  return sku;
}

/**
 * The SKU of an item's next Depop listing: one generation past the newest SKU of the item
 * among `usedIds` (every id the item has had on Depop), so no SKU is ever used twice.
 */
export function nextDepopSku(itemSku: string, usedIds: readonly string[]): string {
  let newest = 0;
  for (const id of usedIds) {
    const match = LISTORA_SKU.exec(id);
    if (match?.[1] === itemSku) newest = Math.max(newest, Number(match[2]));
  }
  return depopSku(itemSku, newest + 1);
}

/** How the Selling API addresses a Depop listing Listora knows by `externalListingId`. */
export type DepopProductRef = { by: 'sku'; value: string } | { by: 'slug'; value: string };

export function depopProductRef(externalListingId: string): DepopProductRef {
  return SLUG.test(externalListingId)
    ? { by: 'slug', value: externalListingId }
    : { by: 'sku', value: externalListingId };
}

/** The Selling API path of a product: `/api/v1/products/by-sku/AJ-000184-D1/` and the like. */
export function depopProductPath(ref: DepopProductRef, suffix = ''): string {
  return `/api/v1/products/by-${ref.by}/${encodeURIComponent(ref.value)}/${suffix}`;
}
