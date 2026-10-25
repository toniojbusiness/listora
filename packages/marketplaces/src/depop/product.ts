/**
 * A Depop product as the Selling API reads it back (`Product`: the product GET endpoints and
 * the `v1:product.*` webhooks), and what Listora's read-back makes of it.
 */
import { splitDepopDescription } from '@listora/shared';
import { z } from 'zod';

import type { RemoteListingState, RemoteListingStatus } from '../adapter.ts';
import { depopCents } from './payload.ts';

/** `Product.status`. */
export const DEPOP_PRODUCT_STATUSES = [
  'STATUS_ONSALE',
  'STATUS_PURCHASED',
  'STATUS_MARKED_AS_SOLD',
  'STATUS_DELETED',
  'STATUS_DELETED_ONSALE',
  'STATUS_DELETED_PURCHASED',
  'STATUS_DELETED_MARKED_AS_SOLD',
  'STATUS_PRODUCT_BANNED_ONSALE',
  'STATUS_USER_BANNED_ONSALE',
  'STATUS_PRODUCT_BANNED_PURCHASED',
  'STATUS_USER_BANNED_PURCHASED',
] as const;
export type DepopProductStatus = (typeof DEPOP_PRODUCT_STATUSES)[number];

/** The fields of `Product` Listora reads; Depop's other fields are allowed and ignored. */
export const depopProductSchema = z.object({
  sku: z.string().nullable().optional(),
  product_id: z.number(),
  slug: z.string().min(1),
  /** Kept as text: a status Depop adds later must fail the read, not pass as another. */
  status: z.string(),
  description: z.string(),
  price_currency: z.string(),
  price_amount: z.string(),
  quantity: z.number(),
  updated_at: z.string().optional(),
});
export type DepopProduct = z.infer<typeof depopProductSchema>;

/**
 * A product's status in Listora's terms: on sale is active, bought or marked sold is sold, and a
 * deleted or banned product is off Depop, sold if it sold first. `null` for a status Depop added
 * that Listora doesn't know, which no read-back may guess at.
 */
export function depopListingStatus(status: string): RemoteListingStatus | null {
  switch (status) {
    case 'STATUS_ONSALE':
      return 'active';
    case 'STATUS_PURCHASED':
    case 'STATUS_MARKED_AS_SOLD':
    case 'STATUS_DELETED_PURCHASED':
    case 'STATUS_DELETED_MARKED_AS_SOLD':
    case 'STATUS_PRODUCT_BANNED_PURCHASED':
    case 'STATUS_USER_BANNED_PURCHASED':
      return 'sold';
    case 'STATUS_DELETED':
    case 'STATUS_DELETED_ONSALE':
    case 'STATUS_PRODUCT_BANNED_ONSALE':
    case 'STATUS_USER_BANNED_ONSALE':
      return 'ended';
    default:
      return null;
  }
}

/** The product's page: "`https://www.depop.com/products/{slug}/`". */
export function depopProductUrl(slug: string): string {
  return `https://www.depop.com/products/${encodeURIComponent(slug)}/`;
}

/**
 * A read-back of a product, known to Listora as `externalListingId`. Depop listings have no
 * title, and their reads no revision (`updated_at` has whole seconds, so two changes can share
 * it), so both are `null`. The description is the copy without its hashtag line. Throws for a
 * product Listora can't read for certain.
 */
export function depopRemoteListing(
  externalListingId: string,
  product: DepopProduct,
): Extract<RemoteListingState, { found: true }> {
  const status = depopListingStatus(product.status);
  if (status === null) throw new Error('Depop reported an unknown listing status');
  return {
    found: true,
    externalListingId,
    externalUrl: depopProductUrl(product.slug),
    status,
    title: null,
    description: splitDepopDescription(product.description).description,
    priceCents: depopCents(product.price_amount),
    currency: product.price_currency === 'USD' ? 'USD' : null,
    revision: null,
  };
}
