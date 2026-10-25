/**
 * Recording a marketplace sale (`sale` and its `sale_item` rows) from any detection source.
 *
 * - **Once per order.** A sale is unique per account, marketplace, and order id, so the
 *   webhook and the poll backstop (or two deliveries of one webhook) racing for the same order
 *   record it once; the later one finds it and changes nothing.
 * - **Only Listora's items.** Each order line is matched to the account's listing on that
 *   marketplace by the listing id (the verified or the pending one) or, failing that, the
 *   seller SKU. An order with no line Listora knows is not a sale of a Listora item and is not
 *   recorded. A bundle line for an item sold twice in one order adds up on its one sale item.
 * - **Handed to auto-delist.** The transaction that records the sale also adds a
 *   `sale_recorded` job for it, the domain event the auto-delist orchestrator (T-20) consumes,
 *   so a recorded sale can never miss its delist fan-out and a rolled-back one never starts it.
 *   Until a worker registers that task, its jobs wait in the queue.
 */
import { addJob, type DbExecutor, type Marketplace, type SaleDetectionSource } from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

/** The task the auto-delist orchestrator (T-20) runs for every recorded sale. */
export const SALE_RECORDED_TASK = 'sale_recorded';

export interface SaleRecordedPayload {
  accountId: string;
  saleId: string;
}

export function isSaleRecordedPayload(value: unknown): value is SaleRecordedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, saleId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof saleId === 'string';
}

export interface SaleLine {
  /** The marketplace's listing id (eBay `legacyItemId`). */
  externalListingId: string | null;
  externalSku: string | null;
  quantity: number;
  /** What the line sold for: its price times its quantity, before shipping and tax. */
  priceCents: number;
}

export interface NewSale {
  accountId: string;
  marketplace: Marketplace;
  externalOrderId: string;
  soldAt: Date;
  currency: CurrencyCode;
  shippingChargedCents: number;
  detectionSource: SaleDetectionSource;
  inboundEventId: string | null;
  shipBy: Date | null;
  lines: readonly SaleLine[];
}

export type RecordSaleResult =
  | { type: 'recorded'; saleId: string; itemIds: string[] }
  /** The order was recorded before (by another delivery or the poll). */
  | { type: 'duplicate'; saleId: string }
  /** No line of the order is a listing Listora knows. */
  | { type: 'not_listora' };

/** Records the sale and its domain event in the caller's transaction. */
export async function recordSale(executor: DbExecutor, sale: NewSale): Promise<RecordSaleResult> {
  const existing = await findSale(executor, sale);
  if (existing !== undefined) return { type: 'duplicate', saleId: existing };

  const items = new Map<string, { listingId: string; priceCents: number }>();
  for (const line of sale.lines) {
    const listing = await matchListing(executor, sale, line);
    if (listing === undefined) continue;
    const item = items.get(listing.item_id);
    if (item === undefined) {
      items.set(listing.item_id, { listingId: listing.id, priceCents: line.priceCents });
    } else {
      item.priceCents += line.priceCents;
    }
  }
  if (items.size === 0) return { type: 'not_listora' };

  const inserted = await executor
    .insertInto('sale')
    .values({
      account_id: sale.accountId,
      marketplace: sale.marketplace,
      external_order_id: sale.externalOrderId,
      sold_at: sale.soldAt,
      currency: sale.currency,
      shipping_charged_cents: sale.shippingChargedCents,
      detection_source: sale.detectionSource,
      inbound_event_id: sale.inboundEventId,
      ship_by: sale.shipBy,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'marketplace', 'external_order_id']).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (inserted === undefined) {
    // Recorded meanwhile by a concurrent transaction that committed first.
    const raced = await findSale(executor, sale);
    if (raced === undefined) throw new Error('a sale conflicted but cannot be found');
    return { type: 'duplicate', saleId: raced };
  }

  await executor
    .insertInto('sale_item')
    .values(
      [...items].map(([itemId, item]) => ({
        account_id: sale.accountId,
        sale_id: inserted.id,
        marketplace: sale.marketplace,
        item_id: itemId,
        listing_id: item.listingId,
        currency: sale.currency,
        sale_price_cents: item.priceCents,
      })),
    )
    .execute();
  const payload: SaleRecordedPayload = { accountId: sale.accountId, saleId: inserted.id };
  await addJob(executor, {
    task: SALE_RECORDED_TASK,
    payload: { ...payload },
    jobKey: `sale:${inserted.id}`,
  });
  return { type: 'recorded', saleId: inserted.id, itemIds: [...items.keys()] };
}

async function findSale(executor: DbExecutor, sale: NewSale): Promise<string | undefined> {
  const row = await executor
    .selectFrom('sale')
    .select('id')
    .where('account_id', '=', sale.accountId)
    .where('marketplace', '=', sale.marketplace)
    .where('external_order_id', '=', sale.externalOrderId)
    .executeTakeFirst();
  return row?.id;
}

/** The account's listing a line sold: by listing id first, then by seller SKU. */
async function matchListing(
  executor: DbExecutor,
  sale: NewSale,
  line: SaleLine,
): Promise<{ id: string; item_id: string } | undefined> {
  const base = executor
    .selectFrom('marketplace_listing')
    .select(['id', 'item_id'])
    .where('account_id', '=', sale.accountId)
    .where('marketplace', '=', sale.marketplace);
  if (line.externalListingId !== null && line.externalListingId !== '') {
    const id = line.externalListingId;
    const byId = await base
      .where((eb) =>
        eb.or([eb('external_listing_id', '=', id), eb('pending_external_listing_id', '=', id)]),
      )
      .executeTakeFirst();
    if (byId !== undefined) return byId;
  }
  if (line.externalSku !== null && line.externalSku !== '') {
    // The newest listing with the SKU: an ended one may share it with its relist.
    return base
      .where('external_sku', '=', line.externalSku)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }
  return undefined;
}
