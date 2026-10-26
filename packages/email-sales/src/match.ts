/**
 * Which of the seller's items a sale email is about, tried in order of certainty:
 *
 * 1. **The marketplace's listing id**, from the email's link to the listing: the account's
 *    listing on that marketplace with that id (verified or pending).
 * 2. **Listora's SKU** in the email's text: the item with that SKU, or the listing whose seller
 *    SKU it is.
 * 3. **The title**, as a last resort: the items with a listing on that marketplace whose title
 *    (the listing's, else the item's) is the email's, ignoring case, spacing, and punctuation; a
 *    title the email cut short (`...`) matches by its start.
 *
 * Exactly one item is a match. Two or more are ambiguous and none is no match: neither is ever
 * delisted from the email alone.
 */
import { sql } from 'kysely';

import type { DbExecutor, Marketplace } from '@listora/db';

import type { ParsedSale } from './parsers/index.ts';

export type SaleMatch =
  | {
      type: 'matched';
      by: 'listing_id' | 'sku' | 'title';
      itemId: string;
      /** The item's listing on the sale's marketplace, if it has one. */
      listing: { id: string; externalListingId: string | null; priceCents: number | null } | null;
    }
  | { type: 'ambiguous'; candidateItemIds: string[] }
  | { type: 'none' };

/** How many candidates an ambiguous match lists. */
export const MAX_CANDIDATES = 5;

interface ListingRow {
  id: string;
  item_id: string;
  external_listing_id: string | null;
  price_cents: number | null;
}

function listingOf(row: ListingRow | undefined) {
  return row === undefined
    ? null
    : { id: row.id, externalListingId: row.external_listing_id, priceCents: row.price_cents };
}

export async function matchEmailSale(
  executor: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
  sale: ParsedSale,
): Promise<SaleMatch> {
  const listings = executor
    .selectFrom('marketplace_listing')
    .select(['id', 'item_id', 'external_listing_id', 'price_cents'])
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace);

  const listingId = sale.externalListingId;
  if (listingId !== null) {
    const byId = await listings
      .where((eb) =>
        eb.or([
          eb(sql`lower(external_listing_id)`, '=', listingId.toLowerCase()),
          eb(sql`lower(pending_external_listing_id)`, '=', listingId.toLowerCase()),
        ]),
      )
      .executeTakeFirst();
    if (byId !== undefined) {
      return { type: 'matched', by: 'listing_id', itemId: byId.item_id, listing: listingOf(byId) };
    }
  }

  const sku = sale.sku;
  if (sku !== null) {
    const item = await executor
      .selectFrom('inventory_item')
      .select('id')
      .where('account_id', '=', accountId)
      .where('sku', '=', sku)
      .executeTakeFirst();
    const listing = await listings
      .where((eb) =>
        item === undefined
          ? eb('external_sku', '=', sku)
          : eb.or([eb('item_id', '=', item.id), eb('external_sku', '=', sku)]),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const itemId = item?.id ?? listing?.item_id;
    if (itemId !== undefined) {
      return {
        type: 'matched',
        by: 'sku',
        itemId,
        listing: listing?.item_id === itemId ? listingOf(listing) : null,
      };
    }
  }

  if (sale.title === null) return { type: 'none' };
  const wanted = normalizeTitle(sale.title);
  const truncated = /(\.\.\.|…)\s*$/.test(sale.title);
  if (wanted.length < 3) return { type: 'none' };
  const rows = await executor
    .selectFrom('marketplace_listing as listing')
    .innerJoin('inventory_item as item', (join) =>
      join
        .onRef('item.account_id', '=', 'listing.account_id')
        .onRef('item.id', '=', 'listing.item_id'),
    )
    .select([
      'listing.id',
      'listing.item_id',
      'listing.external_listing_id',
      'listing.price_cents',
      'listing.title as listing_title',
      'item.title as item_title',
    ])
    .where('listing.account_id', '=', accountId)
    .where('listing.marketplace', '=', marketplace)
    .orderBy('listing.created_at', 'desc')
    .orderBy('listing.id', 'desc')
    .execute();
  const byItem = new Map<string, ListingRow>();
  for (const row of rows) {
    const title = normalizeTitle(row.listing_title ?? row.item_title ?? '');
    const same = truncated ? title.startsWith(wanted) : title === wanted;
    if (same && !byItem.has(row.item_id)) byItem.set(row.item_id, row);
  }
  const [only, ...others] = [...byItem.values()];
  if (only === undefined) return { type: 'none' };
  if (others.length > 0) {
    return { type: 'ambiguous', candidateItemIds: [...byItem.keys()].slice(0, MAX_CANDIDATES) };
  }
  return { type: 'matched', by: 'title', itemId: only.item_id, listing: listingOf(only) };
}

/** A title for comparing: lower case, letters and digits only, single spaces. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\.\.\.|…)\s*$/, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
