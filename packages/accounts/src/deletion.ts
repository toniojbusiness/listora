/**
 * The account deletion tombstone and its job in Graphile Worker. `DELETE /v1/account` calls
 * `startAccountDeletion` in the transaction that deletes the person's data, so the tombstone and
 * its job are committed or rolled back together with the deletion. The worker then runs
 * `completeAccountDeletion` (job.ts) until the deletion is done.
 *
 * One job key per deletion (`account_deletion:<id>`): adding the job again replaces the pending
 * one, so a deletion never has two pending jobs.
 */
import type { DbExecutor, DbTransaction, Marketplace } from '@listora/db';
import { sql } from 'kysely';

import {
  lockIdentity,
  rememberDeletedIdentity,
  subjectSha256,
  type IdentityKey,
} from './identity.ts';

/** The Graphile Worker task that finishes an account deletion (job.ts). */
export const ACCOUNT_DELETION_TASK = 'account_deletion';

/**
 * Graphile retries a job whose handler throws (a database outage, a bug) with its own backoff,
 * capped near six hours. Unfinished outside steps never throw; the job schedules its next run
 * itself. The maximum smallint means a deletion's job is never dropped.
 */
export const ACCOUNT_DELETION_JOB_MAX_ATTEMPTS = 32_767;

export interface AccountDeletionJobPayload {
  deletionId: string;
}

export function accountDeletionJobKey(deletionId: string): string {
  return `account_deletion:${deletionId}`;
}

export function isAccountDeletionJobPayload(value: unknown): value is AccountDeletionJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['deletionId'] === 'string';
}

/** Adds (or replaces) the deletion's job, to run at `runAt` (`null` runs it now). */
export async function scheduleAccountDeletionJob(
  executor: DbExecutor,
  deletionId: string,
  runAt: Date | null,
): Promise<void> {
  const payload: AccountDeletionJobPayload = { deletionId };
  await sql`
    select graphile_worker.add_job(
      identifier => ${ACCOUNT_DELETION_TASK},
      payload => ${JSON.stringify(payload)}::json,
      run_at => ${runAt}::timestamptz,
      max_attempts => ${ACCOUNT_DELETION_JOB_MAX_ATTEMPTS},
      job_key => ${accountDeletionJobKey(deletionId)},
      job_key_mode => 'replace'
    )
  `.execute(executor);
}

/** A grant the deleted account held, with its still-encrypted tokens. */
export interface GrantToKeep {
  connectionId: string;
  marketplace: Marketplace;
  tokenCiphertext: Buffer;
}

export interface AccountDeletionRequest {
  identity: IdentityKey & {
    /** The provider's admin API name for the user (Cognito's `username`). */
    username?: string;
  };
  /** The deleted user. */
  userId: string;
  /** The deleted account, when its owner deleted it (not when a member left it). */
  accountId?: string;
  /** Marketplace grants to revoke: the account's API connections that still hold tokens. */
  grants: readonly GrantToKeep[];
  /** Stored objects the deleted rows named (photo derivatives, uploads, screenshots). */
  objectKeys?: readonly string[];
  /** Key prefixes that hold only the deleted account's objects. */
  objectPrefixes?: readonly string[];
}

export interface StartedAccountDeletion {
  deletionId: string;
  deletedAt: Date;
}

/**
 * Leaves the tombstone of a deletion and enqueues its job, on the caller's transaction, and
 * records the identity as deleted so its earlier tokens stop working. Takes `lockIdentity`
 * (call it earlier in the transaction to hold it for the whole deletion).
 */
export async function startAccountDeletion(
  trx: DbTransaction,
  request: AccountDeletionRequest,
): Promise<StartedAccountDeletion> {
  const { identity } = request;
  await lockIdentity(trx, identity);
  const subjectHash = subjectSha256(identity.subject);
  const deletedAt = await rememberDeletedIdentity(trx, identity.provider, subjectHash);
  const { id: deletionId } = await trx
    .insertInto('account_deletion')
    .values({
      auth_provider: identity.provider,
      auth_subject_sha256: subjectHash,
      // Cognito's AdminDeleteUser also accepts the `sub` of a user who signed up in the pool.
      provider_username:
        identity.provider === 'cognito' ? (identity.username ?? identity.subject) : null,
      // Dev users exist only as signed tokens, so there is nothing to wait for.
      identity_deleted_at: identity.provider === 'dev' ? deletedAt : null,
      account_id: request.accountId ?? null,
      user_id: request.userId,
      storage_prefixes: [...(request.objectPrefixes ?? [])],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (request.grants.length > 0) {
    await trx
      .insertInto('account_deletion_grant')
      .values(
        request.grants.map((grant) => ({
          deletion_id: deletionId,
          connection_id: grant.connectionId,
          marketplace: grant.marketplace,
          token_ciphertext: grant.tokenCiphertext,
        })),
      )
      .execute();
  }
  const objectKeys = [...new Set(request.objectKeys ?? [])];
  if (objectKeys.length > 0) {
    await trx
      .insertInto('account_deletion_object')
      .values(objectKeys.map((key) => ({ deletion_id: deletionId, storage_key: key })))
      .execute();
  }
  await scheduleAccountDeletionJob(trx, deletionId, null);
  return { deletionId, deletedAt };
}
