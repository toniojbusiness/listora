/**
 * Depop webhooks (https://partnerapi.depop.com/api-docs/concepts/webhooks/ and
 * /how-to-guides/validate-webhooks/, checked 2026-10-24): verifying `X-Depop-Signature` and
 * reading the events Listora acts on.
 *
 * - **Signature.** "This header contains a HMAC-SHA256 signature of the timestamp and body of
 *   the request, separated by a dot: <timestamp>.<body>", hex, keyed with the secret the webhook
 *   configuration returned, and computed "over the original, unmodified request body". The
 *   timestamp (seconds) also comes in `X-Depop-Timestamp`; a delivery older or newer than the
 *   tolerance is refused, against replays. Comparison is constant-time.
 * - **Events.** `v1:order.new`, `v1:order.update`, `v1:order.refund`, `v1:product.create`,
 *   `v1:product.update`, `v1:product.like`, `v1:product.unlike`; anything else is `unknown`, so a
 *   new event type is acknowledged and ignored rather than failing the delivery.
 * - **Deduplication.** "For the order webhooks ... the id is derived from the purchase ID ...
 *   Combine it with event_type and created_at if you need to de-duplicate", which
 *   `providerEventId` does.
 * - Delivery is "best-effort", so sales are also reconciled by polling the orders endpoint.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { depopOrderWebhookSchema, type DepopOrder } from './orders.ts';
import { depopProductSchema, type DepopProduct } from './product.ts';

export const DEPOP_SIGNATURE_HEADER = 'x-depop-signature';
export const DEPOP_TIMESTAMP_HEADER = 'x-depop-timestamp';

/** How far a delivery's timestamp may be from now: five minutes. */
export const DEPOP_WEBHOOK_TOLERANCE_SECONDS = 300;

/** `X-Depop-Signature` for a body sent at `timestamp` (seconds), as Depop computes it. */
export function depopWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

export type DepopSignatureCheck =
  { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' };

/** Checks a delivery's signature and age. `rawBody` is the body exactly as received. */
export function verifyDepopWebhook(options: {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  /** Epoch milliseconds. */
  now: number;
  toleranceSeconds?: number;
}): DepopSignatureCheck {
  const { signature, timestamp } = options;
  if (signature === undefined || timestamp === undefined) return { ok: false, reason: 'missing' };
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = Buffer.from(
    depopWebhookSignature(options.secret, timestamp, options.rawBody),
    'hex',
  );
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    return { ok: false, reason: 'mismatch' };
  }
  const ageSeconds = Math.abs(options.now / 1000 - Number(timestamp));
  if (ageSeconds > (options.toleranceSeconds ?? DEPOP_WEBHOOK_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true };
}

export type DepopWebhookEvent = { providerEventId: string; createdAt: string } & (
  | { type: 'order_new' | 'order_update'; order: DepopOrder }
  | { type: 'order_refund'; purchaseId: string; refundedBy: 'PARTNER' | 'DEPOP' }
  | { type: 'product_create' | 'product_update'; sellerId: number; product: DepopProduct }
  | {
      type: 'product_like' | 'product_unlike';
      sellerId: number;
      productId: number;
      sku: string | null;
      slug: string;
    }
  | { type: 'unknown'; eventType: string }
);

const envelopeSchema = z.object({
  id: z.string().min(1).max(100),
  event_type: z.string().min(1).max(100),
  created_at: z.string().min(1).max(50),
  data: z.unknown(),
});

const refundSchema = z.object({
  purchase_id: z.string().min(1),
  refunded_by: z.enum(['PARTNER', 'DEPOP']),
});
const productEventSchema = z.object({ seller_id: z.number(), product: depopProductSchema });
const likeSchema = z.object({
  seller_id: z.number(),
  product_id: z.number(),
  sku: z.string().nullable().optional(),
  slug: z.string(),
});

export class DepopWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepopWebhookError';
  }
}

/**
 * Reads a verified delivery's body. Throws `DepopWebhookError` for a body that isn't a Depop
 * event of the shape its type promises.
 */
export function parseDepopWebhook(rawBody: string): DepopWebhookEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody) as unknown;
  } catch {
    throw new DepopWebhookError('the body is not JSON');
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) throw new DepopWebhookError('the body is not a Depop webhook');
  const { id, event_type: eventType, created_at: createdAt, data } = envelope.data;
  const base = { providerEventId: `${id}:${eventType}:${createdAt}`, createdAt };
  const read = <T>(schema: z.ZodType<T>): T => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new DepopWebhookError(`${eventType} has an unexpected payload`);
    return parsed.data;
  };
  switch (eventType) {
    case 'v1:order.new':
    case 'v1:order.update':
      return {
        ...base,
        type: eventType === 'v1:order.new' ? 'order_new' : 'order_update',
        order: read(depopOrderWebhookSchema),
      };
    case 'v1:order.refund': {
      const refund = read(refundSchema);
      return {
        ...base,
        type: 'order_refund',
        purchaseId: refund.purchase_id,
        refundedBy: refund.refunded_by,
      };
    }
    case 'v1:product.create':
    case 'v1:product.update': {
      const event = read(productEventSchema);
      return {
        ...base,
        type: eventType === 'v1:product.create' ? 'product_create' : 'product_update',
        sellerId: event.seller_id,
        product: event.product,
      };
    }
    case 'v1:product.like':
    case 'v1:product.unlike': {
      const like = read(likeSchema);
      return {
        ...base,
        type: eventType === 'v1:product.like' ? 'product_like' : 'product_unlike',
        sellerId: like.seller_id,
        productId: like.product_id,
        sku: like.sku ?? null,
        slug: like.slug,
      };
    }
    default:
      return { ...base, type: 'unknown', eventType };
  }
}

export type DepopWebhookReceipt =
  | { ok: true; event: DepopWebhookEvent }
  | { ok: false; reason: Exclude<DepopSignatureCheck, { ok: true }>['reason'] | 'unreadable' };

/**
 * Verifies a delivery and reads it: what the inbound endpoint does with each request. Headers
 * are matched case-insensitively. Nothing in a delivery is trusted before its signature checks.
 */
export function receiveDepopWebhook(options: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: string;
  secret: string;
  now: number;
  toleranceSeconds?: number;
}): DepopWebhookReceipt {
  const header = (name: string): string | undefined => {
    const entry = Object.entries(options.headers).find(([key]) => key.toLowerCase() === name);
    const value = entry?.[1];
    return Array.isArray(value) ? value[0] : value;
  };
  const check = verifyDepopWebhook({
    rawBody: options.rawBody,
    signature: header(DEPOP_SIGNATURE_HEADER),
    timestamp: header(DEPOP_TIMESTAMP_HEADER),
    secret: options.secret,
    now: options.now,
    ...(options.toleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: options.toleranceSeconds }),
  });
  if (!check.ok) return check;
  try {
    return { ok: true, event: parseDepopWebhook(options.rawBody) };
  } catch (error) {
    if (error instanceof DepopWebhookError) return { ok: false, reason: 'unreadable' };
    throw error;
  }
}
