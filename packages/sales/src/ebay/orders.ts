/**
 * eBay orders as Listora sales. The webhook (`ORDER_CONFIRMATION`, which carries no prices) and
 * the poll backstop both end here with the order as Fulfillment `getOrder`/`getOrders` returns
 * it, so both record a sale the same way and the sale's order id deduplicates them.
 *
 * An order counts as a sale once its payment cleared (`PAID`, or `PARTIALLY_REFUNDED` later)
 * and it was not canceled. Listora keeps no buyer data: only the order id, the items' prices,
 * shipping charged, the sale time, and the ship-by date.
 */
import type { DbExecutor, JsonObject } from '@listora/db';
import type { EbayAmount, EbayOrder } from '@listora/marketplaces';
import type { CurrencyCode } from '@listora/shared';

import { finishInboundEvent, recordInboundEvent } from '../inbound.ts';
import { recordSale, type RecordSaleResult, type SaleLine } from '../sales.ts';

const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

export type EbayOrderResult =
  | RecordSaleResult
  /** Not a sale yet (payment pending or failed), or no longer one (canceled). */
  | { type: 'not_paid'; paymentStatus: string; cancelState: string | null }
  /** The order cannot be recorded as it is (a currency Listora does not record, bad amounts). */
  | { type: 'unrecordable'; reason: string }
  /** The poll handled this order before (its event and outcome are stored). */
  | { type: 'already_seen' };

/** Whether eBay's order is a completed sale. */
export function isPaidOrder(order: EbayOrder): boolean {
  return (
    PAID_STATUSES.has(order.orderPaymentStatus) &&
    order.cancelState !== 'CANCELED' &&
    order.cancelState !== 'CANCEL_CLOSED_WITH_REFUND'
  );
}

/**
 * Records a paid order as a sale, in the caller's transaction. `inboundEventId` is the event
 * that announced it (the webhook's), or `null` for the poll, which records its own event.
 */
export async function recordEbayOrder(
  executor: DbExecutor,
  input: {
    accountId: string;
    sellerUserId: string;
    order: EbayOrder;
    detection: { source: 'webhook'; inboundEventId: string } | { source: 'poll' };
  },
): Promise<EbayOrderResult> {
  const { order } = input;
  if (!isPaidOrder(order)) {
    return {
      type: 'not_paid',
      paymentStatus: order.orderPaymentStatus,
      cancelState: order.cancelState,
    };
  }
  const sale = saleOf(order);
  if ('reason' in sale) return { type: 'unrecordable', reason: sale.reason };

  let inboundEventId: string;
  if (input.detection.source === 'webhook') {
    inboundEventId = input.detection.inboundEventId;
  } else {
    const event = await recordInboundEvent(executor, {
      accountId: input.accountId,
      source: 'poll',
      marketplace: 'ebay',
      providerEventId: `order:${order.orderId}`,
      signatureOk: null,
      payload: orderSummary(order),
      externalUserId: input.sellerUserId,
    });
    // The poll handled this order before, in a transaction that also recorded its outcome.
    if (event.duplicate) return { type: 'already_seen' };
    inboundEventId = event.id;
  }

  const result = await recordSale(executor, {
    accountId: input.accountId,
    marketplace: 'ebay',
    externalOrderId: order.orderId,
    soldAt: sale.soldAt,
    currency: sale.currency,
    shippingChargedCents: sale.shippingCents,
    detectionSource: input.detection.source,
    inboundEventId,
    shipBy: sale.shipBy,
    lines: sale.lines,
  });
  if (input.detection.source === 'poll') {
    await finishInboundEvent(
      executor,
      input.accountId,
      inboundEventId,
      result.type === 'recorded' ? 'processed' : 'ignored',
    );
  }
  return result;
}

/** What Listora keeps of an order in its inbound event: no buyer, no address. */
export function orderSummary(order: EbayOrder): JsonObject {
  return {
    orderId: order.orderId,
    creationDate: order.creationDate,
    lastModifiedDate: order.lastModifiedDate,
    orderPaymentStatus: order.orderPaymentStatus,
    cancelState: order.cancelState,
    lineItems: order.lineItems.map((line) => ({
      lineItemId: line.lineItemId,
      legacyItemId: line.legacyItemId,
      sku: line.sku,
      quantity: line.quantity,
      lineItemCost:
        line.lineItemCost === null
          ? null
          : { value: line.lineItemCost.value, currency: line.lineItemCost.currency },
    })),
  };
}

function saleOf(order: EbayOrder):
  | {
      soldAt: Date;
      currency: CurrencyCode;
      shippingCents: number;
      shipBy: Date | null;
      lines: SaleLine[];
    }
  | { reason: string } {
  const soldAt = new Date(order.creationDate);
  if (Number.isNaN(soldAt.getTime())) return { reason: 'the order has no creation date' };
  const lines: SaleLine[] = [];
  let shipBy = null as Date | null;
  for (const line of order.lineItems) {
    const cost = line.lineItemCost === null ? null : usdCents(line.lineItemCost);
    if (cost === null) return { reason: 'an order line has no price in US dollars' };
    lines.push({
      externalListingId: line.legacyItemId === '' ? null : line.legacyItemId,
      externalSku: line.sku,
      quantity: line.quantity,
      priceCents: cost,
    });
    const lineShipBy = line.shipByDate === null ? null : new Date(line.shipByDate);
    if (lineShipBy !== null && !Number.isNaN(lineShipBy.getTime())) {
      shipBy = shipBy === null || lineShipBy < shipBy ? lineShipBy : shipBy;
    }
  }
  const shipping = order.deliveryCost === null ? 0 : usdCents(order.deliveryCost);
  if (shipping === null) return { reason: 'the shipping charge is not in US dollars' };
  return { soldAt, currency: 'USD', shippingCents: shipping, shipBy, lines };
}

/** An eBay amount in US cents; `null` for another currency or a malformed value. */
export function usdCents(amount: EbayAmount): number | null {
  if (amount.currency !== 'USD') return null;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount.value);
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
