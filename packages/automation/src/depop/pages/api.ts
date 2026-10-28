/**
 * The reads Depop's own pages make from its web API (`webapi.depop.com`), made the same way, in
 * the page with the session's token (`PageDriver.apiGet`): faster than loading a page, and they
 * carry what the pages no longer show, Depop's last change time (read on the captain's session,
 * 2026-10-27, from the requests the edit page and the selling hub make):
 *
 * - `GET /presentation/api/v1/products/by-slug/<slug>/edit-listing/`: the seller's own product,
 *   as the edit page loads it (its `status`, whole `description`, `pricing`, and `updated_at`).
 *   Only its seller gets it; Depop answers 404 for one it deleted (which its product page
 *   answers 410 for).
 * - `GET /api/v1/shop/products/?statusFilter=selling` (and `sold`): the seller's own listings,
 *   newest first, as the selling hub loads them, 24 at a time with a cursor; each with its
 *   `id`, `status`, `description`, `price` (the listing's: a buyer may have paid less, which
 *   the receipt shows), `sizes`, `pictures`, and `dateUpdated`.
 *
 * Only reads: every change goes through Depop's own pages. A shape Listora doesn't know throws
 * `PageChangedError`, as a page does.
 */
import { z } from 'zod';

import type { RemoteListingState } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS, DEPOP_SLUG } from '../site.ts';
import { absolute, changed, productUrl, type DepopSite } from './common.ts';
import {
  expectShape,
  listingCopy,
  productRead,
  productRecordSchema,
  revision,
} from './page-data.ts';

/** The cookie Depop's pages send as their bearer token. */
const TOKEN_COOKIE = 'access_token';

const API = 'web API';

/** One page of the seller's own listings. */
const PAGE_SIZE = 24;

const amount = z.object({ amount: z.string() });

const editListingSchema = z.object({
  slug: z.string().regex(DEPOP_SLUG),
  status: z.string(),
  description: z.string(),
  updated_at: z.string(),
  pricing: z
    .object({
      currency_name: z.string(),
      final_price_key: z.string().optional(),
    })
    .catchall(z.unknown()),
});

const priceSchema = z.object({ price_breakdown: z.object({ price: amount }) });

const feedSchema = z.object({
  meta: z.object({ cursor: z.string().nullable(), end: z.boolean() }),
  products: z.array(z.unknown()),
});

/** Product statuses as the API names them (as the Selling API does). */
const STATUSES: Readonly<Record<string, 'active' | 'sold' | 'ended'>> = {
  STATUS_ONSALE: 'active',
  STATUS_SOLD: 'sold',
  // A buyer bought it (the edit data of a sold listing, read 2026-10-28).
  STATUS_PURCHASED: 'sold',
  STATUS_MARKED_AS_SOLD: 'sold',
  STATUS_DELETED: 'ended',
  STATUS_BANNED: 'ended',
};

export interface ApiProduct {
  state: Extract<RemoteListingState, { found: true }>;
  /** The SKU Listora's line in the text names, when it has one. */
  sku: string | null;
  /** The record as the list gave it, for what an import reads besides (listing-details.ts). */
  record: Readonly<Record<string, unknown>>;
}

/** Opens a Depop page first when the tab has none, so the read goes from Depop's own page. */
export async function onDepop(page: PageDriver, site: DepopSite): Promise<void> {
  if (page.url().startsWith(`${site.origin}/`)) return;
  await page.goto(absolute(site, DEPOP_PATHS.hub));
}

/**
 * The seller's own product, as the edit page loads it; `null` when Depop answers 404 (a product
 * it deleted, or another seller's).
 */
export async function readOwnProduct(
  page: PageDriver,
  site: DepopSite,
  slug: string,
): Promise<ApiProduct | null> {
  const answer = await page.apiGet(
    `${site.api}/presentation/api/v1/products/by-slug/${encodeURIComponent(slug)}/edit-listing/`,
    { bearerCookie: TOKEN_COOKIE },
  );
  if (answer.status === 404) return null;
  if (answer.status !== 200) throw changed(API, `answered ${String(answer.status)} for a product`);
  const product = expectShape(editListingSchema, answer.body, API);
  const status = STATUSES[product.status];
  if (status === undefined) throw changed(API, 'shows a product status Listora does not know');
  if (product.pricing.currency_name !== 'USD') {
    throw changed(API, 'shows a price that is not in US dollars');
  }
  // The price a buyer pays now: the original, or a reduced one.
  const key = product.pricing.final_price_key ?? 'original_price';
  const price = expectShape(priceSchema, product.pricing[key], API).price_breakdown.price.amount;
  const { description, sku } = listingCopy(product.description);
  return {
    record: answer.body as Record<string, unknown>,
    state: {
      found: true,
      externalListingId: product.slug,
      externalUrl: productUrl(site, product.slug),
      status,
      title: null,
      description,
      priceCents: cents(price),
      currency: 'USD',
      revision: revision(product.updated_at, API),
      // A save on the edit page moves the last change, which is how a refresh shows.
      refreshedAt: new Date(revision(product.updated_at, API)).toISOString(),
    },
    sku,
  };
}

/**
 * The seller's own listings for sale (`selling`) or sold, newest first: one page of them, and
 * the cursor of the next (`null` after the last).
 */
export async function readOwnListings(
  page: PageDriver,
  site: DepopSite,
  filter: 'selling' | 'sold',
  cursor: string | null,
): Promise<{ products: ApiProduct[]; next: string | null }> {
  const query = new URLSearchParams({
    lang: 'en',
    cursor: cursor ?? '',
    limit: String(PAGE_SIZE),
    statusFilter: filter,
  });
  const answer = await page.apiGet(`${site.api}/api/v1/shop/products/?${query.toString()}`, {
    bearerCookie: TOKEN_COOKIE,
  });
  if (answer.status !== 200) {
    throw changed(API, `answered ${String(answer.status)} for the seller's listings`);
  }
  const feed = expectShape(feedSchema, answer.body, API);
  const products = feed.products.map((entry) => {
    const read = productRead(expectShape(productRecordSchema, entry, API), site, API);
    return { state: read.listing, sku: read.sku, record: entry as Record<string, unknown> };
  });
  return { products, next: feed.meta.end ? null : feed.meta.cursor };
}

/** A US dollar amount (`"18.00"`) in cents. */
function cents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match?.[1] === undefined) throw changed(API, "shows a price Listora can't read");
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
