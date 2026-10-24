import { inTransaction } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { deletePhotoObjects } from '../photos/stored-objects.ts';
import { deleteUserData } from './repository.ts';

export interface AccountRouteDependencies extends RouteDependencies {
  storage: ObjectStorage;
}

/** The signed-in person's account: `deleteAccount`. */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDependencies): void {
  /**
   * In-app account deletion, complete without the client:
   * 1. In one transaction, delete the account data and the user, remember the identity so
   *    tokens issued before now stop working, and leave the deletion's tombstone (with the
   *    marketplace grants still to revoke) and its `account_deletion` job. A failure rolls all
   *    of it back, so nothing is deleted and a retry with the same token starts over.
   * 2. After the commit, delete the account's stored photo and upload objects. A failure is
   *    logged, not returned: the rows are gone, so leftover objects are unreferenced.
   * The worker's job then deletes the person at the identity provider and revokes the
   * marketplace grants, retrying until done (`@listora/accounts`).
   */
  contractRoute(app, deps, 'deleteAccount', async ({ tenant, identity, db, request }) => {
    const { deletedAt, connections, photos, uploadKeys } = await inTransaction(db, (trx) =>
      deleteUserData(trx, tenant, identity),
    );
    await deletePhotoObjects(deps.storage, photos, request.log);
    await deleteUploadObjects(deps.storage, uploadKeys, request.log);
    request.log.info(
      {
        accountId: tenant.accountId,
        userId: tenant.userId,
        accountDeleted: tenant.role === 'owner',
      },
      'user deleted their Listora account',
    );
    return {
      status: 200,
      body: {
        deletedAt: deletedAt.toISOString(),
        marketplaceAccess: connections.map((connection) => ({
          marketplace: connection.marketplace,
          ...(connection.displayName === null ? {} : { displayName: connection.displayName }),
          revoked: connection.revoked,
        })),
      },
    };
  });
}

/** Deletes the stored objects of uploads that no photo used; failures are only logged. */
async function deleteUploadObjects(
  storage: ObjectStorage,
  keys: readonly string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    log.warn(
      { err: failures[0]?.reason, failed: failures.length },
      'could not delete some stored uploads of a deleted account',
    );
  }
}
