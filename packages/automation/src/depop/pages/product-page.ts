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
 * - Status: Depop's product status (on sale, sold, deleted). The seller's own product page
 *   (Depop opens `/products/<slug>/manage/` for them) does not always carry the record: the
 *   phone once got it without, a minute after posting (2026-10-27). Its schema.org data then
 *   speaks for it: the whole description and the offer's availability (`InStock` is on sale,
 *   `SoldOut` and `OutOfStock` are sold).
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
  /**
   * The page's schema.org data: the product, with its offer's price. A page may carry more than
   * one block (the phone was once given another before the product's), so the product's own is
   * the one that offers this slug.
   */
  structuredData: 'script[data-testid="meta__jsonLd"], script[type="application/ld+json"]',
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
  description: z.string().optional(),
  offers: z.object({
    url: z.string(),
    price: z.union([z.string(), z.number()]),
    priceCurrency: z.string(),
    availability: z.string().optional(),
  }),
});

/** schema.org availability, as the page's structured data names it, by Listora's status. */
const AVAILABILITY: Readonly<Record<string, RemoteListingStatus>> = {
  'https://schema.org/InStock': 'active',
  'https://schema.org/SoldOut': 'sold',
  'https://schema.org/OutOfStock': 'sold',
};

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
  const offer = await structuredOffer(page, slug);
  let status: RemoteListingStatus | undefined;
  let text: string;
  if (records.length > 0) {
    const product = expectShape(productRecordSchema, records[0], PAGE);
    status = STATUSES[product.status];
    if (status === undefined) throw changed(PAGE, 'shows a product status Listora does not know');
    text = product.description;
  } else {
    // The page carries no record: its structured data speaks for the product.
    status = offer.availability === undefined ? undefined : AVAILABILITY[offer.availability];
    if (status === undefined || offer.description === undefined) {
      throw changed(PAGE, 'has none of the product data Listora reads');
    }
    text = offer.description;
  }
  const priceCents = offer.priceCents;
  const { description, sku } = listingCopy(text);
  return {
    state: {
      found: true,
      externalListingId: slug,
      externalUrl: productUrl(site, slug),
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

/** The page's schema.org data for this product: its price in cents, availability, and text. */
async function structuredOffer(
  page: PageDriver,
  slug: string,
): Promise<{ priceCents: number; availability?: string; description?: string }> {
  const blocks = (await page.texts(PRODUCT_PAGE.structuredData)).flatMap((text) => {
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [];
    }
  });
  if (blocks.length === 0) throw changed(PAGE, 'has no product data (structured data)');
  const own = blocks.find((block) => {
    const read = structuredDataSchema.safeParse(block);
    return read.success && read.data.offers.url.includes(`/products/${slug}/`);
  });
  if (own === undefined) {
    // Say what is wrong with the product's block: no offers, or another product's.
    const product = blocks.find((block) => structuredDataSchema.safeParse(block).success);
    if (product !== undefined) throw changed(PAGE, 'offers a different product');
    expectShape(structuredDataSchema, blocks[0], PAGE);
    throw changed(PAGE, 'has none of the product data Listora reads');
  }
  const { offers, description } = expectShape(structuredDataSchema, own, PAGE);
  if (offers.priceCurrency !== 'USD')
    throw changed(PAGE, 'shows a price that is not in US dollars');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(offers.price));
  if (match?.[1] === undefined) throw changed(PAGE, "shows a price Listora can't read");
  return {
    priceCents: Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0')),
    ...(offers.availability === undefined ? {} : { availability: offers.availability }),
    ...(description === undefined ? {} : { description }),
  };
}
