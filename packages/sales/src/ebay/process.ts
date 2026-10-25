/**
 * The worker's side of a stored eBay notification (`ebay_notification` jobs from receive.ts):
 *
 * - `ORDER_CONFIRMATION` carries no prices, so the order is read with the seller's token
 *   (Fulfillment `getOrder`) and recorded as a sale (orders.ts), which hands it to auto-delist.
 *   The sold listings are also read back (`listing_resync`), so their status comes from eBay.
 * - `LISTING` (created, updated, ended) reads the listing back the same way, so a change the
 *   seller made on eBay itself (Seller Hub, the eBay app) reaches Listora: the drift resync.
 *
 * An event is finished once, with what happened. Outages throw, so the queue runs the job again
 * with backoff; an order eBay cannot show yet waits the same way. A seller who has to reconnect
 * fails the event with that reason: the order poll records the sale once they reconnect, since
 * it reads every order changed since its last successful poll.
 */
import { inTransaction, type Db } from '@listora/db';
import type { AccessTokenResult } from '@listora/connections';
import {
  getOrder,
  parseEbayNotification,
  type EbayOrder,
  type RestEndpoints,
} from '@listora/marketplaces';
import { enqueueListingResync } from '@listora/operations';
import type { Logger } from '@listora/shared';

import { finishInboundEvent } from '../inbound.ts';
import { recordEbayOrder } from './orders.ts';
import type { EbayNotificationJobPayload } from './receive.ts';

/** A connection's access token (`ConnectionTokens` in `@listora/connections`). */
export interface SellerTokens {
  accessToken(connectionId: string, signal?: AbortSignal): Promise<AccessTokenResult>;
  invalidate(connectionId: string, accessToken: string): Promise<void>;
}

export interface EbaySyncDependencies {
  db: Db;
  endpoints: Pick<RestEndpoints, 'api'>;
  tokens: SellerTokens;
  logger: Logger;
  /** One eBay call's timeout (default 15 s). */
  timeoutMs?: number;
}

/** Thrown for a condition that clears by itself; the queue runs the job again later. */
export class EbaySyncRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbaySyncRetryError';
  }
}

export type NotificationProcessing =
  | 'sale_recorded'
  | 'sale_duplicate'
  | 'not_listora'
  | 'not_a_sale'
  | 'resync_scheduled'
  | 'listing_unknown'
  | 'connection_gone'
  | 'reauth_required'
  | 'already_processed';

export async function processEbayNotification(
  deps: EbaySyncDependencies,
  job: EbayNotificationJobPayload,
  signal: AbortSignal,
): Promise<NotificationProcessing> {
  const event = await deps.db
    .selectFrom('inbound_event')
    .select(['id', 'payload', 'external_user_id', 'processed_at'])
    .where('account_id', '=', job.accountId)
    .where('id', '=', job.inboundEventId)
    .executeTakeFirst();
  // Finished before, or purged with its eBay user.
  if (event?.processed_at !== null) return 'already_processed';
  const finish = (
    result: 'processed' | 'ignored' | 'failed',
    outcome: NotificationProcessing,
    message: string | null = null,
  ): Promise<NotificationProcessing> =>
    finishInboundEvent(deps.db, job.accountId, event.id, result, message).then(() => outcome);

  const notification = parseEbayNotification(event.payload);
  const connection = await deps.db
    .selectFrom('marketplace_connection')
    .select(['id'])
    .where('account_id', '=', job.accountId)
    .where('marketplace', '=', 'ebay')
    .where('mode', '=', 'api')
    .where('external_user_id', '=', event.external_user_id)
    .executeTakeFirst();
  if (connection === undefined) return finish('ignored', 'connection_gone');

  switch (notification.topic) {
    case 'ORDER_CONFIRMATION': {
      const order = await readOrder(deps, connection.id, notification.orderId, signal);
      if (order === 'reauth_required') {
        return finish(
          'failed',
          'reauth_required',
          "eBay no longer accepts Listora's access, so the order could not be read. Reconnect eBay; the sale is recorded once you do.",
        );
      }
      return inTransaction(deps.db, async (trx) => {
        const result = await recordEbayOrder(trx, {
          accountId: job.accountId,
          sellerUserId: event.external_user_id ?? '',
          order,
          detection: { source: 'webhook', inboundEventId: event.id },
        });
        let outcome: NotificationProcessing;
        switch (result.type) {
          case 'recorded':
            for (const line of order.lineItems) {
              await resyncSoldListing(trx, job.accountId, line.legacyItemId);
            }
            outcome = 'sale_recorded';
            break;
          case 'duplicate':
          case 'already_seen':
            outcome = 'sale_duplicate';
            break;
          case 'not_listora':
            outcome = 'not_listora';
            break;
          case 'not_paid':
            if (!result.cancelState?.startsWith('CANCEL')) {
              // eBay sent the confirmation, so payment cleared; its order view is behind.
              throw new EbaySyncRetryError(`order payment shows ${result.paymentStatus} so far`);
            }
            outcome = 'not_a_sale';
            break;
          case 'unrecordable':
            await finishInboundEvent(trx, job.accountId, event.id, 'failed', result.reason);
            return 'not_a_sale';
        }
        await finishInboundEvent(
          trx,
          job.accountId,
          event.id,
          outcome === 'sale_recorded' ? 'processed' : 'ignored',
        );
        return outcome;
      });
    }
    case 'LISTING': {
      return inTransaction(deps.db, async (trx) => {
        const scheduled = await resyncSoldListing(trx, job.accountId, notification.listingId);
        await finishInboundEvent(trx, job.accountId, event.id, scheduled ? 'processed' : 'ignored');
        return scheduled ? 'resync_scheduled' : 'listing_unknown';
      });
    }
    case 'AUTHORIZATION_REVOCATION':
    case 'MARKETPLACE_ACCOUNT_DELETION':
    case 'unhandled':
      // Handled when received (receive.ts); never stored for this job.
      return finish('ignored', 'already_processed');
  }
}

/** Schedules a read-back of the account's listing with this eBay listing id, if it has one. */
async function resyncSoldListing(
  trx: Parameters<typeof enqueueListingResync>[0],
  accountId: string,
  ebayListingId: string,
): Promise<boolean> {
  if (ebayListingId === '') return false;
  const listing = await trx
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', accountId)
    .where('marketplace', '=', 'ebay')
    .where((eb) =>
      eb.or([
        eb('external_listing_id', '=', ebayListingId),
        eb('pending_external_listing_id', '=', ebayListingId),
      ]),
    )
    .executeTakeFirst();
  if (listing === undefined) return false;
  await enqueueListingResync(trx, { accountId, listingId: listing.id });
  return true;
}

/** The order, read with the seller's token; refreshes once when eBay refuses the token. */
export async function readOrder(
  deps: EbaySyncDependencies,
  connectionId: string,
  orderId: string,
  signal: AbortSignal,
): Promise<EbayOrder | 'reauth_required'> {
  for (let attempt = 1; ; attempt += 1) {
    const token = await deps.tokens.accessToken(connectionId, signal);
    if (token.type === 'reauth_required') return 'reauth_required';
    if (token.type === 'unavailable') {
      throw new EbaySyncRetryError(`the seller's eBay token is unavailable (${token.code})`);
    }
    const result = await getOrder(deps.endpoints, orderId, {
      token: token.accessToken,
      signal,
      timeoutMs: deps.timeoutMs ?? 15_000,
    });
    if (result.type === 'ok') {
      if (result.value === null) throw new EbaySyncRetryError('eBay does not show the order yet');
      return result.value;
    }
    if (result.type === 'error' && result.status === 401 && attempt === 1) {
      await deps.tokens.invalidate(connectionId, token.accessToken);
      continue;
    }
    throw new EbaySyncRetryError(
      `eBay's order could not be read (${result.type === 'error' ? `http_${String(result.status)}` : result.code})`,
    );
  }
}
