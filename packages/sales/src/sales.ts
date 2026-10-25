/**
 * Recording a marketplace sale (`sale` and its `sale_item` rows) from any detection source: the
 * one entry point for eBay's webhook and order poll, and for Depop webhooks, automation sale
 * checks, forwarded emails, and the manual "Mark sold" as they arrive.
 *
 * - **Once per order.** A sale is unique per account, marketplace, and order id, so the
 *   webhook and the poll backstop (or two deliveries of one webhook) racing for the same order
 *   record it once; the later one finds it and changes nothing.
 * - **Only Listora's items.** Each order line is matched to the account's listing on that
 *   marketplace by the listing id (the verified or the pending one) or, failing that, the
 *   seller SKU; a line a person or a parser tied to an item names it directly. An order with no
 *   line Listora knows is not a sale of a Listora item and is not recorded. A bundle line for an
 *   item sold twice in one order adds up on its one sale item.
 * - **Fees.** The sale gets its estimated fee lines at once, and a check for the actual fees
 *   when the marketplace reports them (fees.ts).
 * - **Auto-delist in the same transaction.** Recording the sale starts its delist fan-out
 *   (`startAutoDelist` in `@listora/auto-delist`): each sold item is marked
 *   `sold_pending_delist` and every other listing gets its delist, or the item gets a
 *   double-sale incident. A recorded sale can never miss its delists, and a rolled-back one
 *   never starts them.
 */
import {
  startAutoDelist,
  type AutoDelistDependencies,
  type ItemDelistStart,
} from '@listora/auto-delist';
import {
  inTransaction,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
  type SaleDetectionSource,
} from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

import { recordEstimatedFees, scheduleFeeCheck } from './fees.ts';

/** An order line as the marketplace reports it: matched by listing id, else seller SKU. */
export interface MarketplaceSaleLine {
  /** The marketplace's listing id (eBay `legacyItemId`). */
  externalListingId: string | null;
  externalSku: string | null;
  quantity: number;
  /** What the line sold for: its price times its quantity, before shipping and tax. */
  priceCents: number;
}

/** A line already tied to a Listora item, by a person ("Mark sold") or a parser. */
export interface ItemSaleLine {
  itemId: string;
  /** The item's listing on the sale's marketplace; when absent, its newest one there, if any. */
  listingId: string | null;
  quantity: number;
  priceCents: number;
}

export type SaleLine = MarketplaceSaleLine | ItemSaleLine;

export interface NewSale {
  accountId: string;
  marketplace: Marketplace;
  /** Null only for a manual sale without an order number, which is never deduplicated. */
  externalOrderId: string | null;
  soldAt: Date;
  currency: CurrencyCode;
  shippingChargedCents: number;
  detectionSource: SaleDetectionSource;
  inboundEventId: string | null;
  shipBy: Date | null;
  lines: readonly SaleLine[];
}

export type RecordSaleResult =
  /** Recorded, with each item's delist start (a run, or a double-sale incident). */
  | { type: 'recorded'; saleId: string; itemIds: string[]; delists: ItemDelistStart[] }
  /** The order was recorded before (by another delivery or the poll). */
  | { type: 'duplicate'; saleId: string }
  /** No line of the order is a listing Listora knows. */
  | { type: 'not_listora' };

/** Records the sale and starts its auto-delist, in the caller's transaction (or its own). */
export async function recordSale(
  executor: DbExecutor,
  sale: NewSale,
  deps: AutoDelistDependencies,
): Promise<RecordSaleResult> {
  return inTransaction(executor, async (trx) => {
    const existing = await findSale(trx, sale);
    if (existing !== undefined) return { type: 'duplicate', saleId: existing };

    const items = new Map<string, { listingId: string | null; priceCents: number }>();
    for (const line of sale.lines) {
      const listing = await matchLine(trx, sale, line);
      if (listing === undefined) continue;
      const item = items.get(listing.itemId);
      if (item === undefined) {
        items.set(listing.itemId, { listingId: listing.listingId, priceCents: line.priceCents });
      } else {
        item.priceCents += line.priceCents;
      }
    }
    if (items.size === 0) return { type: 'not_listora' };

    const inserted = await trx
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
      const raced = await findSale(trx, sale);
      if (raced === undefined) throw new Error('a sale conflicted but cannot be found');
      return { type: 'duplicate', saleId: raced };
    }

    await trx
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
    await recordEstimatedFees(trx, {
      accountId: sale.accountId,
      saleId: inserted.id,
      marketplace: sale.marketplace,
      soldAt: sale.soldAt,
      currency: sale.currency,
      salePriceCents: [...items.values()].reduce((sum, item) => sum + item.priceCents, 0),
    });
    await scheduleFeeCheck(
      trx,
      {
        accountId: sale.accountId,
        saleId: inserted.id,
        marketplace: sale.marketplace,
        externalOrderId: sale.externalOrderId,
      },
      deps.adapters,
    );
    const delists = await startAutoDelist(
      trx,
      {
        accountId: sale.accountId,
        saleId: inserted.id,
        marketplace: sale.marketplace,
        detectionSource: sale.detectionSource,
        items: [...items].map(([itemId, item]) => ({ itemId, listingId: item.listingId })),
      },
      deps,
    );
    return { type: 'recorded', saleId: inserted.id, itemIds: [...items.keys()], delists };
  });
}

async function findSale(trx: DbTransaction, sale: NewSale): Promise<string | undefined> {
  if (sale.externalOrderId === null) return undefined;
  const row = await trx
    .selectFrom('sale')
    .select('id')
    .where('account_id', '=', sale.accountId)
    .where('marketplace', '=', sale.marketplace)
    .where('external_order_id', '=', sale.externalOrderId)
    .executeTakeFirst();
  return row?.id;
}

/** The item a line sold and its listing on the sale's marketplace (`listingId` null if none). */
async function matchLine(
  trx: DbTransaction,
  sale: NewSale,
  line: SaleLine,
): Promise<{ itemId: string; listingId: string | null } | undefined> {
  if ('itemId' in line) {
    const item = await trx
      .selectFrom('inventory_item')
      .select('id')
      .where('account_id', '=', sale.accountId)
      .where('id', '=', line.itemId)
      .executeTakeFirst();
    if (item === undefined) return undefined;
    if (line.listingId !== null) return { itemId: item.id, listingId: line.listingId };
    const newest = await trx
      .selectFrom('marketplace_listing')
      .select('id')
      .where('account_id', '=', sale.accountId)
      .where('marketplace', '=', sale.marketplace)
      .where('item_id', '=', item.id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return { itemId: item.id, listingId: newest?.id ?? null };
  }
  const listing = await matchListing(trx, sale, line);
  return listing === undefined ? undefined : { itemId: listing.item_id, listingId: listing.id };
}

/** The account's listing a line sold: by listing id first, then by seller SKU. */
async function matchListing(
  trx: DbTransaction,
  sale: NewSale,
  line: MarketplaceSaleLine,
): Promise<{ id: string; item_id: string } | undefined> {
  const base = trx
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
