import type { MarketplaceAccessRevocation } from '@listora/api-contract';
import { inTransaction, type DbExecutor } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError } from '../errors.ts';
import { deletePhotoObjects } from '../photos/stored-objects.ts';
import type { Tenant } from '../tenancy.ts';
import type { MarketplaceAccessRevoker } from './marketplace-access.ts';
import {
  apiConnections,
  deleteUserData,
  markConnectionRevoked,
  otherMemberCount,
} from './repository.ts';

export interface AccountRouteDependencies extends RouteDependencies {
  storage: ObjectStorage;
  marketplaceAccess: MarketplaceAccessRevoker;
}

/** The signed-in person's account: `deleteAccount`. */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDependencies): void {
  /**
   * In-app account deletion. The steps run in an order that keeps every failure retryable
   * with the same token:
   * 1. Revoke each marketplace grant (a confirmed revocation is recorded at once, so a retry
   *    does not ask again; an unconfirmed one is reported as not revoked).
   * 2. Delete the person at the identity provider. If that fails, nothing in the database
   *    is deleted yet and the answer is a retryable `503`.
   * 3. In one transaction, delete the account data and the user, and remember the identity so
   *    tokens issued before now stop working. If this fails after step 2, the token still
   *    verifies (it is checked locally), so a retry finds the provider user already gone and
   *    finishes here.
   * 4. After the commit, delete the account's stored photo and upload objects. A failure is
   *    logged, not returned: the rows are gone, so leftover objects are unreferenced.
   */
  contractRoute(app, deps, 'deleteAccount', async ({ tenant, identity, db, request }) => {
    const owner = tenant.role === 'owner';
    if (owner && (await otherMemberCount(db, tenant)) > 0) {
      throw new ApiError(
        'forbidden',
        'This account has other members. They must leave it before it can be deleted.',
      );
    }
    const marketplaceAccess = owner
      ? await revokeMarketplaceAccess(db, tenant, deps.marketplaceAccess, request.log)
      : [];
    try {
      await deps.auth.deleteUser(identity);
    } catch (error) {
      throw new ApiError(
        'service_unavailable',
        'Your account could not be deleted right now. Try again in a moment.',
        { retryAfterSeconds: 30, cause: error },
      );
    }
    const { deletedAt, photos, uploadKeys } = await inTransaction(db, (trx) =>
      deleteUserData(trx, tenant, identity),
    );
    await deletePhotoObjects(deps.storage, photos, request.log);
    await deleteUploadObjects(deps.storage, uploadKeys, request.log);
    request.log.info(
      { accountId: tenant.accountId, userId: tenant.userId, accountDeleted: owner },
      'user deleted their Listora account',
    );
    return { status: 200, body: { deletedAt: deletedAt.toISOString(), marketplaceAccess } };
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

/**
 * Asks every API connection's marketplace to revoke Listora's access. A connection counts as
 * revoked only when the marketplace confirmed it, now or before (status `revoked`).
 */
async function revokeMarketplaceAccess(
  db: DbExecutor,
  tenant: Tenant,
  revoker: MarketplaceAccessRevoker,
  log: FastifyBaseLogger,
): Promise<MarketplaceAccessRevocation[]> {
  const connections = await apiConnections(db, tenant);
  return Promise.all(
    connections.map(async (connection): Promise<MarketplaceAccessRevocation> => {
      let revoked = connection.revoked;
      if (!revoked && connection.tokenCiphertext !== null) {
        try {
          revoked = await revoker.revoke({
            connectionId: connection.id,
            marketplace: connection.marketplace,
            tokenCiphertext: connection.tokenCiphertext,
          });
        } catch (error) {
          log.warn(
            { err: error, connectionId: connection.id, marketplace: connection.marketplace },
            'marketplace access could not be revoked',
          );
        }
        if (revoked) await markConnectionRevoked(db, tenant, connection.id);
      }
      return {
        marketplace: connection.marketplace,
        ...(connection.displayName === null ? {} : { displayName: connection.displayName }),
        revoked,
      };
    }),
  );
}
