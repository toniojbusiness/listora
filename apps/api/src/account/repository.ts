import { lockIdentity, startAccountDeletion, type GrantToKeep } from '@listora/accounts';
import { SCREENSHOT_PREFIX } from '@listora/automation';
import type { DbTransaction, Marketplace } from '@listora/db';
import { storageKeys } from '@listora/photos';

import type { Identity } from '../auth/driver.ts';
import { ApiError } from '../errors.ts';
import type { PhotoRow } from '../photos/mapping.ts';
import { photoObjectKeys } from '../photos/stored-objects.ts';
import type { Tenant } from '../tenancy.ts';

/** An API connection of the deleted account, as the deletion reports it. */
export interface DeletedConnection {
  marketplace: Marketplace;
  displayName: string | null;
  /** The marketplace confirmed the revocation before the deletion (status `revoked`). */
  revoked: boolean;
}

export interface DeletedUserData {
  deletedAt: Date;
  /** The deleted account's API connections (assisted connections never hold credentials). */
  connections: DeletedConnection[];
  /** The deleted account's photos, read before the cascade, so their objects can go too. */
  photos: PhotoRow[];
  /** Stored objects of uploads no photo uses yet. */
  uploadKeys: string[];
  /** The redacted screenshots of the account's failed browser automation runs. */
  screenshotKeys: string[];
}

/**
 * Deletes the person and, when they own it, their account with all of its data (every
 * tenant table cascades from `account`), and leaves the deletion's tombstone and job
 * (`startAccountDeletion`) with the marketplace grants still to revoke. Returns when the
 * deletion happened, the account's connections, and the stored objects the deleted rows
 * referenced (delete them after the transaction commits).
 *
 * Fails with `401 unauthenticated` when a concurrent deletion of the same person committed
 * first, and with `403 forbidden` when an owner's account has other members.
 */
export async function deleteUserData(
  trx: DbTransaction,
  tenant: Tenant,
  identity: Identity,
): Promise<DeletedUserData> {
  await lockIdentity(trx, identity);
  const user = await trx
    .selectFrom('app_user')
    .select('id')
    .where('id', '=', tenant.userId)
    .forUpdate()
    .executeTakeFirst();
  if (!user) throw new ApiError('unauthenticated', 'Sign in to continue.');
  const owner = tenant.role === 'owner';
  if (owner && (await otherMemberCount(trx, tenant)) > 0) {
    throw new ApiError(
      'forbidden',
      'This account has other members. They must leave it before it can be deleted.',
    );
  }

  let connections: DeletedConnection[] = [];
  let grants: GrantToKeep[] = [];
  let photos: PhotoRow[] = [];
  let uploadKeys: string[] = [];
  let screenshotKeys: string[] = [];
  if (owner) {
    const rows = await trx
      .selectFrom('marketplace_connection')
      .select(['id', 'marketplace', 'display_name', 'token_ciphertext', 'status'])
      .where('account_id', '=', tenant.accountId)
      .where('mode', '=', 'api')
      .orderBy('id')
      .execute();
    connections = rows.map((row) => ({
      marketplace: row.marketplace,
      displayName: row.display_name,
      revoked: row.status === 'revoked',
    }));
    grants = rows.flatMap((row) =>
      row.status === 'revoked' || row.token_ciphertext === null
        ? []
        : [
            {
              connectionId: row.id,
              marketplace: row.marketplace,
              tokenCiphertext: row.token_ciphertext,
            },
          ],
    );
    photos = await trx
      .selectFrom('photo')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .execute();
    const uploads = await trx
      .selectFrom('upload_file')
      .select('storage_key')
      .where('account_id', '=', tenant.accountId)
      .where('status', '<>', 'attached')
      .execute();
    uploadKeys = uploads.map((upload) => upload.storage_key);
    const screenshots = await trx
      .selectFrom('automation_run')
      .select('screenshot_key')
      .where('account_id', '=', tenant.accountId)
      .where('screenshot_key', 'is not', null)
      .execute();
    screenshotKeys = screenshots.flatMap((run) =>
      run.screenshot_key === null ? [] : [run.screenshot_key],
    );
  }

  // The job deletes every stored object again and checks it is gone, in case the API's own
  // deletion after the commit fails: the ones these rows name, and everything under the
  // account's prefixes.
  const { deletedAt } = await startAccountDeletion(trx, {
    identity,
    userId: tenant.userId,
    grants,
    ...(owner
      ? {
          accountId: tenant.accountId,
          objectKeys: [...photos.flatMap(photoObjectKeys), ...uploadKeys, ...screenshotKeys],
          objectPrefixes: [
            ...storageKeys.accountPrefixes(tenant.accountId),
            `${SCREENSHOT_PREFIX}${tenant.accountId}/`,
          ],
        }
      : {}),
  });
  if (owner) await trx.deleteFrom('account').where('id', '=', tenant.accountId).execute();
  // Cascades to the person's memberships; their AI usage and audit entries stay with the
  // account (if it remains) without the reference.
  await trx.deleteFrom('app_user').where('id', '=', tenant.userId).execute();
  return { deletedAt, connections, photos, uploadKeys, screenshotKeys };
}

/** How many people besides `tenant`'s user belong to the account. */
async function otherMemberCount(trx: DbTransaction, tenant: Tenant): Promise<number> {
  const row = await trx
    .selectFrom('membership')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('account_id', '=', tenant.accountId)
    .where('user_id', '<>', tenant.userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
