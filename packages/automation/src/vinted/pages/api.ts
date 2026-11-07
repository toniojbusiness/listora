/**
 * The reads Vinted's own pages make from its same-origin web API (`/api/v2/`), made the same way,
 * from a Vinted page with the session's own cookies (`PageDriver.apiGet`, `pageCookies`): the listings and
 * orders reads (docs/features/vinted.md, "Listing import and sales history").
 *
 * - `GET /api/v2/wardrobe/<member id>/items?page=<n>&per_page=96&order=newest_first`: the
 *   member's wardrobe, newest first, with `pagination.total_pages`; each item with its `id`,
 *   `title`, `price`, its state (`is_closed` once it sold, `is_hidden`, `is_draft`,
 *   `is_reserved`), its `photos`, `brand_title`, `size_title`, and condition (`status`).
 * - `GET /api/v2/items/<id>`: one item as its page loads it, with its whole `description`, its
 *   `catalog_id`, and its colours (`color1`, `color2`).
 * - `GET /api/v2/my_orders?type=sold&status=<in_progress|completed|canceled>&page=<n>&per_page=20`:
 *   the member's sold orders, newest first: each with its `transaction_id`, `date` (when the
 *   buyer paid), `title`, `price`, and where it stands in Vinted's words (`status`, "Payment
 *   successful", "Parcel on its way", "Order completed", ...; `orderProgress`). Canceled ones
 *   are read only to settle a sale Listora recorded of them (Vinted plan M6).
 * - `GET /api/v2/transactions/<id>`: one order, with the items that sold in it (`items`, or one
 *   `item`): a bundle sells several in one order; and its `shipment`, which Pack check's label
 *   read takes (`shipment.ts`).
 *
 * Read on the test account's signed-in session (2026-11-05, read-only): the wardrobe answers in
 * this shape (`items`, `pagination` with `current_page` and `total_pages`), and the sold orders
 * answer "Member verification required" (400, `user_verification_required`, a check the profile
 * names) until the member verified their account. The item and transaction reads, and the
 * records' fields, are modeled until the mapping (Vinted plan M2) records them. Every shape is
 * read leniently (a detail it lacks is left out), and one Listora doesn't know at all throws
 * `PageChangedError`, as a page does. Only reads.
 */
import { z } from 'zod';

import type { RemoteListing } from '@listora/marketplaces';

import { splitSkuLine } from '../../adapter/sku-line.ts';
import type { PageDriver } from '../../runner/types.ts';
import { itemPath, VINTED_API_PATHS, VINTED_ID } from '../site.ts';
import { absolute, changed, type VintedSite } from './common.ts';

const API = 'web API';

/** Vinted's pages sign their API reads in with the session's cookies alone. */
const SIGNED_IN = { pageCookies: true } as const;

/** Wardrobe items a page asks for (Vinted's own wardrobe pages ask for 96). */
export const WARDROBE_PAGE_SIZE = 96;
/** Sold orders a page asks for. */
export const ORDERS_PAGE_SIZE = 20;

const id = z.union([z.number().int().nonnegative(), z.string().regex(VINTED_ID)]).transform(String);

/** A price, as `{ amount: "18.0", currency_code: "USD" }` or as `"18.0"` beside `currency`. */
const priceSchema = z.union([
  z.object({ amount: z.union([z.string(), z.number()]), currency_code: z.string().optional() }),
  z.string(),
  z.number(),
]);

const itemSchema = z
  .object({
    id,
    title: z.string().optional(),
    description: z.string().nullish(),
    price: priceSchema.optional(),
    currency: z.string().optional(),
    is_closed: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    is_draft: z.boolean().optional(),
    is_reserved: z.boolean().optional(),
    // Vinted's review of a new upload (modeled until the mapping records an item under review):
    // the item is still being processed, or not yet visible to buyers though its seller didn't
    // hide it.
    is_processing: z.boolean().optional(),
    is_visible: z.union([z.boolean(), z.number()]).optional(),
  })
  .catchall(z.unknown());
export type VintedItemRecord = z.infer<typeof itemSchema>;

const paginationSchema = z
  .object({ current_page: z.number().int(), total_pages: z.number().int() })
  .catchall(z.unknown());

const wardrobeSchema = z.object({ items: z.array(z.unknown()), pagination: paginationSchema });

const orderSchema = z
  .object({
    transaction_id: id,
    date: z.string(),
    title: z.string().nullish(),
    price: priceSchema.optional(),
    // Where the order stands, in Vinted's words, and for whom it waits (modeled until the
    // mapping records an order in each state).
    status: z.string().nullish(),
    transaction_user_status: z.string().nullish(),
  })
  .catchall(z.unknown());
export type VintedOrderRecord = z.infer<typeof orderSchema>;

/** The sold-order lists Vinted's My orders page has: its In progress, Completed, and Canceled tabs. */
export type VintedOrderList = 'in_progress' | 'completed' | 'canceled';

/**
 * Where an order stands on Vinted (docs/features/vinted.md, "Sale checks and auto-delist"):
 *
 * - `unpaid`: the buyer has not paid yet (an accepted offer waiting for payment). Not a sale:
 *   on Vinted an item is sold once it is paid for, never when an offer is accepted.
 * - `to_ship`: paid, and waiting for the seller to send it (Vinted cancels it after 5 business
 *   days unsent). Vinted holds the buyer's money until the order completes.
 * - `shipped`: sent, on its way, or delivered; the buyer has 2 days after delivery to report a
 *   problem, and the money stays with Vinted until then.
 * - `completed`: the buyer confirmed it, or 2 days passed after delivery: the sale is final, and
 *   Vinted pays the seller.
 * - `canceled`: canceled or refunded after payment: it no longer stands.
 * - `unknown`: words Listora doesn't know, so it says nothing of its shipping.
 *
 * The list an order is in decides first (a Completed one is completed, a Canceled one canceled),
 * then Vinted's words for it.
 */
export type VintedOrderProgress =
  'unpaid' | 'to_ship' | 'shipped' | 'completed' | 'canceled' | 'unknown';

/** Vinted's words for each state, tried in this order (a label "sent" to ship it is to ship). */
const ORDER_WORDS: readonly (readonly [Exclude<VintedOrderProgress, 'unknown'>, RegExp])[] = [
  ['canceled', /\bcancel|\brefund|\bfailed\b/],
  [
    'unpaid',
    /waiting for (the )?(buyer'?s? )?payment|awaiting payment|payment (is )?(pending|processing)|not (yet )?paid|\bunpaid\b|offer accepted/,
  ],
  ['completed', /\bcompleted?\b|\bfinali[sz]ed\b/],
  [
    'to_ship',
    /shipping label|\blabel\b|to (ship|send)\b|ship (it )?by|send (it )?by|send (it|the item|the parcel)\b|payment successful|\bpaid\b/,
  ],
  [
    'shipped',
    /\bsent\b|\bshipped\b|on (its|the) way|in transit|delivered|dropped off|picked up|arrived|collected/,
  ],
];

/** Where an order in one of the lists stands (`VintedOrderProgress`). */
export function orderProgress(
  order: VintedOrderRecord,
  list: VintedOrderList,
): VintedOrderProgress {
  if (list === 'completed') return 'completed';
  if (list === 'canceled') return 'canceled';
  const words = [order.status, order.transaction_user_status]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .replaceAll('_', ' ');
  if (words.trim() === '') return 'unknown';
  return ORDER_WORDS.find(([, pattern]) => pattern.test(words))?.[0] ?? 'unknown';
}

const ordersSchema = z.object({ my_orders: z.array(z.unknown()), pagination: paginationSchema });

const transactionSchema = z.object({
  transaction: z
    .object({ id, items: z.array(z.unknown()).optional(), item: z.unknown().optional() })
    .catchall(z.unknown()),
});
/** One order: its `id`, the items that sold in it, and the rest as Vinted shows it. */
export type VintedTransactionRecord = z.infer<typeof transactionSchema>['transaction'];

/** One item as the web API shows it: its state, and its record for the details an import reads. */
export interface VintedItem {
  /** `null` for a draft, which is not a listing. */
  state: RemoteListing | null;
  /**
   * Vinted is reviewing it (a new upload, usually for a minute, sometimes for days): its seller
   * has it, buyers don't see it yet, and Vinted won't let it be hidden or deleted meanwhile.
   */
  inReview: boolean;
  sku: string | null;
  record: VintedItemRecord;
}

/** One page of the member's wardrobe, newest first, and whether another follows. */
export async function readWardrobePage(
  page: PageDriver,
  site: VintedSite,
  memberId: string,
  number: number,
): Promise<{ items: VintedItem[]; hasNext: boolean }> {
  const query = new URLSearchParams({
    page: String(number),
    per_page: String(WARDROBE_PAGE_SIZE),
    order: 'newest_first',
  });
  const answer = await page.apiGet(
    `${absolute(site, VINTED_API_PATHS.wardrobe(memberId))}?${query.toString()}`,
    SIGNED_IN,
  );
  if (answer.status !== 200) {
    throw changed(API, `answered ${String(answer.status)} for your wardrobe`);
  }
  const wardrobe = expectShape(wardrobeSchema, answer.body, 'wardrobe');
  return {
    items: wardrobe.items.map((entry) => vintedItem(expectShape(itemSchema, entry, 'item'), site)),
    hasNext: hasNext(wardrobe.pagination, wardrobe.items.length),
  };
}

/** One item as its page loads it; `null` when Vinted answers 404 (an item it deleted). */
export async function readItem(
  page: PageDriver,
  site: VintedSite,
  itemId: string,
): Promise<VintedItem | null> {
  const answer = await page.apiGet(absolute(site, VINTED_API_PATHS.item(itemId)), SIGNED_IN);
  if (answer.status === 404) return null;
  if (answer.status !== 200) throw changed(API, `answered ${String(answer.status)} for an item`);
  const { item } = expectShape(z.object({ item: z.unknown() }), answer.body, 'item');
  return vintedItem(expectShape(itemSchema, item, 'item'), site);
}

/** The member's sold orders in one list, one page of them, newest first. */
export async function readSoldOrders(
  page: PageDriver,
  site: VintedSite,
  status: VintedOrderList,
  number: number,
): Promise<{ orders: VintedOrderRecord[]; hasNext: boolean }> {
  const query = new URLSearchParams({
    type: 'sold',
    status,
    page: String(number),
    per_page: String(ORDERS_PAGE_SIZE),
  });
  const answer = await page.apiGet(
    `${absolute(site, VINTED_API_PATHS.myOrders)}?${query.toString()}`,
    SIGNED_IN,
  );
  if (answer.status !== 200) {
    throw changed(API, `answered ${String(answer.status)} for your sold orders`);
  }
  const shown = expectShape(ordersSchema, answer.body, 'sold orders');
  return {
    orders: shown.my_orders.map((entry) => expectShape(orderSchema, entry, 'order')),
    hasNext: hasNext(shown.pagination, shown.my_orders.length),
  };
}

/** One order as the web API shows it, read leniently; `null` when Vinted answers 404. */
export async function readTransaction(
  page: PageDriver,
  site: VintedSite,
  transactionId: string,
): Promise<VintedTransactionRecord | null> {
  const answer = await page.apiGet(
    absolute(site, VINTED_API_PATHS.transaction(transactionId)),
    SIGNED_IN,
  );
  if (answer.status === 404) return null;
  if (answer.status !== 200) throw changed(API, `answered ${String(answer.status)} for an order`);
  return expectShape(transactionSchema, answer.body, 'order').transaction;
}

/** The items that sold in one order (several for a bundle); `null` when Vinted answers 404. */
export async function readTransactionItems(
  page: PageDriver,
  site: VintedSite,
  transactionId: string,
): Promise<VintedItem[] | null> {
  const transaction = await readTransaction(page, site, transactionId);
  if (transaction === null) return null;
  const entries = transaction.items ?? (transaction.item === undefined ? [] : [transaction.item]);
  return entries.map((entry) => vintedItem(expectShape(itemSchema, entry, 'item'), site));
}

/** A Vinted amount in US dollars (`"18.0"`, `"1250.50"`, `18`) in cents. */
export function priceCents(
  price: z.infer<typeof priceSchema> | undefined,
  currency: string | undefined,
): number {
  if (price === undefined) throw changed(API, 'shows an item without a price');
  const amount = typeof price === 'object' ? price.amount : price;
  const code = (typeof price === 'object' ? price.currency_code : undefined) ?? currency ?? 'USD';
  if (code !== 'USD') throw changed(API, 'shows a price that is not in US dollars');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount).trim());
  if (match?.[1] === undefined) throw changed(API, "shows a price Listora can't read");
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

/** When a sold order was paid for; throws for a time Listora can't read. */
export function orderTime(order: VintedOrderRecord): Date {
  const at = new Date(order.date);
  if (Number.isNaN(at.getTime())) throw changed(API, "shows an order time Listora can't read");
  return at;
}

/** The item's listing URL on the site: `/items/<id>`, which Vinted sends on to its slug. */
export function itemUrl(site: VintedSite, itemId: string): string {
  return absolute(site, itemPath(itemId));
}

function vintedItem(record: VintedItemRecord, site: VintedSite): VintedItem {
  const { description, sku } = splitSkuLine(record.description ?? '');
  if (record.is_draft === true) return { state: null, inReview: false, sku, record };
  const open = record.is_closed !== true && record.is_hidden !== true;
  const inReview =
    open &&
    (record.is_processing === true || record.is_visible === false || record.is_visible === 0);
  return {
    record,
    sku,
    inReview,
    state: {
      found: true,
      externalListingId: record.id,
      externalUrl: itemUrl(site, record.id),
      // Sold once it closed; a listing the seller hid is not for sale. A reserved one is still
      // listed: the seller holds it for one buyer.
      status: record.is_closed === true ? 'sold' : record.is_hidden === true ? 'ended' : 'active',
      title: text(record.title),
      description:
        record.description === undefined || record.description === null ? null : description,
      priceCents: priceCents(record.price, record.currency),
      currency: 'USD',
      revision: null,
      refreshedAt: null,
    },
  };
}

/** Another page follows while this one showed any and is not the last one Vinted counts. */
function hasNext(pagination: z.infer<typeof paginationSchema>, shown: number): boolean {
  return shown > 0 && pagination.current_page < pagination.total_pages;
}

function expectShape<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw changed(API, `shows ${what} data Listora doesn't know`);
  return parsed.data;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
