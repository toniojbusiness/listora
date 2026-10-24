/**
 * Deleted identities. Deleting an account also deletes its user, but a bearer token issued
 * before the deletion stays valid until it expires, and until the identity provider has deleted
 * the user it can issue new ones. Such a token must not provision a new, empty account, so the
 * tenancy guard asks `isIdentityDeleted` before it provisions a user, inside a transaction that
 * holds `lockIdentity`, the lock every account deletion of the identity takes too: provisioning
 * either sees the committed deletion or runs before it starts.
 */
import { createHash } from 'node:crypto';

import type { AuthProvider, DbExecutor, DbTransaction } from '@listora/db';
import { sql } from 'kysely';

/**
 * How long a deleted identity is remembered after its provider deleted the user. Tokens issued
 * before then stop working, and none of them lives longer than a day (Cognito's maximum, and
 * the dev session length).
 */
export const DELETED_IDENTITY_RETENTION_HOURS = 48;
/** Expired `deleted_identity` rows purged per account deletion. */
const PURGE_BATCH = 100;

/** A person as the identity provider names them. */
export interface IdentityKey {
  provider: AuthProvider;
  /** The provider's stable user id (the Cognito `sub`; the email for the dev driver). */
  subject: string;
}

/** The subject is stored only as its SHA-256, so no email address outlives a deletion. */
export function subjectSha256(subject: string): Buffer {
  return createHash('sha256').update(subject).digest();
}

/**
 * Takes the transaction-scoped lock that serializes deleting an identity's account with
 * provisioning a user for the identity.
 */
export async function lockIdentity(trx: DbTransaction, identity: IdentityKey): Promise<void> {
  const name = `identity:${identity.provider}:${subjectSha256(identity.subject).toString('hex')}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`.execute(trx);
}

/**
 * Whether a token of the identity issued at `issuedAt` (seconds since the epoch) must be
 * refused: the identity's account was deleted at or after the token was issued, or a deletion
 * still waits for the provider to delete the user.
 */
export async function isIdentityDeleted(
  db: DbExecutor,
  identity: IdentityKey & { issuedAt: number },
): Promise<boolean> {
  const hash = subjectSha256(identity.subject);
  const { rows } = await sql<{ deleted: boolean }>`
    select exists (
      select 1 from deleted_identity
      where auth_provider = ${identity.provider} and auth_subject_sha256 = ${hash}
        and deleted_at >= ${new Date(identity.issuedAt * 1000)}
    ) or exists (
      select 1 from account_deletion
      where auth_provider = ${identity.provider} and auth_subject_sha256 = ${hash}
        and identity_deleted_at is null
    ) as deleted
  `.execute(db);
  return rows[0]?.deleted === true;
}

/**
 * Records that the identity was deleted now, so its tokens issued until now are refused.
 * Returns the recorded time.
 */
export async function rememberDeletedIdentity(
  trx: DbTransaction,
  provider: AuthProvider,
  subjectHash: Buffer,
): Promise<Date> {
  const { deleted_at: deletedAt } = await trx
    .insertInto('deleted_identity')
    .values({ auth_provider: provider, auth_subject_sha256: subjectHash })
    .onConflict((conflict) =>
      conflict
        .columns(['auth_provider', 'auth_subject_sha256'])
        .doUpdateSet((eb) => ({ deleted_at: eb.ref('excluded.deleted_at') })),
    )
    .returning('deleted_at')
    .executeTakeFirstOrThrow();
  await purgeExpiredDeletedIdentities(trx);
  return deletedAt;
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
