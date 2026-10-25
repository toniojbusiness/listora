/**
 * eBay Marketplace Account Deletion: when an eBay user asks eBay to delete their data, every
 * application must "remove all user data associated with the eBay user", irreversibly
 * (developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion, read 2026-10-24).
 * The notification adds one `ebay_user_deletion` job per eBay user (receive.ts), and the job
 * deletes, in one transaction, everything Listora holds that identifies them or came from
 * their eBay account:
 *
 * - every `marketplace_connection` to that eBay user, in every account: their encrypted OAuth
 *   tokens, eBay user id, and user name (connect attempts that point at it lose the link);
 * - the eBay listing snapshots read back under those connections (`remote_snapshot`), and the
 *   listings' link to the connection, so nothing can act for the deleted user again;
 * - every eBay `inbound_event` about them (webhook payloads name them; poll events too).
 *
 * The Listora account's own inventory, listing history, and sales stay: they are the Listora
 * user's records, not the eBay user's data, and sales are kept for tax records. Listora never
 * stores buyer data, so a buyer's deletion finds nothing. Database backups expire with their
 * retention period. The job is idempotent: a repeat finds nothing and deletes nothing.
 */
import { inTransaction, type BackgroundJob, type Db } from '@listora/db';
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
  const summary = await inTransaction(deps.db, async (trx) => {
    const connections = await trx
      .selectFrom('marketplace_connection')
      .select(['id', 'account_id'])
      .where('marketplace', '=', 'ebay')
      .where('external_user_id', '=', payload.ebayUserId)
      .forUpdate()
      .execute();
    let listings = 0;
    for (const connection of connections) {
      const updated = await trx
        .updateTable('marketplace_listing')
        .set({ connection_id: null, remote_snapshot: null })
        .where('account_id', '=', connection.account_id)
        .where('connection_id', '=', connection.id)
        .executeTakeFirst();
      listings += Number(updated.numUpdatedRows);
    }
    const deletedConnections =
      connections.length === 0
        ? 0
        : Number(
            (
              await trx
                .deleteFrom('marketplace_connection')
                .where(
                  'id',
                  'in',
                  connections.map((connection) => connection.id),
                )
                .executeTakeFirst()
            ).numDeletedRows,
          );
    const events = await trx
      .deleteFrom('inbound_event')
      .where('marketplace', '=', 'ebay')
      .where('external_user_id', '=', payload.ebayUserId)
      .executeTakeFirst();
    return {
      connections: deletedConnections,
      listings,
      inboundEvents: Number(events.numDeletedRows),
    };
  });
  // Counts only: the eBay user's id is the data being deleted, so it is not logged either.
  deps.logger.info({ ...summary }, 'eBay account deletion: user data purged');
  return summary;
}
