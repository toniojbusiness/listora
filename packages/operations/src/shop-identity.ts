/**
 * The shop a connection holds (docs/features/marketplace-linking.md#the-shop-a-connection-holds).
 * An automation connection's session check reads the seller its session is signed in as, and
 * `recordConnectionSeller` records it on the connection (`external_user_id`):
 *
 * - **First seen**: the connection holds that seller from now on.
 * - **The same**: nothing changes.
 * - **Another seller**: the session now signs into another shop than the one whose listings the
 *   connection holds. Its waiting changes fail (`shop_changed`), so none reaches the new shop,
 *   and its listings leave it, marked as from the previous shop, exactly as an unlink leaves them:
 *   an import of a shop that has them takes them back.
 *
 * The database then keeps read only by seller (migrations `20261029042234_shop_seller` and
 * `20261029233830_shop_read_only`): a connection that comes to hold a protected shop, or a seller
 * the account kept read only, becomes read only, and its waiting changes fail with the read-only
 * error; one whose read only was carried from the account's marketplace, or belonged to the shop
 * it held before, becomes writable for any other seller.
 */
import { sql } from 'kysely';

import { inTransaction, type DbExecutor, type Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import { failWaitingWrites, READ_ONLY_ERROR, readOnlyMessage } from './read-only.ts';

/** The error code of a change refused because its connection now signs into another shop. */
export const SHOP_CHANGED_ERROR = 'shop_changed';

/** What the seller is told about such a change. */
export function shopChangedMessage(marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  return `Your ${name} login is for another shop than the one this listing is on, so Listora didn't change it. Listora will find the listing again when you link its shop.`;
}

export interface RecordedSeller {
  marketplace: Marketplace;
  /** The connection held another seller before: its listings left it. */
  changed: boolean;
  /** The connection became read only because of the seller it now holds. */
  becameReadOnly: boolean;
  /**
   * The connection is no longer read only: its read only was carried from the account's
   * marketplace, or belonged to the shop it held before, and the seller it now holds is neither
   * protected nor kept read only.
   */
  becameWritable: boolean;
  /** The changes that waited on the connection and failed, oldest first. */
  refused: string[];
}

/**
 * Records that the connection's session is signed in as `sellerId` (a `sellerIdentity`), on the
 * caller's transaction or a new one. `undefined` when the account has no such connection.
 */
export async function recordConnectionSeller(
  executor: DbExecutor,
  target: { accountId: string; connectionId: string },
  sellerId: string,
): Promise<RecordedSeller | undefined> {
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .selectFrom('marketplace_connection')
      .select(['marketplace', 'external_user_id', 'read_only'])
      .where('account_id', '=', target.accountId)
      .where('id', '=', target.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (connection === undefined) return undefined;
    const { marketplace } = connection;
    if (connection.external_user_id === sellerId) {
      return {
        marketplace,
        changed: false,
        becameReadOnly: false,
        becameWritable: false,
        refused: [],
      };
    }

    const changed = connection.external_user_id !== null;
    const refused: string[] = [];
    if (changed) {
      // Nothing waiting for the previous shop may reach this one.
      refused.push(
        ...(await failWaitingWrites(trx, {
          accountId: target.accountId,
          listings: sql<boolean>`listing.connection_id = ${target.connectionId}`,
          error: { code: SHOP_CHANGED_ERROR, message: shopChangedMessage(marketplace) },
          action: SHOP_CHANGED_ERROR,
        })),
      );
      await trx
        .updateTable('marketplace_listing')
        .set({ connection_id: null, remote_snapshot: null, shop_unlinked_at: sql<Date>`now()` })
        .where('account_id', '=', target.accountId)
        .where('connection_id', '=', target.connectionId)
        .execute();
    }
    const updated = await trx
      .updateTable('marketplace_connection')
      .set({ external_user_id: sellerId })
      .where('account_id', '=', target.accountId)
      .where('id', '=', target.connectionId)
      .returning('read_only')
      .executeTakeFirstOrThrow();

    const becameReadOnly = updated.read_only && !connection.read_only;
    const becameWritable = !updated.read_only && connection.read_only;
    if (becameReadOnly) {
      refused.push(
        ...(await failWaitingWrites(trx, {
          accountId: target.accountId,
          listings: sql<boolean>`(
            listing.connection_id = ${target.connectionId}
            or (listing.connection_id is null and listing.marketplace = ${marketplace})
          )`,
          error: { code: READ_ONLY_ERROR, message: readOnlyMessage(marketplace) },
          action: 'read_only',
        })),
      );
    }
    return { marketplace, changed, becameReadOnly, becameWritable, refused };
  });
}
