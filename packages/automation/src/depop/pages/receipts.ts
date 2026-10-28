/**
 * The seller's receipts, as Depop's sold items page loads them: one per purchase, newest first,
 * from `GET /presentation/api/v1/receipts/?role=seller&limit=<n>` (`{"objects": [...],
 * "page_info": {"has_more", "first", "last"}}`; the next page `&after=<last>`), and one receipt
 * with its lines from `GET /presentation/api/v1/receipts/<purchase id>/`. Read on a seller's own
 * session with sales (2026-10-28). A receipt is a sale on Depop: its `purchase_id`, its
 * `sold_timestamp`, its `status` (`shipping_pending` until it ships, then `shipped`), what the
 * buyer paid for the items (`items_amount`, after an accepted offer or a bundle discount: less
 * than the listings' prices), what the seller is paid for them after Depop's fees
 * (`seller_amount`), and its `line_items`, each naming its product by `product_id` with the
 * product's text and photo. A listing the seller marked as sold has no receipt.
 *
 * Sale checks read every receipt (sold-items.ts), and Pack check each one's shipping label and
 * the buyer's first name (docs/features/pack-check.md, "Reading labels"). Nothing else of the
 * buyer is read: no name, address, or message is kept. Only reads.
 */
import { z } from 'zod';

import type { LabelReadRequest, RemoteOrderLabel } from '@listora/marketplaces';

import { buyerFirstName, fieldValues, texts, trackingField } from '../../adapter/label-fields.ts';
import type { PageDriver } from '../../runner/types.ts';
import { changed, type DepopSite } from './common.ts';
import { expectShape } from './page-data.ts';

const TOKEN_COOKIE = 'access_token';
const API = 'receipts API';
const PAGE_SIZE = 24;
/** Pages of receipts one label read goes through at most (newest first). */
export const MAX_RECEIPT_PAGES = 5;

/** A dollar amount as the receipts show it (`"18.00"`). */
const amount = z.string().regex(/^\d+(\.\d{1,2})?$/);

const receiptSchema = z
  .object({
    purchase_id: z.number().int().positive(),
    status: z.string(),
    sold_timestamp: z.iso.datetime({ offset: true }),
    currency: z.string(),
    items_amount: amount,
    seller_amount: amount.nullish(),
    is_bundle: z.boolean(),
    line_items: z
      .array(
        z
          .object({
            product_id: z.number().int().positive(),
            description: z.string(),
            picture_url: z.string().nullish(),
          })
          .catchall(z.unknown()),
      )
      .min(1),
  })
  .catchall(z.unknown());

const receiptsSchema = z.object({
  objects: z.array(z.unknown()),
  page_info: z.object({ has_more: z.boolean(), last: z.string().nullish() }).catchall(z.unknown()),
});

const receiptDetailSchema = z
  .object({
    purchase_id: z.number().int().positive(),
    lines: z
      .array(
        z
          .object({
            product_id: z.number().int().positive(),
            slug: z.string().nullish(),
            product_amount: amount,
          })
          .catchall(z.unknown()),
      )
      .min(1),
  })
  .catchall(z.unknown());

/** How a purchase stands on Depop. */
export type ReceiptState = 'to_ship' | 'shipped' | 'canceled' | 'unknown';

/** One sale on Depop, as its receipt shows it. */
export interface Receipt {
  purchaseId: string;
  soldAt: Date;
  state: ReceiptState;
  /** What the buyer paid for the items, in cents. */
  itemsCents: number;
  /** What the seller is paid for them, after Depop's fees, in cents, when the receipt says. */
  sellerCents: number | null;
  isBundle: boolean;
  lines: { productId: number; description: string; pictureUrl: string | null }[];
  /** Pack check's part. */
  label: ReceiptLabel;
}

/** What Pack check takes from one receipt. */
export interface ReceiptLabel {
  ids: string[];
  slugs: string[];
  trackingNumber: string | null;
  buyerFirstName: string | null;
}

/** One page of the seller's receipts, and the cursor of the next (`null` after the last). */
export async function readReceipts(
  page: PageDriver,
  site: DepopSite,
  cursor: string | null,
): Promise<{ receipts: Receipt[]; next: string | null }> {
  const query = new URLSearchParams({ role: 'seller', limit: String(PAGE_SIZE) });
  if (cursor !== null) query.set('after', cursor);
  const answer = await page.apiGet(
    `${site.api}/presentation/api/v1/receipts/?${query.toString()}`,
    { bearerCookie: TOKEN_COOKIE },
  );
  if (answer.status !== 200)
    throw changed(API, `answered ${String(answer.status)} for the receipts`);
  const shown = expectShape(receiptsSchema, answer.body, API);
  const receipts = shown.objects.map((receipt) => readReceipt(receipt));
  const next = shown.page_info.has_more ? (shown.page_info.last ?? null) : null;
  if (shown.page_info.has_more && next === null)
    throw changed(API, 'has more receipts but no cursor');
  return { receipts, next };
}

/** What each line of a purchase sold for, and its product's slug, by product id. */
export async function readReceiptLines(
  page: PageDriver,
  site: DepopSite,
  purchaseId: string,
): Promise<Map<number, { slug: string | null; priceCents: number }>> {
  const answer = await page.apiGet(
    `${site.api}/presentation/api/v1/receipts/${encodeURIComponent(purchaseId)}/`,
    { bearerCookie: TOKEN_COOKIE },
  );
  if (answer.status !== 200) {
    throw changed(API, `answered ${String(answer.status)} for a receipt`);
  }
  const shown = expectShape(receiptDetailSchema, answer.body, API);
  return new Map(
    shown.lines.map((line) => [
      line.product_id,
      { slug: line.slug ?? null, priceCents: cents(line.product_amount) },
    ]),
  );
}

/** A receipt as Listora reads it; a shape Listora doesn't know throws `PageChangedError`. */
export function readReceipt(value: unknown): Receipt {
  const receipt = expectShape(receiptSchema, value, API);
  if (receipt.currency !== 'USD') throw changed(API, 'shows a sale that is not in US dollars');
  return {
    purchaseId: String(receipt.purchase_id),
    soldAt: new Date(receipt.sold_timestamp),
    state: receiptState(receipt.status),
    itemsCents: cents(receipt.items_amount),
    sellerCents:
      receipt.seller_amount === undefined || receipt.seller_amount === null
        ? null
        : cents(receipt.seller_amount),
    isBundle: receipt.is_bundle,
    lines: receipt.line_items.map((line) => ({
      productId: line.product_id,
      description: line.description,
      pictureUrl: line.picture_url ?? null,
    })),
    label: receiptLabel(receipt),
  };
}

/**
 * A receipt's status in Listora's terms: waiting to ship, shipped (and on to delivered), or
 * canceled or refunded (no longer a sale). One Listora hasn't seen reads as unknown.
 */
export function receiptState(status: string): ReceiptState {
  const shown = status.toLowerCase();
  if (shown === 'shipping_pending') return 'to_ship';
  if (/cancel|refund/.test(shown)) return 'canceled';
  if (/shipped|transit|deliver|complete/.test(shown)) return 'shipped';
  return 'unknown';
}

/** The receipt's ids, product slugs, label, and buyer's first name, by their field names. */
export function receiptLabel(receipt: Readonly<Record<string, unknown>>): ReceiptLabel {
  const ids = texts([receipt['id'], receipt['purchase_id'], receipt['purchaseId']]);
  const slugs = texts(fieldValues(receipt, ['slug', 'product_slug']));
  if (ids.length === 0 && slugs.length === 0) {
    throw changed(API, 'shows a receipt without an id or a product');
  }
  return {
    ids,
    slugs,
    // A parcel's tracking `reference`, as the receipts show it, else a field named so.
    trackingNumber:
      texts(fieldValues(receipt['parcels'], ['reference']))[0] ?? trackingField(receipt),
    buyerFirstName: buyerFirstName(receipt),
  };
}

/** The order's label from the receipts read, or not found. */
export function orderLabel(
  order: LabelReadRequest,
  receipts: readonly ReceiptLabel[],
): RemoteOrderLabel {
  const receipt = receipts.find(
    (shown) =>
      shown.ids.includes(order.externalOrderId) ||
      shown.slugs.includes(order.externalOrderId) ||
      order.externalListingIds.some((id) => shown.slugs.includes(id)),
  );
  if (receipt === undefined) return { externalOrderId: order.externalOrderId, found: false };
  return {
    externalOrderId: order.externalOrderId,
    found: true,
    trackingNumber: receipt.trackingNumber,
    buyerFirstName: receipt.buyerFirstName,
  };
}

/** A dollar amount (`"18.00"`) in cents. */
function cents(value: string): number {
  const [dollars = '0', fraction = ''] = value.split('.');
  return Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
}
