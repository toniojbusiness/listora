/**
 * The eBay notification endpoint's work (the API's `POST /webhooks/ebay`): verify, store,
 * acknowledge. eBay resends a notification until it gets a 2xx, so this answers fast and
 * leaves anything that calls eBay to the worker.
 *
 * 1. The `X-EBAY-SIGNATURE` must verify (`EbayNotificationVerifier`); a bad one is refused with
 *    `412`, as eBay's SDKs do, and nothing is stored. When eBay's key cannot be read now, the
 *    answer is `503`, so eBay delivers it again.
 * 2. `MARKETPLACE_ACCOUNT_DELETION` adds the purge job for that eBay user (purge.ts), whether
 *    or not Listora knows them; nothing about them is stored first.
 * 3. Other topics are about a seller: each Listora connection of that eBay user (one per
 *    account that connected them) gets the notification as an `inbound_event`, deduplicated by
 *    eBay's `notificationId`, in a transaction that also does or schedules its work:
 *    - `AUTHORIZATION_REVOCATION` flips the connection to `revoked` at once (no eBay call);
 *    - `ORDER_CONFIRMATION` and `LISTING` add an `ebay_notification` job (process.ts).
 *    A repeated delivery finds its event and changes nothing.
 * 4. Everything else (a topic Listora does not act on, a seller no account has connected, a
 *    signed payload Listora cannot read) is acknowledged and logged, so eBay stops resending it;
 *    the order poll still finds every sale.
 */
import { addJob, inTransaction, type Db, type DbExecutor, type JsonValue } from '@listora/db';
import { ebayRevocation, recordAuthorizationRevocation } from '@listora/connections';
import {
  InvalidEbayNotificationError,
  notificationUserId,
  parseAuthorizationRevocation,
  parseEbayNotification,
  type EbayNotification,
  type SignatureVerdict,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { finishInboundEvent, recordInboundEvent } from '../inbound.ts';
import { ebayUserDeletionJob } from './purge.ts';

/** The worker task that handles a stored `ORDER_CONFIRMATION` or `LISTING` notification. */
export const EBAY_NOTIFICATION_TASK = 'ebay_notification';

export interface EbayNotificationJobPayload {
  accountId: string;
  inboundEventId: string;
}

export function isEbayNotificationJobPayload(value: unknown): value is EbayNotificationJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, inboundEventId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof inboundEventId === 'string';
}

export interface NotificationVerifier {
  verify(
    body: string,
    signature: string | undefined,
    signal: AbortSignal,
  ): Promise<SignatureVerdict>;
}

/** The request's logger (Fastify's, in the API). */
export type NotificationLogger = Pick<Logger, 'warn' | 'error'>;

export interface ReceiveEbayNotificationDependencies {
  db: Db;
  verifier: NotificationVerifier;
  logger: NotificationLogger;
}

export interface ReceivedNotification {
  /** The exact request body. */
  body: string;
  signature: string | undefined;
}

/** The HTTP status to answer eBay with, and what happened (for the request log). */
export interface ReceiveResult {
  status: 204 | 400 | 412 | 503;
  outcome:
    | 'rejected_signature'
    | 'key_unavailable'
    | 'malformed'
    | 'unreadable'
    | 'unhandled_topic'
    | 'unknown_seller'
    | 'account_deletion'
    | 'stored'
    | 'duplicate';
  topic?: string;
}

export async function receiveEbayNotification(
  deps: ReceiveEbayNotificationDependencies,
  received: ReceivedNotification,
  signal: AbortSignal,
): Promise<ReceiveResult> {
  const verdict = await deps.verifier.verify(received.body, received.signature, signal);
  if (verdict.type === 'invalid') {
    deps.logger.warn({ reason: verdict.reason }, 'eBay notification refused: bad signature');
    return { status: 412, outcome: 'rejected_signature' };
  }
  if (verdict.type === 'unavailable') {
    deps.logger.warn(
      { code: verdict.code },
      "eBay notification not verified: eBay's public key is unavailable",
    );
    return { status: 503, outcome: 'key_unavailable' };
  }

  let payload: JsonValue;
  try {
    payload = JSON.parse(received.body) as JsonValue;
  } catch {
    return { status: 400, outcome: 'malformed' };
  }
  let notification: EbayNotification;
  try {
    notification = parseEbayNotification(payload);
  } catch (error) {
    if (!(error instanceof InvalidEbayNotificationError)) throw error;
    deps.logger.error(
      { err: error },
      'a signed eBay notification could not be read; acknowledged without action',
    );
    return { status: 204, outcome: 'unreadable' };
  }
  if (notification.topic === 'unhandled') {
    return { status: 204, outcome: 'unhandled_topic', topic: notification.ebayTopic };
  }
  const topic = notification.topic;
  const userId = notificationUserId(notification);
  if (userId === null) return { status: 204, outcome: 'unhandled_topic', topic };

  if (notification.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
    await addJob(deps.db, ebayUserDeletionJob(userId));
    return { status: 204, outcome: 'account_deletion', topic };
  }

  const connections = await deps.db
    .selectFrom('marketplace_connection')
    .select(['id', 'account_id'])
    .where('marketplace', '=', 'ebay')
    .where('mode', '=', 'api')
    .where('external_user_id', '=', userId)
    .execute();
  if (connections.length === 0) return { status: 204, outcome: 'unknown_seller', topic };

  let stored = false;
  for (const connection of connections) {
    const created = await inTransaction(deps.db, async (trx) => {
      const event = await recordInboundEvent(trx, {
        accountId: connection.account_id,
        source: 'ebay_webhook',
        marketplace: 'ebay',
        providerEventId: notification.notificationId,
        signatureOk: true,
        payload,
        externalUserId: userId,
      });
      if (event.duplicate) return false;
      await handleInTransaction(trx, notification, payload, connection.account_id, event.id);
      return true;
    });
    stored ||= created;
  }
  return { status: 204, outcome: stored ? 'stored' : 'duplicate', topic };
}

async function handleInTransaction(
  trx: DbExecutor,
  notification: Exclude<EbayNotification, { topic: 'unhandled' | 'MARKETPLACE_ACCOUNT_DELETION' }>,
  payload: JsonValue,
  accountId: string,
  inboundEventId: string,
): Promise<void> {
  switch (notification.topic) {
    case 'AUTHORIZATION_REVOCATION': {
      // Flips every connection of the seller (each account's); a repeat changes nothing.
      await recordAuthorizationRevocation(
        trx,
        ebayRevocation(parseAuthorizationRevocation(payload)),
      );
      await finishInboundEvent(trx, accountId, inboundEventId, 'processed');
      return;
    }
    case 'ORDER_CONFIRMATION':
    case 'LISTING': {
      const job: EbayNotificationJobPayload = { accountId, inboundEventId };
      await addJob(trx, {
        task: EBAY_NOTIFICATION_TASK,
        payload: { ...job },
        jobKey: `ebay-notification:${inboundEventId}`,
      });
      return;
    }
  }
}
