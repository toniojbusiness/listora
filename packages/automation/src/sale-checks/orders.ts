/**
 * Turning the orders an automated sale check found into sales (decision D1). The browser runner
 * stores each new order as an `inbound_event` (source `poll`, once per order) and queues
 * `automation_sale_order` for it in the same transaction. The worker runs that job: it records
 * the sale with `recordSale` (@listora/sales), which starts the sale's auto-delist, and finishes
 * the event `processed` (a sale was recorded) or `ignored` (the sale was recorded before, or
 * nothing of it can be recorded).
 *
 * An order of a listing Listora doesn't have is the seller's sale all the same (their sales
 * history, docs/features/sales.md): its line becomes a sold item, made from the sold listing as
 * the marketplace's pages showed it (`SoldItemMaker`, @listora/imports), and the sale is recorded
 * on it. Its photos are fetched between two transactions, never inside one. A sold listing never
 * joins an item Listora has: a wrong match would delist that item everywhere else.
 *
 * An order that sold before the connection's sales history ends (when it was linked, or the
 * deploy that brought sales history in) is the seller's sales history (detection source
 * `history`), of Listora's listings too: Listora wasn't acting on it then, so the sale is
 * recorded only, with no auto-delist, delist, notification, or request to ship it. An order the
 * marketplace says shipped is `shipped`, and the fees it showed replace the estimate.
 *
 * The runner hands the sale over instead of recording it, because the auto-delist fan-out
 * decides from each listing's capabilities whether it is marked sold or ended, and only the
 * worker's adapters include the API adapters (eBay, Depop) that decide it.
 */
import { z } from 'zod';

import {
  addJob,
  FEE_KINDS,
  inTransaction,
  type Db,
  type DbExecutor,
  type DbTransaction,
  type JsonObject,
  type Marketplace,
} from '@listora/db';
import type { AdapterLookup, RemoteOrder } from '@listora/marketplaces';
import { isPackCheckEnabled } from '@listora/pack-check';
import {
  changeSale,
  finishInboundEvent,
  recordSale,
  replaceWithActualFees,
  type SaleLine,
} from '@listora/sales';
import type { Logger } from '@listora/shared';

import { queueLabelReads } from '../label-reads/queue.ts';

/** The worker task that records the sale of an order an automated sale check found. */
export const SALE_ORDER_TASK = 'automation_sale_order';

export interface SaleOrderJobPayload {
  accountId: string;
  inboundEventId: string;
}

export function isSaleOrderJobPayload(value: unknown): value is SaleOrderJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, inboundEventId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof inboundEventId === 'string';
}

/**
 * What a sale check keeps of an order in its inbound event: no buyer, no address. It names the
 * check that saw it (`sale_check_run`), which the sale then names too.
 */
export function orderEventPayload(
  connectionId: string,
  order: RemoteOrder,
  saleCheckRunId: string | null = null,
) {
  return {
    connectionId,
    ...(saleCheckRunId === null ? {} : { saleCheckRunId }),
    externalOrderId: order.externalOrderId,
    soldAt: order.soldAt.toISOString(),
    ...(order.shipped === undefined ? {} : { shipped: order.shipped }),
    ...(order.fees === undefined ? {} : { fees: order.fees.map((fee) => ({ ...fee })) }),
    items: order.items.map((item) => ({
      externalListingId: item.externalListingId,
      title: item.title,
      priceCents: item.priceCents,
      currency: item.currency,
      // The sold listing's own photos and details, for a sold item Listora would make of it (a
      // `ListedListing` is plain JSON).
      ...(item.listing === undefined ? {} : { listing: item.listing as unknown as JsonObject }),
    })),
  };
}

const orderEventSchema = z.object({
  connectionId: z.uuid().optional(),
  saleCheckRunId: z.uuid().optional(),
  externalOrderId: z.string().min(1),
  soldAt: z.iso.datetime(),
  shipped: z.boolean().optional(),
  fees: z
    .array(
      z.object({
        kind: z.enum(FEE_KINDS),
        description: z.string(),
        amountCents: z.number().int(),
        currency: z.literal('USD'),
      }),
    )
    .optional(),
  items: z.array(
    z.object({
      externalListingId: z.string().nullable(),
      title: z.string().nullable().optional(),
      priceCents: z.number().int().nonnegative(),
      currency: z.literal('USD'),
      listing: z.unknown().optional(),
    }),
  ),
});
type OrderEvent = z.infer<typeof orderEventSchema>;

/** Queues the worker's job for an order's new inbound event, in the caller's transaction. */
export async function queueSaleOrder(
  executor: DbExecutor,
  payload: SaleOrderJobPayload,
): Promise<void> {
  await addJob(executor, {
    task: SALE_ORDER_TASK,
    payload: { ...payload },
    jobKey: `inbound:${payload.inboundEventId}`,
  });
}

/** An order line of a listing Listora doesn't have, to make a sold item of. */
export interface SoldItemSource {
  accountId: string;
  /** The connection whose sale check found it, which the sold listing belongs to. */
  connectionId: string | null;
  marketplace: Marketplace;
  externalListingId: string | null;
  title: string | null;
  priceCents: number;
  /** The sold listing as the sale check stored it (a `ListedListing`), when its pages showed it. */
  listing: unknown;
}

/**
 * Makes the sold item of an order line Listora has no listing for (@listora/imports, wired by
 * the worker). `prepare` fetches what it needs from outside (the listing's photos) before any
 * transaction; `create`, in the sale's transaction, makes the item and its sold listing. Null
 * from `prepare`: the line shows too little to make an item of (no listing and no title).
 */
export interface SoldItemMaker<Prepared = unknown> {
  prepare(source: SoldItemSource): Promise<Prepared | null>;
  create(
    trx: DbTransaction,
    prepared: Prepared,
  ): Promise<{ itemId: string; listingId: string | null }>;
}

export interface SaleOrderDependencies {
  db: Db;
  /** The worker's adapters, which the sale's auto-delist decides each listing's delist with. */
  adapters: AdapterLookup;
  logger: Logger;
  /** Makes sold items of the lines Listora has no listing for; without it, they are dropped. */
  soldItems?: SoldItemMaker;
}

/** The worker's side: records the order's sale once, and finishes its inbound event. */
export async function recordSaleOrder(
  deps: SaleOrderDependencies,
  payload: SaleOrderJobPayload,
): Promise<void> {
  const first = await inTransaction(deps.db, (trx) => settleOrder(deps, trx, payload, null));
  if (first === null) return;
  // No line is a listing Listora has: each becomes a sold item, its photos fetched first.
  const prepared: PreparedLine[] = [];
  for (const source of first) {
    const made = await deps.soldItems?.prepare(source);
    if (made !== null && made !== undefined) prepared.push({ priceCents: source.priceCents, made });
  }
  await inTransaction(deps.db, (trx) => settleOrder(deps, trx, payload, prepared));
}

/** An order line's sold item, ready to make, and what the line sold for. */
interface PreparedLine {
  priceCents: number;
  made: unknown;
}

/**
 * Records the order's sale and finishes its event, in one transaction; or, when no line is a
 * listing Listora has and `prepared` is null, the lines to make sold items of (the caller
 * prepares them and calls again with them).
 */
async function settleOrder(
  deps: SaleOrderDependencies,
  trx: DbTransaction,
  payload: SaleOrderJobPayload,
  prepared: readonly PreparedLine[] | null,
): Promise<SoldItemSource[] | null> {
  const event = await trx
    .selectFrom('inbound_event')
    .select(['id', 'marketplace', 'payload', 'processed_at'])
    .where('account_id', '=', payload.accountId)
    .where('id', '=', payload.inboundEventId)
    .forUpdate()
    .executeTakeFirst();
  // Finished before (the job ran again), or deleted with the account.
  if (event?.processed_at !== null) return null;

  const parsed = orderEventSchema.safeParse(event.payload);
  if (!parsed.success) {
    deps.logger.error(
      { inboundEventId: event.id, marketplace: event.marketplace },
      'an automated sale check stored an order Listora cannot read',
    );
    await finishInboundEvent(
      trx,
      payload.accountId,
      event.id,
      'failed',
      'Listora could not read this order.',
    );
    return null;
  }
  const order = parsed.data;
  const record = (lines: readonly SaleLine[], source: 'poll' | 'history') =>
    recordSale(
      trx,
      {
        accountId: payload.accountId,
        marketplace: event.marketplace,
        externalOrderId: order.externalOrderId,
        soldAt: new Date(order.soldAt),
        currency: order.items[0]?.currency ?? 'USD',
        // The order pages a sale check reads show no shipping charge.
        shippingChargedCents: 0,
        detectionSource: source,
        inboundEventId: event.id,
        saleCheckRunId: order.saleCheckRunId ?? null,
        shipBy: null,
        lines,
      },
      { adapters: deps.adapters },
    );
  const source = await detectedBy(trx, payload.accountId, order);
  let sale = await record(
    order.items.map((item) => ({
      externalListingId: item.externalListingId,
      externalSku: null,
      quantity: 1,
      priceCents: item.priceCents,
    })),
    source,
  );
  if (sale.type === 'not_listora' && deps.soldItems !== undefined) {
    if (prepared === null) return soldItemSources(payload.accountId, event.marketplace, order);
    const lines: SaleLine[] = [];
    for (const line of prepared) {
      const item = await deps.soldItems.create(trx, line.made);
      lines.push({ ...item, quantity: 1, priceCents: line.priceCents });
    }
    if (lines.length > 0) sale = await record(lines, source);
  }
  // The fees the marketplace showed take the place of the estimate.
  if (sale.type === 'recorded' && order.fees !== undefined) {
    await replaceWithActualFees(trx, payload.accountId, sale.saleId, order.fees);
  }
  // The marketplace says it shipped: the sale is shipped, as the seller would mark it.
  if (sale.type === 'recorded' && order.shipped === true) {
    await changeSale(trx, {
      accountId: payload.accountId,
      saleId: sale.saleId,
      action: 'mark_shipped',
      userId: null,
    });
  }
  await finishInboundEvent(
    trx,
    payload.accountId,
    event.id,
    sale.type === 'recorded' ? 'processed' : 'ignored',
  );
  // A new sale to pack: with Pack check on, its label is read from the order page now. A sale
  // that shipped, or one from the sales history, is never one to pack.
  if (
    sale.type === 'recorded' &&
    source === 'poll' &&
    order.shipped !== true &&
    (await isPackCheckEnabled(trx, payload.accountId))
  ) {
    await queueLabelReads(trx, {
      accountId: payload.accountId,
      marketplace: event.marketplace,
      now: new Date(),
    });
  }
  deps.logger.info(
    {
      inboundEventId: event.id,
      marketplace: event.marketplace,
      outcome: sale.type,
      detectionSource: source,
    },
    'automated sale check order recorded',
  );
  return null;
}

/**
 * How the sale was found: in the seller's sales history when it sold before the connection's
 * history ends (`sale_check_schedule.history_until`: when it was linked, or the deploy that
 * brought sales history in), otherwise by the sale check. A history sale is recorded only.
 */
async function detectedBy(
  trx: DbTransaction,
  accountId: string,
  order: OrderEvent,
): Promise<'poll' | 'history'> {
  if (order.connectionId === undefined) return 'poll';
  const schedule = await trx
    .selectFrom('sale_check_schedule')
    .select('history_until')
    .where('account_id', '=', accountId)
    .where('connection_id', '=', order.connectionId)
    .executeTakeFirst();
  return schedule !== undefined && new Date(order.soldAt) < schedule.history_until
    ? 'history'
    : 'poll';
}

function soldItemSources(
  accountId: string,
  marketplace: Marketplace,
  order: OrderEvent,
): SoldItemSource[] {
  return order.items.map((item) => ({
    accountId,
    connectionId: order.connectionId ?? null,
    marketplace,
    externalListingId: item.externalListingId,
    title: item.title ?? null,
    priceCents: item.priceCents,
    listing: item.listing ?? null,
  }));
}
