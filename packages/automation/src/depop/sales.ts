/**
 * The seller's sales on Depop, for sale checks and the sales history (docs/features/sales.md):
 * one order per receipt (pages/receipts.ts), named by its purchase id, at its sale time, with
 * what the buyer paid for each item, Depop's fees, and whether it has shipped. A canceled or refunded purchase
 * is no sale; a listing the seller marked as sold has no receipt, so it is none either (it sold
 * somewhere else).
 *
 * A receipt names each product by its id only, so the seller's sold listings, as the selling hub
 * lists them (pages/api.ts), give each line its listing: its slug (the listing id Listora keeps),
 * its text, photos, and size, for a sold item Listora would make of it. A bundle's receipt is
 * read once more for what each of its items sold for. Only reads.
 */
import type { ListedListing, OrderFee, RemoteOrder, RemoteOrderItem } from '@listora/marketplaces';

import type { StepRunner } from '../runner/types.ts';
import { onDepop, readOwnListings, type ApiProduct } from './pages/api.ts';
import { changed, type DepopSite } from './pages/common.ts';
import { listingDetails } from './pages/listing-details.ts';
import { readReceiptLines, readReceipts, type Receipt } from './pages/receipts.ts';

/** Pages of receipts (24 each) one sale check goes through at most, newest first. */
export const SALE_CHECK_RECEIPT_PAGES = 5;
/** Pages the sales history (a check with no `since`) goes through at most: 600 sales. */
export const HISTORY_RECEIPT_PAGES = 25;
/** Pages of sold listings (24 each) looked through for the receipts' products at most. */
export const SOLD_LISTING_PAGES = 30;
/** The longest title a sale's line gets from its text (Depop's listings have none). */
const TITLE_LIMIT = 80;

export interface SalesRead {
  site: DepopSite;
  step: StepRunner;
  /** Sales at or after this time; every one the receipts show (up to the limit) when null. */
  since: Date | null;
}

export async function readSales({ site, step, since }: SalesRead): Promise<RemoteOrder[]> {
  const receipts = await readSaleReceipts({ site, step, since });
  if (receipts.length === 0) return [];
  const products = await soldListings(
    { site, step },
    new Set(receipts.flatMap((receipt) => receipt.lines.map((line) => line.productId))),
  );
  const orders: RemoteOrder[] = [];
  for (const receipt of receipts) {
    const prices =
      receipt.lines.length === 1
        ? null
        : await step('read a sale', { mutates: false }, (page) =>
            readReceiptLines(page, site, receipt.purchaseId),
          );
    const items = receipt.lines.map((line): RemoteOrderItem => {
      const product = products.get(line.productId);
      const shown = prices?.get(line.productId);
      if (prices !== null && shown === undefined) {
        throw changed('receipts API', 'shows a bundle without what one of its items sold for');
      }
      const priceCents = shown?.priceCents ?? receipt.itemsCents;
      return {
        externalListingId: product?.state.externalListingId ?? shown?.slug ?? null,
        title: firstLine(line.description),
        priceCents,
        currency: 'USD',
        ...(product === undefined ? {} : { listing: soldListing(product) }),
      };
    });
    orders.push({
      externalOrderId: receipt.purchaseId,
      soldAt: receipt.soldAt,
      items,
      ...(receipt.state === 'unknown' ? {} : { shipped: receipt.state === 'shipped' }),
      ...(receipt.sellerCents === null ? {} : { fees: receiptFees(receipt, receipt.sellerCents) }),
    });
  }
  return orders;
}

/** The receipts of sales that stand, newest first, back to `since`. */
async function readSaleReceipts({ site, step, since }: SalesRead): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  const pages = since === null ? HISTORY_RECEIPT_PAGES : SALE_CHECK_RECEIPT_PAGES;
  let cursor: string | null = null;
  for (let number = 1; number <= pages; number += 1) {
    const shown = await step('read your sales', { mutates: false }, async (page) => {
      await onDepop(page, site);
      return readReceipts(page, site, cursor);
    });
    let older = false;
    for (const receipt of shown.receipts) {
      if (since !== null && receipt.soldAt < since) {
        older = true;
        continue;
      }
      if (receipt.state !== 'canceled') receipts.push(receipt);
    }
    // Newest first: a page that reaches past `since` is the last one needed.
    if (shown.next === null || older) break;
    cursor = shown.next;
  }
  return receipts;
}

/** The seller's sold listings with these product ids, newest first, by id. */
async function soldListings(
  { site, step }: Pick<SalesRead, 'site' | 'step'>,
  wanted: Set<number>,
): Promise<Map<number, ApiProduct>> {
  const found = new Map<number, ApiProduct>();
  let cursor: string | null = null;
  for (let number = 1; number <= SOLD_LISTING_PAGES && found.size < wanted.size; number += 1) {
    const shown = await step('read your sold items', { mutates: false }, async (page) => {
      await onDepop(page, site);
      return readOwnListings(page, site, 'sold', cursor);
    });
    for (const product of shown.products) {
      const id = product.record['id'];
      if (typeof id === 'number' && wanted.has(id)) found.set(id, product);
    }
    if (shown.next === null) break;
    cursor = shown.next;
  }
  return found;
}

/**
 * Depop's fees on a purchase, as its receipt shows them: what the items sold for less what the
 * seller is paid (the payment processing and Boost fees, and anything else Depop keeps). None
 * when the seller is paid it all.
 */
function receiptFees(receipt: Receipt, sellerCents: number): OrderFee[] {
  const kept = receipt.itemsCents - sellerCents;
  return kept > 0
    ? [{ kind: 'marketplace', description: "Depop's fees", amountCents: kept, currency: 'USD' }]
    : [];
}

/** A sold listing as the list of sold listings shows it: its text, photos, and size. */
function soldListing(product: ApiProduct): ListedListing {
  return { ...product.state, details: listingDetails({}, product.record, product.sku) };
}

/** A line's title: the first line of its text, within the title limit. */
function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line === undefined ? null : line.replace(/\s+/g, ' ').slice(0, TITLE_LIMIT);
}
