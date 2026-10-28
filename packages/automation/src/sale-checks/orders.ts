/**
 * Turning the orders an automated sale check found into sales (decision D1). The browser runner
 * stores each new order as an `inbound_event` (source `poll`, once per order) and queues
 * `automation_sale_order` for it in the same transaction. The worker runs that job: it records
 * the sale with `recordSale` (@listora/sales), which starts the sale's auto-delist, and finishes
 * the event `processed` (a sale was recorded) or `ignored` (no line is a Listora listing, or the
 * sale was recorded before).
 *
 * The runner hands the sale over instead of recording it, because the auto-delist fan-out
 * decides from each listing's capabilities whether it is marked sold or ended, and only the
 * worker's adapters include the API adapters (eBay, Depop) that decide it.
 */
import { z } from 'zod';

import { addJob, inTransaction, type Db, type DbExecutor } from '@listora/db';
import type { AdapterLookup, RemoteOrder } from '@listora/marketplaces';
import { isPackCheckEnabled } from '@listora/pack-check';
import { finishInboundEvent, recordSale } from '@listora/sales';
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
    items: order.items.map((item) => ({
      externalListingId: item.externalListingId,
      title: item.title,
      priceCents: item.priceCents,
      currency: item.currency,
    })),
  };
}

const orderEventSchema = z.object({
  saleCheckRunId: z.uuid().optional(),
  externalOrderId: z.string().min(1),
  soldAt: z.iso.datetime(),
  items: z.array(
    z.object({
      externalListingId: z.string().nullable(),
      priceCents: z.number().int().nonnegative(),
      currency: z.literal('USD'),
    }),
  ),
});

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

export interface SaleOrderDependencies {
  db: Db;
  /** The worker's adapters, which the sale's auto-delist decides each listing's delist with. */
  adapters: AdapterLookup;
  logger: Logger;
}

/** The worker's side: records the order's sale once, and finishes its inbound event. */
export async function recordSaleOrder(
  deps: SaleOrderDependencies,
  payload: SaleOrderJobPayload,
): Promise<void> {
  await inTransaction(deps.db, async (trx) => {
    const event = await trx
      .selectFrom('inbound_event')
      .select(['id', 'marketplace', 'payload', 'processed_at'])
      .where('account_id', '=', payload.accountId)
      .where('id', '=', payload.inboundEventId)
      .forUpdate()
      .executeTakeFirst();
    // Finished before (the job ran again), or deleted with the account.
    if (event?.processed_at !== null) return;

    const order = orderEventSchema.safeParse(event.payload);
    if (!order.success) {
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
      return;
    }
    const sale = await recordSale(
      trx,
      {
        accountId: payload.accountId,
        marketplace: event.marketplace,
        externalOrderId: order.data.externalOrderId,
        soldAt: new Date(order.data.soldAt),
        currency: order.data.items[0]?.currency ?? 'USD',
        // The order pages a sale check reads show no shipping charge.
        shippingChargedCents: 0,
        detectionSource: 'poll',
        inboundEventId: event.id,
        saleCheckRunId: order.data.saleCheckRunId ?? null,
        shipBy: null,
        lines: order.data.items.map((item) => ({
          externalListingId: item.externalListingId,
          externalSku: null,
          quantity: 1,
          priceCents: item.priceCents,
        })),
      },
      { adapters: deps.adapters },
    );
    await finishInboundEvent(
      trx,
      payload.accountId,
      event.id,
      sale.type === 'recorded' ? 'processed' : 'ignored',
    );
    // A new sale to pack: with Pack check on, its label is read from the order page now.
    if (sale.type === 'recorded' && (await isPackCheckEnabled(trx, payload.accountId))) {
      await queueLabelReads(trx, {
        accountId: payload.accountId,
        marketplace: event.marketplace,
        now: new Date(),
      });
    }
    deps.logger.info(
      { inboundEventId: event.id, marketplace: event.marketplace, outcome: sale.type },
      'automated sale check order recorded',
    );
  });
}
