import { createHash } from 'node:crypto';

import type { DbExecutor, DbTransaction, Marketplace } from '@listora/db';
import { sql } from 'kysely';

import type { Identity } from '../auth/driver.ts';
import type { PhotoRow } from '../photos/mapping.ts';
import type { Tenant } from '../tenancy.ts';

/**
 * How long a deleted identity is remembered. Tokens issued before the deletion stop working,
 * and none of them lives longer than a day (Cognito's maximum, and the dev session length).
 */
const DELETED_IDENTITY_RETENTION_HOURS = 48;
/** Expired `deleted_identity` rows purged per account deletion. */
const PURGE_BATCH = 100;

function subjectHash(identity: Identity): Buffer {
  return createHash('sha256').update(identity.subject).digest();
}

/**
 * Whether the identity's account was deleted at or after the token was issued, so the token
 * must not be honored (and must not provision a new account).
 */
export async function isDeletedSinceIssue(db: DbExecutor, identity: Identity): Promise<boolean> {
  const row = await db
    .selectFrom('deleted_identity')
    .select('deleted_at')
    .where('auth_provider', '=', identity.provider)
    .where('auth_subject_sha256', '=', subjectHash(identity))
    .where('deleted_at', '>=', new Date(identity.issuedAt * 1000))
    .executeTakeFirst();
  return row !== undefined;
}

/** How many people besides `tenant`'s user belong to the account. */
export async function otherMemberCount(db: DbExecutor, tenant: Tenant): Promise<number> {
  const row = await db
    .selectFrom('membership')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('account_id', '=', tenant.accountId)
    .where('user_id', '<>', tenant.userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export interface ApiConnectionRow {
  id: string;
  marketplace: Marketplace;
  displayName: string | null;
  /** Null when Listora holds no tokens for it. */
  tokenCiphertext: Buffer | null;
  revoked: boolean;
}

/** The account's API connections (assisted connections never hold credentials). */
export async function apiConnections(db: DbExecutor, tenant: Tenant): Promise<ApiConnectionRow[]> {
  const rows = await db
    .selectFrom('marketplace_connection')
    .select(['id', 'marketplace', 'display_name', 'token_ciphertext', 'status'])
    .where('account_id', '=', tenant.accountId)
    .where('mode', '=', 'api')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    marketplace: row.marketplace,
    displayName: row.display_name,
    tokenCiphertext: row.token_ciphertext,
    revoked: row.status === 'revoked',
  }));
}

/** Records that the marketplace confirmed the revocation, and forgets the tokens. */
export async function markConnectionRevoked(
  db: DbExecutor,
  tenant: Tenant,
  connectionId: string,
): Promise<void> {
  await db
    .updateTable('marketplace_connection')
    .set({ status: 'revoked', token_ciphertext: null, last_error: null })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', connectionId)
    .execute();
}

export interface DeletedUserData {
  deletedAt: Date;
  /** The deleted account's photos, read before the cascade, so their objects can go too. */
  photos: PhotoRow[];
  /** Stored objects of uploads no photo uses yet. */
  uploadKeys: string[];
}

/**
 * Deletes the person and, when they own it, their account with all of its data (every
 * tenant table cascades from `account`), and remembers the identity so tokens issued before
 * now stop working. Returns when the deletion happened and the stored objects the deleted
 * rows referenced (delete them after the transaction commits).
 */
export async function deleteUserData(
  trx: DbTransaction,
  tenant: Tenant,
  identity: Identity,
): Promise<DeletedUserData> {
  const { deleted_at: deletedAt } = await trx
    .insertInto('deleted_identity')
    .values({ auth_provider: identity.provider, auth_subject_sha256: subjectHash(identity) })
    .onConflict((conflict) =>
      conflict
        .columns(['auth_provider', 'auth_subject_sha256'])
        .doUpdateSet((eb) => ({ deleted_at: eb.ref('excluded.deleted_at') })),
    )
    .returning('deleted_at')
    .executeTakeFirstOrThrow();
  let photos: PhotoRow[] = [];
  let uploadKeys: string[] = [];
  if (tenant.role === 'owner') {
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
    await trx.deleteFrom('account').where('id', '=', tenant.accountId).execute();
  }
  // Cascades to the person's memberships; their AI usage and audit entries stay with the
  // account (if it remains) without the reference.
  await trx.deleteFrom('app_user').where('id', '=', tenant.userId).execute();
  await purgeExpiredDeletedIdentities(trx);
  return { deletedAt, photos, uploadKeys };
}

/**
 * Deletes a batch of rows past the retention period, oldest first. Rows another transaction
 * holds are skipped, so concurrent deletions never wait on each other here.
 */
async function purgeExpiredDeletedIdentities(trx: DbTransaction): Promise<void> {
  await sql`
    delete from deleted_identity
    where (auth_provider, auth_subject_sha256) in (
      select auth_provider, auth_subject_sha256 from deleted_identity
      where deleted_at < now() - make_interval(hours => ${DELETED_IDENTITY_RETENTION_HOURS})
      order by deleted_at
      limit ${PURGE_BATCH}
      for update skip locked
    )
  `.execute(trx);
}
