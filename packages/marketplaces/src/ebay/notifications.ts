/**
 * eBay Commerce Notification payloads Listora reads. eBay POSTs each notification as JSON
 * (`metadata`, `notification`), signed in `X-EBAY-SIGNATURE`; verifying that signature and
 * subscribing to topics is the notifications task's (T-17), which hands verified payloads here.
 *
 * `AUTHORIZATION_REVOCATION` (asyncapi schema `AUTHORIZATION_REVOCATION.yaml`, read
 * 2026-10-24): a seller's authorization of Listora was revoked. `data.userId` is the immutable
 * user id; `data.username` may hold the user id instead for US users since 2025-09-26, so it is
 * never used to find the seller. `revokeReason` is `REVOKED_BY_APP`, `REVOKED_BY_USER`,
 * `REVOKED_BY_EBAY`, or `PASSWORD_CHANGE` (a password or user name change revokes the tokens).
 */
import { z } from 'zod';

export const AUTHORIZATION_REVOCATION_TOPIC = 'AUTHORIZATION_REVOCATION';

export const EBAY_REVOKE_REASONS = [
  'REVOKED_BY_APP',
  'REVOKED_BY_USER',
  'REVOKED_BY_EBAY',
  'PASSWORD_CHANGE',
] as const;
export type EbayRevokeReason = (typeof EBAY_REVOKE_REASONS)[number];

/** A revocation, as `@listora/connections` records it. */
export interface EbayAuthorizationRevocation {
  /** eBay's id of the notification, the same on every delivery attempt. */
  notificationId: string;
  /** The seller's immutable eBay user id. */
  externalUserId: string;
  /** A reason eBay added later reads as `REVOKED_BY_EBAY`: the grant is gone either way. */
  reason: EbayRevokeReason;
  revokedAt: Date;
}

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const revocationPayload = z.object({
  metadata: z.object({ topic: z.literal(AUTHORIZATION_REVOCATION_TOPIC) }),
  notification: z.object({
    notificationId: z.string().min(1).max(256),
    eventDate: timestamp.optional(),
    data: z.object({
      userId: z.string().min(1).max(256),
      revokeReason: z.string().max(64).optional(),
      revocationDate: timestamp.optional(),
    }),
  }),
});

export class InvalidNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNotificationError';
  }
}

/**
 * Reads a verified `AUTHORIZATION_REVOCATION` payload. Throws `InvalidNotificationError` for
 * another topic or a payload without the fields Listora needs. Without a revocation date, the
 * event date stands in.
 */
export function parseAuthorizationRevocation(payload: unknown): EbayAuthorizationRevocation {
  const parsed = revocationPayload.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidNotificationError('not an AUTHORIZATION_REVOCATION notification');
  }
  const { notificationId, eventDate, data } = parsed.data.notification;
  const date = data.revocationDate ?? eventDate;
  if (date === undefined) {
    throw new InvalidNotificationError('the revocation has no revocationDate or eventDate');
  }
  const reason = EBAY_REVOKE_REASONS.find((known) => known === data.revokeReason);
  return {
    notificationId,
    externalUserId: data.userId,
    reason: reason ?? 'REVOKED_BY_EBAY',
    revokedAt: new Date(date),
  };
}
