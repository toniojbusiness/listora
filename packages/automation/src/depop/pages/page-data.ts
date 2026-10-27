/**
 * Depop's product records as its web API gives the seller's own listings (api.ts: `slug`,
 * `status`, the whole `description`, `price`, and `dateUpdated`), and the reads every Depop
 * module shares: the listing's own copy and SKU from a product's text, its revision, and its
 * price. Reads use the data rather than the visible text: exact values (a decimal price, a
 * status code, a change time) where the page shows formatted ones ("$45", "Listed 2 days ago").
 *
 * Every shape is checked; data that no longer has what Listora reads throws `PageChangedError`,
 * so the step goes to the user instead of reading a wrong value.
 */
import { z } from 'zod';

import type { RemoteListing, RemoteListingStatus } from '@listora/marketplaces';
import { splitDepopDescription } from '@listora/shared';

import { splitSkuLine } from '../../adapter/sku-line.ts';
import { PageChangedError } from '../../runner/errors.ts';
import { DEPOP_SLUG } from '../site.ts';
import { productUrl, type DepopSite } from './common.ts';

/** Checks `value` against `schema`; a mismatch names the page and the first missing field. */
export function expectShape<T>(schema: z.ZodType<T>, value: unknown, page: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
  throw new PageChangedError(
    `Depop's ${page} no longer has the ${path === '' ? 'data' : path} Listora reads`,
  );
}

const price = z.object({ priceAmount: z.string(), currencyName: z.string() });

/** One product, as the API's list of the seller's own listings gives it. */
export const productRecordSchema = z.object({
  slug: z.string().regex(DEPOP_SLUG),
  /** `ONSALE`, `SOLD`, `MARKED_AS_SOLD`, `DELETED`, or `BANNED` (STATUSES). */
  status: z.string(),
  /** The whole listing text: copy, Listora's SKU line, hashtags. */
  description: z.string(),
  price,
  /** Depop's last change to the product, to the second. */
  dateUpdated: z.string(),
});
export type ProductRecord = z.infer<typeof productRecordSchema>;

/** One sold item, as the sold items page embeds it (no buyer details are read). */
export const soldItemSchema = z.object({
  slug: z.string().regex(DEPOP_SLUG),
  description: z.string(),
  price,
  soldAt: z.string(),
});
export type SoldItemRecord = z.infer<typeof soldItemSchema>;

/**
 * Depop's product statuses, as the Selling API names them too (`STATUS_ONSALE`, ...). Deleted
 * and banned products are `ended`, as the Depop API adapter reads them: Depop keeps them, and a
 * listing Listora ended stays readable as ended.
 */
const STATUSES: Readonly<Record<string, RemoteListingStatus>> = {
  ONSALE: 'active',
  SOLD: 'sold',
  MARKED_AS_SOLD: 'sold',
  DELETED: 'ended',
  BANNED: 'ended',
};

export interface ProductRead {
  listing: RemoteListing;
  /** The SKU Listora's line in the text names, when it has one. */
  sku: string | null;
}

/**
 * A product record as a read-back: Listora's status, a cents price, the copy without the SKU
 * line and hashtags, and a revision.
 */
export function productRead(record: ProductRecord, site: DepopSite, page: string): ProductRead {
  const status = STATUSES[record.status];
  if (status === undefined) {
    throw new PageChangedError(`Depop's ${page} shows a product status Listora doesn't know`);
  }
  const { description, sku } = listingCopy(record.description);
  return {
    listing: {
      found: true,
      externalListingId: record.slug,
      externalUrl: productUrl(site, record.slug),
      status,
      // Depop listings have no title.
      title: null,
      description,
      priceCents: dollars(record.price, page),
      currency: 'USD',
      revision: revision(record.dateUpdated, page),
    },
    sku,
  };
}

/** The listing's own copy and Listora's SKU from a product's text (copy, SKU line, hashtags). */
export function listingCopy(text: string): { description: string; sku: string | null } {
  return splitSkuLine(splitDepopDescription(text).description);
}

/**
 * The listing's revision: its last change time in milliseconds. Depop keeps it to the second;
 * Listora's own changes to one seller's listings are always more than a second apart (every
 * change is its own browser session, and sessions are at least two seconds apart,
 * `PACING_FLOOR`), so each one has a newer revision.
 */
export function revision(value: string, page: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new PageChangedError(`Depop's ${page} shows a change time Listora can't read`);
  }
  return time;
}

/** A US dollar price (`"45.00"`) in cents. */
export function dollars(value: z.infer<typeof price>, page: string): number {
  if (value.currencyName !== 'USD') {
    throw new PageChangedError(`Depop's ${page} shows a price that is not in US dollars`);
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.priceAmount);
  if (match?.[1] === undefined) {
    throw new PageChangedError(`Depop's ${page} shows a price Listora can't read`);
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
