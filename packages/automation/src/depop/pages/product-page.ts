/**
 * A product's page (`/products/<slug>/`), as its seller sees it: the read-back every automated
 * Depop step is verified by.
 *
 * Read on Depop's real product pages (2026, captured copies of public pages): the page is an App
 * Router page (flight-data.ts) whose rows hold the product as its first query loaded it
 * (`["product_basic_by_slug", slug]`): `slug`, `status` (`STATUS_ONSALE`, ...), and the whole
 * listing `description` (copy, Listora's SKU line, hashtags). The price is in the page's
 * schema.org data (`script[data-testid="meta__jsonLd"]`, a `Product` whose `offers` has the
 * `price`, its `priceCurrency`, and the product's `url`). The page no longer says when the
 * product last changed, so a read has no revision, and the adapter confirms a change by reading
 * it twice (`readFreshness: 'none'`).
 *
 * - Status: Depop's product status (on sale, sold, deleted).
 * - Absence: a deleted product's page answers 410 Gone (seen on a real listing Listora deleted,
 *   2026-10-27), which is definitive. A 404 is not: it could be a listing not visible yet, as
 *   Depop says of its API too ("A newly created listing can take a short time to become
 *   retrievable").
 */
import { z } from 'zod';

import type { RemoteListingState, RemoteListingStatus } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_SLUG } from '../site.ts';
import { changed, productUrl, type DepopSite } from './common.ts';
import { findRecords, flightRows } from './flight-data.ts';
import { expectShape, listingCopy } from './page-data.ts';

export const PRODUCT_PAGE = {
  /** The page's schema.org data: the product, with its offer's price. */
  structuredData: 'script[data-testid="meta__jsonLd"]',
} as const;

const PAGE = 'product page';

/** The product as the page's first query loaded it. */
const productRecordSchema = z.object({
  slug: z.string().regex(DEPOP_SLUG),
  /** `STATUS_ONSALE`, `STATUS_SOLD`, ... (STATUSES). */
  status: z.string(),
  description: z.string(),
});

const structuredDataSchema = z.object({
  offers: z.object({
    url: z.string(),
    price: z.union([z.string(), z.number()]),
    priceCurrency: z.string(),
  }),
});

/**
 * Depop's product statuses, as its Selling API names them too. Deleted and banned products are
 * `ended`, as the Depop API adapter reads them: Depop keeps them, and a listing Listora ended
 * stays readable as ended.
 */
const STATUSES: Readonly<Record<string, RemoteListingStatus>> = {
  STATUS_ONSALE: 'active',
  STATUS_SOLD: 'sold',
  STATUS_MARKED_AS_SOLD: 'sold',
  STATUS_DELETED: 'ended',
  STATUS_BANNED: 'ended',
};

export interface ProductPageRead {
  state: RemoteListingState;
  /** The SKU Listora's line in the text names, when it has one. */
  sku: string | null;
}

/** Opens the product's page and reads it. */
export async function readProduct(
  page: PageDriver,
  site: DepopSite,
  slug: string,
): Promise<ProductPageRead> {
  await page.goto(productUrl(site, slug));
  if (page.status() === 410) return { state: { found: false, authoritative: true }, sku: null };
  if (page.status() === 404) return { state: { found: false, authoritative: false }, sku: null };
  const records = findRecords(
    await flightRows(page),
    (record) => record['slug'] === slug && 'status' in record && 'description' in record,
  );
  if (records.length === 0) throw changed(PAGE, 'has none of the product data Listora reads');
  const product = expectShape(productRecordSchema, records[0], PAGE);
  const status = STATUSES[product.status];
  if (status === undefined) throw changed(PAGE, 'shows a product status Listora does not know');
  const priceCents = await offerPrice(page, slug);
  const { description, sku } = listingCopy(product.description);
  return {
    state: {
      found: true,
      externalListingId: product.slug,
      externalUrl: productUrl(site, product.slug),
      status,
      // Depop listings have no title.
      title: null,
      description,
      priceCents,
      currency: 'USD',
      revision: null,
    },
    sku,
  };
}

/** The product's price in cents, from the page's schema.org offer for this product. */
async function offerPrice(page: PageDriver, slug: string): Promise<number> {
  const text = await page.text(PRODUCT_PAGE.structuredData);
  if (text === null) throw changed(PAGE, 'has no product data (structured data)');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw changed(PAGE, "has structured data Listora can't parse");
  }
  const { offers } = expectShape(structuredDataSchema, data, PAGE);
  if (!offers.url.includes(`/products/${slug}/`)) throw changed(PAGE, 'offers a different product');
  if (offers.priceCurrency !== 'USD')
    throw changed(PAGE, 'shows a price that is not in US dollars');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(offers.price));
  if (match?.[1] === undefined) throw changed(PAGE, "shows a price Listora can't read");
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
