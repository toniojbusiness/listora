/**
 * Depop orders, from the orders endpoints (`GET /api/v1/orders/`, the poll that reconciles
 * webhooks: "This endpoint must be used to reconcile the orders you have received via
 * webhooks") and from the `v1:order.new` and `v1:order.update` webhooks (webhooks.ts), read
 * into one shape. Amounts are integer cents; an amount Depop sends that isn't a decimal makes
 * the order unreadable rather than wrong.
 */
import type { FeeKind } from '@listora/db';
import { z } from 'zod';

import type { OrderFee } from '../adapter.ts';

import { depopCents } from './payload.ts';

/** `Order.status`; the webhook payload adds `FAILED` (a failed delivery). */
export const DEPOP_ORDER_STATUSES = [
  'SHIPPING_PENDING',
  'SHIPPED',
  'REFUNDED',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
] as const;
export type DepopOrderStatus = (typeof DEPOP_ORDER_STATUSES)[number];

export interface DepopOrderLine {
  purchaseItemId: number;
  /** The product's SKU: Listora's listing id for a listing it made; `null` without one. */
  sku: string | null;
  productId: number;
  /** The product's slug: Listora's listing id for a listing linked from a share. */
  slug: string;
  soldPriceCents: number;
  originalPriceCents: number;
  soldViaOffers: boolean;
}

export interface DepopOrder {
  purchaseId: string;
  sellerId: number;
  status: DepopOrderStatus;
  currency: string;
  buyerPaysCents: number;
  sellerReceivesCents: number;
  buyerShippingCents: number;
  /** Order time (ISO 8601); the webhooks don't carry it. */
  createdAt: string | null;
  lines: DepopOrderLine[];
  /** `seller_fee_breakdown`; the webhooks carry only the total (`feeTotalCents`). */
  fees: { type: string; amountCents: number; currency: string }[];
  feeTotalCents: number | null;
}

const amount = z.string().transform((value, ctx) => {
  const cents = depopCents(value);
  if (cents === null) {
    ctx.addIssue({ code: 'custom', message: 'not a decimal amount' });
    return z.NEVER;
  }
  return cents;
});

const lineSchema = z.object({
  purchase_item_id: z.number(),
  sku: z.string().nullable().optional(),
  product_id: z.number(),
  slug: z.string(),
  original_price: amount,
  sold_price: amount,
  sold_via_offers: z.boolean(),
});

const orderFields = {
  seller_id: z.number(),
  purchase_id: z.string().min(1),
  status: z.enum(DEPOP_ORDER_STATUSES),
  currency: z.string().min(1),
  buyer_pays_amount: amount,
  seller_receives_amount: amount,
  buyer_shipping_price: amount,
  line_items: z.array(lineSchema),
};

/** `Order` (the orders endpoints). */
export const depopOrderSchema = z
  .object({
    ...orderFields,
    seller_fee_breakdown: z.array(z.object({ fee_type: z.string(), amount, currency: z.string() })),
    created_at: z.string(),
  })
  .transform((order): DepopOrder => ({
    ...common(order),
    createdAt: order.created_at,
    fees: order.seller_fee_breakdown.map((fee) => ({
      type: fee.fee_type,
      amountCents: fee.amount,
      currency: fee.currency,
    })),
    feeTotalCents: null,
  }));

/** `OrderWebhook` (the `v1:order.new` and `v1:order.update` webhooks). */
export const depopOrderWebhookSchema = z
  .object({ ...orderFields, fee_amount: amount })
  .transform((order): DepopOrder => ({
    ...common(order),
    createdAt: null,
    fees: [],
    feeTotalCents: order.fee_amount,
  }));

/** `OrdersPage`. */
export const depopOrdersPageSchema = z.object({
  meta: z.object({ cursor: z.string().nullable().optional(), has_more: z.boolean().optional() }),
  data: z.array(depopOrderSchema),
});

export interface DepopOrdersPage {
  orders: DepopOrder[];
  /** Pass it back for the next page; `null` when there is none. */
  cursor: string | null;
}

export function parseDepopOrdersPage(body: unknown): DepopOrdersPage | null {
  const page = depopOrdersPageSchema.safeParse(body);
  if (!page.success) return null;
  const { cursor, has_more: hasMore } = page.data.meta;
  return {
    orders: page.data.data,
    cursor: hasMore === true && typeof cursor === 'string' && cursor !== '' ? cursor : null,
  };
}

function common(order: {
  seller_id: number;
  purchase_id: string;
  status: DepopOrderStatus;
  currency: string;
  buyer_pays_amount: number;
  seller_receives_amount: number;
  buyer_shipping_price: number;
  line_items: z.infer<typeof lineSchema>[];
}): Omit<DepopOrder, 'createdAt' | 'fees' | 'feeTotalCents'> {
  return {
    purchaseId: order.purchase_id,
    sellerId: order.seller_id,
    status: order.status,
    currency: order.currency,
    buyerPaysCents: order.buyer_pays_amount,
    sellerReceivesCents: order.seller_receives_amount,
    buyerShippingCents: order.buyer_shipping_price,
    lines: order.line_items.map((line) => ({
      purchaseItemId: line.purchase_item_id,
      sku: line.sku ?? null,
      productId: line.product_id,
      slug: line.slug,
      soldPriceCents: line.sold_price,
      originalPriceCents: line.original_price,
      soldViaOffers: line.sold_via_offers,
    })),
  };
}

/** Depop's fee types and the `fee_line` kind each one is. */
const DEPOP_FEE_KINDS: Record<string, { kind: FeeKind; description: string }> = {
  DEPOP_FEE: { kind: 'marketplace', description: 'Depop fee' },
  PAYMENT_FEE: { kind: 'payment', description: 'Payment processing fee' },
  SHIPPING_FEE: { kind: 'shipping_label', description: 'Depop shipping' },
  BOOSTING_FEE: { kind: 'promotion', description: 'Boosting fee' },
};

/**
 * An order's `seller_fee_breakdown` as Listora's fee lines; `null` when a fee is in another
 * currency than the order or the breakdown is missing (the webhooks carry only the total).
 * Zero amounts are left out.
 */
export function depopOrderFees(order: DepopOrder): OrderFee[] | null {
  if (order.createdAt === null || order.currency !== 'USD') return null;
  const fees: OrderFee[] = [];
  for (const fee of order.fees) {
    if (fee.currency !== order.currency) return null;
    if (fee.amountCents === 0) continue;
    const known = DEPOP_FEE_KINDS[fee.type];
    fees.push({
      kind: known?.kind ?? 'other',
      description: known?.description ?? `Depop ${fee.type.toLowerCase().replaceAll('_', ' ')}`,
      amountCents: fee.amountCents,
      currency: 'USD',
    });
  }
  return fees;
}
