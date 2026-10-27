import { inTransaction } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import type { InvitesDependencies } from '../invites/routes.ts';
import { deletePhotoObjects } from '../photos/stored-objects.ts';
import { deleteUserData, invitedEmailOf } from './repository.ts';

export interface AccountRouteDependencies extends RouteDependencies {
  storage: ObjectStorage;
  invites: InvitesDependencies;
}

/** The signed-in person's account: `deleteAccount`. */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDependencies): void {
  /**
   * In-app account deletion, complete without the client:
   * 1. In one transaction, delete the account data and the user, remember the identity so
   *    tokens issued before now stop working, and leave the deletion's tombstone (with the
   *    marketplace grants still to revoke) and its `account_deletion` job. A failure rolls all
   *    of it back, so nothing is deleted and a retry with the same token starts over.
   * 2. After the commit, delete the account's stored photo, upload, and automation screenshot
   *    objects, and for an invited person their address at the sign-in provider (the SES
   *    identity that let the codes reach them). A failure is logged, not returned: the rows are
   *    gone, so leftover objects are unreferenced.
   * The worker's job then deletes the person at the identity provider and revokes the
   * marketplace grants, retrying until done (`@listora/accounts`).
   */
  contractRoute(app, deps, 'deleteAccount', async ({ tenant, identity, db, request }) => {
    const { deleted, invitedEmail } = await inTransaction(db, async (trx) => {
      // Read first: deleting the account deletes the invite it was created from.
      const email = await invitedEmailOf(trx, tenant);
      return { deleted: await deleteUserData(trx, tenant, identity), invitedEmail: email };
    });
    const { deletedAt, connections, photos, uploadKeys, screenshotKeys } = deleted;
    await deletePhotoObjects(deps.storage, photos, request.log);
    await deleteStoredObjects(deps.storage, [...uploadKeys, ...screenshotKeys], request.log);
    if (invitedEmail !== undefined) {
      // The worker's job deletes the user too, checking it is still this identity.
      await deps.invites.directory.forget(invitedEmail).catch((error: unknown) => {
        request.log.warn({ err: error }, 'could not remove a deleted invitee at the provider');
      });
    }
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

/**
 * Deletes stored objects no row references any more (uploads that no photo used, automation
 * screenshots); failures are only logged.
 */
async function deleteStoredObjects(
  storage: ObjectStorage,
  keys: readonly string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    log.warn(
      { err: failures[0]?.reason, failed: failures.length },
      'could not delete some stored objects of a deleted account',
    );
  }
}
