/**
 * The seller's receipts, as Depop's sold items page loads them (read on the captain's session,
 * 2026-10-27): `GET /presentation/api/v1/receipts/?role=seller&limit=12` answers
 * `{"objects": [...], "page_info": {"has_more": false}}`, one receipt per sale, newest first.
 * Pack check reads each sale's shipping label and buyer's first name from them
 * (docs/features/pack-check.md, "Reading labels").
 *
 * That account has no sale, so only the empty answer is known; a receipt's own fields are not.
 * A receipt is matched to an order by its id or by a product slug it names, and only fields
 * whose names say what they are count: `tracking_number` (or `trackingNumber`) for the label,
 * and the buyer's `first_name`. A receipt that names neither an id nor a slug is a page Listora
 * doesn't know (`PageChangedError`), which ends the read visibly and logs the structure, so the
 * reader is fixed from a real receipt instead of guessing. Only reads.
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
/** Pages of receipts one read goes through at most (newest first). */
export const MAX_RECEIPT_PAGES = 5;

const receiptsSchema = z.object({
  objects: z.array(z.record(z.string(), z.unknown())),
  page_info: z.object({ has_more: z.boolean(), end_cursor: z.string().nullish() }).catchall(z.unknown()),
});

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
): Promise<{ receipts: ReceiptLabel[]; next: string | null }> {
  const query = new URLSearchParams({ role: 'seller', limit: String(PAGE_SIZE) });
  if (cursor !== null) query.set('cursor', cursor);
  const answer = await page.apiGet(`${site.api}/presentation/api/v1/receipts/?${query.toString()}`, {
    bearerCookie: TOKEN_COOKIE,
  });
  if (answer.status !== 200) throw changed(API, `answered ${String(answer.status)} for the receipts`);
  const shown = expectShape(receiptsSchema, answer.body, API);
  const receipts = shown.objects.map(receiptLabel);
  const next = shown.page_info.has_more ? (shown.page_info.end_cursor ?? null) : null;
  if (shown.page_info.has_more && next === null) throw changed(API, 'has more receipts but no cursor');
  return { receipts, next };
}

/** The receipt's ids, product slugs, label, and buyer's first name, by their field names. */
export function receiptLabel(receipt: Readonly<Record<string, unknown>>): ReceiptLabel {
  const ids = texts([receipt['id'], receipt['purchase_id'], receipt['purchaseId']]);
  const slugs = texts(fieldValues(receipt, ['slug', 'product_slug']));
  if (ids.length === 0 && slugs.length === 0) {
    throw changed(API, 'shows a receipt without an id or a product');
  }
  return { ids, slugs, trackingNumber: trackingField(receipt), buyerFirstName: buyerFirstName(receipt) };
}

/** The order's label from the receipts read, or not found. */
export function orderLabel(order: LabelReadRequest, receipts: readonly ReceiptLabel[]): RemoteOrderLabel {
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
