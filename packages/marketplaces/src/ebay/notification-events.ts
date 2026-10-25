/**
 * eBay Commerce Notification payloads Listora acts on, read after the signature is verified
 * (notification-signature.ts). Every notification is `{ metadata, notification }`; the topic's
 * `data` follows its asyncapi schema at
 * `https://developer.ebay.com/develop/api/spec/events/<TOPIC>.yaml` (read 2026-10-24):
 *
 * - `ORDER_CONFIRMATION`: the buyer completed checkout and payment cleared. `data.user` is the
 *   seller, `data.order` has `orderId` and `orderLineItems[]` (`orderLineItemId`, `listingId`,
 *   `quantity`). It carries no prices: eBay says to look the order up (Fulfillment `getOrder`).
 *   A checkout whose payment failed and then succeeded sends it again.
 * - `LISTING`: one of the seller's listings was `CREATED`, `UPDATED`, or `ENDED`
 *   (`data.listingId`, `data.reason`, `data.user`).
 * - `MARKETPLACE_ACCOUNT_DELETION`: an eBay user asked eBay to delete their data and close their
 *   account (`data.userId`, `data.username`, `data.eiasToken`); Listora must delete everything
 *   it holds about them.
 * - `AUTHORIZATION_REVOCATION`: notifications.ts.
 *
 * `userId` is eBay's immutable user id. `username` may hold the user id instead for US users
 * since 2025-09-26, so a user is only ever found by `userId`.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

export const EBAY_NOTIFICATION_TOPICS = [
  'ORDER_CONFIRMATION',
  'LISTING',
  'AUTHORIZATION_REVOCATION',
  'MARKETPLACE_ACCOUNT_DELETION',
] as const;
export type EbayNotificationTopic = (typeof EBAY_NOTIFICATION_TOPICS)[number];

export const EBAY_LISTING_REASONS = ['CREATED', 'UPDATED', 'ENDED'] as const;
export type EbayListingReason = (typeof EBAY_LISTING_REASONS)[number];

/** The envelope fields every notification has. */
export interface EbayNotificationEnvelope {
  /** eBay's id of the notification, the same on every delivery attempt. */
  notificationId: string;
  topic: EbayNotificationTopic;
  schemaVersion: string;
  /** When the event happened (eBay's `eventDate`); the publish date when absent. */
  eventDate: Date;
}

export type EbayNotification =
  | (EbayNotificationEnvelope & {
      topic: 'ORDER_CONFIRMATION';
      sellerUserId: string;
      orderId: string;
      lines: { lineItemId: string; listingId: string; quantity: number }[];
    })
  | (EbayNotificationEnvelope & {
      topic: 'LISTING';
      sellerUserId: string;
      listingId: string;
      reason: EbayListingReason;
    })
  | (EbayNotificationEnvelope & { topic: 'MARKETPLACE_ACCOUNT_DELETION'; userId: string })
  | (EbayNotificationEnvelope & { topic: 'AUTHORIZATION_REVOCATION'; userId: string })
  /** A topic Listora does not act on (`metadata.topic` is in `ebayTopic`). */
  | (Omit<EbayNotificationEnvelope, 'topic'> & {
      topic: 'unhandled';
      ebayTopic: string;
      userId: null;
    });

export class InvalidEbayNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEbayNotificationError';
  }
}

const id = z.string().min(1).max(256);
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const envelope = z.object({
  metadata: z.object({ topic: z.string().min(1).max(128), schemaVersion: z.string().max(32) }),
  notification: z.object({
    notificationId: id,
    eventDate: timestamp.optional(),
    publishDate: timestamp.optional(),
    data: z.record(z.string(), z.unknown()),
  }),
});

const user = z.object({ userId: id });

const orderConfirmation = z.object({
  user,
  order: z.object({
    orderId: id,
    orderLineItems: z
      .array(
        z.object({
          orderLineItemId: id,
          listingId: id,
          quantity: z.number().int().positive().optional(),
        }),
      )
      .max(500)
      .default([]),
  }),
});

const listing = z.object({ user, listingId: id, reason: z.enum(EBAY_LISTING_REASONS) });

const userData = z.object({ userId: id });

/**
 * Reads a verified notification. Throws `InvalidEbayNotificationError` when the envelope, or
 * the data of a topic Listora acts on, lacks what Listora needs. Other topics read as
 * `unhandled`, so the caller can acknowledge and ignore them.
 */
export function parseEbayNotification(payload: unknown): EbayNotification {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) throw new InvalidEbayNotificationError('not an eBay notification');
  const { metadata, notification } = parsed.data;
  const date = notification.eventDate ?? notification.publishDate;
  if (date === undefined) {
    throw new InvalidEbayNotificationError('the notification has no eventDate or publishDate');
  }
  const base = {
    notificationId: notification.notificationId,
    schemaVersion: metadata.schemaVersion,
    eventDate: new Date(date),
  };
  const data = notification.data;
  const read = <T>(schema: z.ZodType<T>): T => {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new InvalidEbayNotificationError(`the ${metadata.topic} data is incomplete`);
    }
    return result.data;
  };
  switch (metadata.topic) {
    case 'ORDER_CONFIRMATION': {
      const { user: seller, order } = read(orderConfirmation);
      return {
        ...base,
        topic: 'ORDER_CONFIRMATION',
        sellerUserId: seller.userId,
        orderId: order.orderId,
        lines: order.orderLineItems.map((line) => ({
          lineItemId: line.orderLineItemId,
          listingId: line.listingId,
          quantity: line.quantity ?? 1,
        })),
      };
    }
    case 'LISTING': {
      const event = read(listing);
      return {
        ...base,
        topic: 'LISTING',
        sellerUserId: event.user.userId,
        listingId: event.listingId,
        reason: event.reason,
      };
    }
    case 'MARKETPLACE_ACCOUNT_DELETION':
    case 'AUTHORIZATION_REVOCATION':
      return { ...base, topic: metadata.topic, userId: read(userData).userId };
    default:
      return { ...base, topic: 'unhandled', ebayTopic: metadata.topic, userId: null };
  }
}

/** The eBay user a notification is about, or `null` for a topic Listora does not act on. */
export function notificationUserId(notification: EbayNotification): string | null {
  return 'sellerUserId' in notification ? notification.sellerUserId : notification.userId;
}

// The endpoint's challenge ---------------------------------------------------------------------

/**
 * eBay checks a notification endpoint before it delivers to it (when the destination is
 * created or changed, and for Marketplace Account Deletion when its endpoint is saved): it
 * sends `GET <endpoint>?challenge_code=...` and expects `200` with
 * `{"challengeResponse": "<hex SHA-256>"}` as `application/json`, the hash taken over
 * challengeCode + verificationToken + endpoint, in that order
 * (developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion, read 2026-10-24).
 * `endpoint` is the exact URL registered with eBay.
 */
export function ebayChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): string {
  return createHash('sha256')
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest('hex');
}

/** eBay's rule for a destination's verification token: 32 to 80 of `[A-Za-z0-9_-]`. */
export const EBAY_VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,80}$/;
