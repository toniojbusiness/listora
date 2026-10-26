/**
 * eBay Marketplace Account Deletion: when an eBay user asks eBay to delete their data, every
 * application must "remove all user data associated with the eBay user", irreversibly
 * (developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion, read 2026-10-24).
 * The notification adds one `ebay_user_deletion` job per eBay user (receive.ts), and the job
 * deletes, in one transaction, everything Listora holds that identifies them or came from
 * their eBay account:
 *
 * - every `marketplace_connection` to that eBay user, in every account, with the data that came
 *   through it (`deleteConnectionData`, the same deletion as unlinking): their encrypted OAuth
 *   tokens, eBay user id, and user name, the eBay listing snapshots read back under it
 *   (`remote_snapshot`), and the listings' link to it, so nothing can act for the deleted user
 *   again (connect attempts that point at it lose the link);
 * - every eBay `inbound_event` about them, in every account (webhook payloads name them; poll
 *   events too).
 *
 * In the same transaction it checks that no connection or event names them any more and writes
 * the deletion's completion record (`deletion_record`, counts only). Their grant needs no
 * revocation: eBay deleted the user. A grant of theirs that an earlier unlink or account
 * deletion still holds for revocation is deleted by that job within its 7-day window.
 *
 * The Listora account's own inventory, listing history, and sales stay: they are the Listora
 * user's records, not the eBay user's data, and sales are kept for tax records. Listora never
 * stores buyer data, so a buyer's deletion finds nothing. Database backups expire with their
 * retention period. The job is idempotent: a repeat finds nothing and deletes nothing.
 */
import { randomUUID } from 'node:crypto';

import { deleteConnectionData } from '@listora/connections';
import { inTransaction, recordDeletion, type BackgroundJob, type Db } from '@listora/db';
import type { Logger } from '@listora/shared';

export const EBAY_USER_DELETION_TASK = 'ebay_user_deletion';

export interface EbayUserDeletionPayload {
  /** eBay's immutable user id from the notification. */
  ebayUserId: string;
}

export function isEbayUserDeletionPayload(value: unknown): value is EbayUserDeletionPayload {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['ebayUserId'] === 'string';
}

/** The purge job for one eBay user; one pending job per user however often eBay sends it. */
export function ebayUserDeletionJob(ebayUserId: string): BackgroundJob {
  const payload: EbayUserDeletionPayload = { ebayUserId };
  return {
    task: EBAY_USER_DELETION_TASK,
    payload: { ...payload },
    jobKey: `ebay-user-deletion:${ebayUserId}`,
  };
}

export interface EbayUserPurgeSummary {
  connections: number;
  listings: number;
  inboundEvents: number;
}

export async function purgeEbayUser(
  deps: { db: Db; logger: Logger },
  payload: EbayUserDeletionPayload,
): Promise<EbayUserPurgeSummary> {
  const requestedAt = new Date();
  const summary = await inTransaction(deps.db, async (trx) => {
    const connections = await trx
      .selectFrom('marketplace_connection')
      .select(['id', 'account_id'])
      .where('marketplace', '=', 'ebay')
      .where('external_user_id', '=', payload.ebayUserId)
      .orderBy('id')
      .forUpdate()
      .execute();
    let deletedConnections = 0;
    let listings = 0;
    let inboundEvents = 0;
    for (const connection of connections) {
      const deleted = await deleteConnectionData(trx, {
        accountId: connection.account_id,
        connectionId: connection.id,
      });
      if (deleted === undefined) continue;
      deletedConnections += 1;
      listings += deleted.listings;
      inboundEvents += deleted.inboundEvents;
    }
    // Events in accounts that no longer (or never) had a connection to them.
    const events = await trx
      .deleteFrom('inbound_event')
      .where('marketplace', '=', 'ebay')
      .where('external_user_id', '=', payload.ebayUserId)
      .executeTakeFirst();
    inboundEvents += Number(events.numDeletedRows);
    const left = await trx
      .selectFrom('marketplace_connection')
      .select('id')
      .where('marketplace', '=', 'ebay')
      .where('external_user_id', '=', payload.ebayUserId)
      .unionAll(
        trx
          .selectFrom('inbound_event')
          .select('id')
          .where('marketplace', '=', 'ebay')
          .where('external_user_id', '=', payload.ebayUserId),
      )
      .execute();
    if (left.length > 0) throw new Error('eBay user data remains after the purge');
    const counts = { connections: deletedConnections, listings, inboundEvents };
    await recordDeletion(trx, {
      id: randomUUID(),
      kind: 'ebay_user',
      reason: 'marketplace_account_deletion',
      marketplace: 'ebay',
      requestedAt,
      summary: { ...counts, verified: { rows: 0 } },
    });
    return counts;
  });
  // Counts only: the eBay user's id is the data being deleted, so it is not logged either.
  deps.logger.info({ ...summary }, 'eBay account deletion: user data purged');
  return summary;
}
