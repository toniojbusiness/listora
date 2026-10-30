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
 * Sale checks read every receipt (sales.ts), and Pack check each one's parcel (its label,
 * carrier, deadline, label expiry, and the label's file), how the purchase stands, and the
 * buyer's first name (docs/features/pack-check.md, "Depop's receipts"). Nothing else of the buyer
 * is read: no name, address, or message is kept. Only reads.
 */
import { z } from 'zod';

import type { LabelReadRequest, RemoteOrderLabel } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_SITE_URL, depopSite } from '../site.ts';
import { changed, type DepopSite } from './common.ts';
import { expectShape } from './page-data.ts';

const TOKEN_COOKIE = 'access_token';
const API = 'receipts API';
const PAGE_SIZE = 24;
/** Pages of receipts one label read goes through at most (newest first). */
export const MAX_RECEIPT_PAGES = 5;

/** A dollar amount as the receipts show it (`"18.00"`). */
const amount = z.string().regex(/^\d+(\.\d{1,2})?$/);
const time = z.iso.datetime({ offset: true });

/**
 * One package of a purchase: Depop's label for it (`tracking.reference`, by `shipping_provider`),
 * when it must ship by, when the label expires, and the label's file (`LABEL_FILE_FIELDS`). A
 * bundle's items share one parcel. Its `parcel_status` is the label's, not the order's: a
 * refunded order's parcel can still say `AWAITING_SHIPPING`, so it is never read.
 */
const parcelSchema = z
  .object({
    shipping_provider: z.string().nullish(),
    tracking: z.object({ reference: z.string().nullish() }).catchall(z.unknown()).nullish(),
    shipping_deadline: time.nullish(),
    label_expires_at: time.nullish(),
  })
  .catchall(z.unknown());

/**
 * The parcel fields that can name the label's file, in the order they are read: a URL directly
 * under the parcel, or a `url` under a label object. Only a field that says it is the label's
 * counts, never the tracking page (`tracking.url`). Not seen on a real receipt yet: the live test
 * on the captain's test shop confirms which one Depop uses (docs/features/pack-check.md,
 * "Printing the label"); a receipt that names none prints from Depop instead.
 */
const LABEL_FILE_FIELDS = ['label_url', 'shipping_label_url', 'label_pdf_url'] as const;
const LABEL_FILE_OBJECTS = ['label', 'shipping_label'] as const;

const receiptSchema = z
  .object({
    purchase_id: z.number().int().positive(),
    status: z.string(),
    sold_timestamp: time,
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
    buyer: z.object({ first_name: z.string().nullish() }).catchall(z.unknown()).nullish(),
    parcels: z.array(parcelSchema),
  })
  .catchall(z.unknown());
type ShownReceipt = z.infer<typeof receiptSchema>;

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

/**
 * What Pack check takes from one receipt (docs/features/pack-check.md, "Reading labels"): the
 * purchase, its products, how it stands, its label, and the buyer's first name only.
 */
export interface ReceiptLabel {
  purchaseId: string;
  productIds: number[];
  state: ReceiptState;
  /** The parcel's tracking number; `null` before Depop has a label, or when it shows several. */
  trackingNumber: string | null;
  carrierName: string | null;
  /** The earliest of its parcels' shipping deadlines. */
  shipBy: Date | null;
  labelExpiresAt: Date | null;
  /** The label's file on Depop's own site, when its parcel names one. */
  labelFileUrl: string | null;
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
  const receipts = shown.objects.map((receipt) => readReceipt(receipt, site));
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

/**
 * A receipt as Listora reads it, from Depop's site (or its stand-in); a shape Listora doesn't
 * know throws `PageChangedError`.
 */
export function readReceipt(value: unknown, site: DepopSite = depopSite(DEPOP_SITE_URL)): Receipt {
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
    label: receiptLabel(receipt, site),
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

/**
 * Pack check's part of a receipt. A bundle is one purchase with one parcel for all its items: one
 * package, one label. A purchase whose parcels show several tracking numbers is not one package,
 * so it reads as having no label (the seller scans the one on the package).
 */
function receiptLabel(receipt: ShownReceipt, site: DepopSite): ReceiptLabel {
  const tracked = receipt.parcels.filter((parcel) => present(parcel.tracking?.reference));
  const references = new Set(tracked.map((parcel) => parcel.tracking?.reference?.trim()));
  const parcel = references.size === 1 ? tracked[0] : undefined;
  const deadlines = receipt.parcels.flatMap((shown) =>
    present(shown.shipping_deadline) ? [new Date(shown.shipping_deadline)] : [],
  );
  return {
    purchaseId: String(receipt.purchase_id),
    productIds: receipt.line_items.map((line) => line.product_id),
    state: receiptState(receipt.status),
    trackingNumber: parcel?.tracking?.reference?.trim() ?? null,
    carrierName: present(parcel?.shipping_provider) ? parcel.shipping_provider.trim() : null,
    shipBy: deadlines.length === 0 ? null : new Date(Math.min(...deadlines.map(Number))),
    labelExpiresAt: present(parcel?.label_expires_at) ? new Date(parcel.label_expires_at) : null,
    labelFileUrl: parcel === undefined ? null : labelFile(parcel, site),
    buyerFirstName: present(receipt.buyer?.first_name) ? receipt.buyer.first_name.trim() : null,
  };
}

/**
 * The order's label from the receipts read, or not found. An order is its purchase (Listora names
 * a Depop sale by its purchase id); one named otherwise is found by the products that sold in it,
 * whose slugs (Listora's listing ids) `slugOf` gives by product id.
 */
export function orderLabel(
  order: LabelReadRequest,
  receipts: readonly ReceiptLabel[],
  slugOf: ReadonlyMap<number, string> = new Map(),
): RemoteOrderLabel {
  const sold = (receipt: ReceiptLabel) =>
    receipt.productIds.flatMap((id) => {
      const slug = slugOf.get(id);
      return slug === undefined ? [] : [slug];
    });
  const receipt =
    receipts.find((shown) => shown.purchaseId === order.externalOrderId) ??
    receipts.find((shown) =>
      sold(shown).some(
        (slug) => slug === order.externalOrderId || order.externalListingIds.includes(slug),
      ),
    );
  if (receipt === undefined) return { externalOrderId: order.externalOrderId, found: false };
  return {
    externalOrderId: order.externalOrderId,
    found: true,
    trackingNumber: receipt.trackingNumber,
    buyerFirstName: receipt.buyerFirstName,
    ...(receipt.state === 'unknown' ? {} : { orderState: receipt.state }),
    carrierName: receipt.carrierName,
    shipBy: receipt.shipBy,
    labelExpiresAt: receipt.labelExpiresAt,
    labelFileUrl: receipt.labelFileUrl,
  };
}

/**
 * The label's file a parcel names (`LABEL_FILE_FIELDS`), when it is on Depop's own site: the
 * phone downloads it through the seller's session, so a file anywhere else is not taken.
 */
function labelFile(parcel: Record<string, unknown>, site: DepopSite): string | null {
  const named = [
    ...LABEL_FILE_FIELDS.map((field) => parcel[field]),
    ...LABEL_FILE_OBJECTS.map((field) => {
      const shown = parcel[field];
      return shown !== null && typeof shown === 'object' ? (shown as { url?: unknown }).url : null;
    }),
  ].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (named === undefined || !URL.canParse(named.trim(), site.origin)) return null;
  const url = new URL(named.trim(), site.origin);
  return onDepop(url, site) ? url.href : null;
}

/** Whether a URL is on Depop's site or web API (or their local stand-in). */
function onDepop(url: URL, site: DepopSite): boolean {
  if (url.origin === site.origin || url.origin === site.api) return true;
  return (
    url.protocol === 'https:' &&
    (url.hostname === 'depop.com' || url.hostname.endsWith('.depop.com'))
  );
}

function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.trim() !== '';
}

/** A dollar amount (`"18.00"`) in cents. */
function cents(value: string): number {
  const [dollars = '0', fraction = ''] = value.split('.');
  return Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
}
