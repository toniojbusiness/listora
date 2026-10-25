/**
 * The `account_deletion` job: finishes a committed account deletion with the outside services
 * (docs/features/auth.md, "Account deletion"). Every run, for what is still open:
 *
 * 1. Deletes the person at the identity provider (for Cognito, `AdminDeleteUser` once
 *    `AdminGetUser` shows the username still belongs to the deleted `sub`; a dev deletion is
 *    recorded as done when it starts, since dev users exist only as signed tokens). A user that
 *    is already gone, or whose name now belongs to a newer user, counts as deleted. Once it is
 *    done, the identity's tokens issued until then are refused, and a new sign-in works again.
 * 2. Asks each pending marketplace grant's marketplace to revoke Listora's access. A confirmed
 *    revocation deletes the grant's tokens. When the revocation window has passed, an
 *    unconfirmed grant's tokens are deleted too and it is recorded as `manual`: the seller must
 *    remove Listora in the marketplace's settings.
 * 3. When nothing is open, deletes the tombstone; otherwise schedules the next run, later each
 *    time.
 *
 * Every step's result is committed before the next step, and every step is safe to repeat, so a
 * crash or a database failure at any point only means the next run (Graphile retries a failed
 * job) repeats the step that was not recorded.
 */
import type { AccountDeletionTable, Db, Marketplace } from '@listora/db';
import { assertNever, type Logger } from '@listora/shared';
import { sql, type Selectable } from 'kysely';

import type { CognitoUserAdmin } from './cognito-user-admin.ts';
import { isAccountDeletionJobPayload, scheduleAccountDeletionJob } from './deletion.ts';
import { rememberDeletedIdentity } from './identity.ts';
import type { MarketplaceAccessRevoker } from './marketplace-access.ts';

export interface AccountDeletionPolicy {
  /** The wait after run n is `delaysMs[min(n, length) - 1]` (the last one repeats). */
  readonly delaysMs: readonly number[];
  /** How long after the deletion the job keeps asking marketplaces to revoke their grants. */
  readonly revocationWindowMs: number;
}

/** 1 m, 5 m, 15 m, 1 h, 3 h, then every 6 h; marketplace revocations for 7 days. */
export const DEFAULT_ACCOUNT_DELETION_POLICY: AccountDeletionPolicy = {
  delaysMs: [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000],
  revocationWindowMs: 7 * 86_400_000,
};

export interface AccountDeletionDependencies {
  db: Db;
  /**
   * Deletes users of the Cognito user pool. Undefined when the worker has no user pool
   * (COGNITO_USER_POOL_ID): Cognito deletions then wait, with an error logged on every run.
   */
  cognito: CognitoUserAdmin | undefined;
  marketplaceAccess: MarketplaceAccessRevoker;
  logger: Logger;
  policy?: AccountDeletionPolicy;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

/** `completed`: the tombstone is gone. `retrying`: the next run is scheduled. */
export type AccountDeletionOutcome = 'completed' | 'retrying' | 'not_found';

type DeletionRow = Selectable<AccountDeletionTable>;

/** Runs the deletion's job once. Throws only when the database fails. */
export async function completeAccountDeletion(
  deps: AccountDeletionDependencies,
  deletionId: string,
): Promise<AccountDeletionOutcome> {
  const { db } = deps;
  const policy = deps.policy ?? DEFAULT_ACCOUNT_DELETION_POLICY;
  const now = deps.now ?? Date.now;
  const deletion = await db
    .selectFrom('account_deletion')
    .selectAll()
    .where('id', '=', deletionId)
    .executeTakeFirst();
  // Already finished: an earlier run deleted it.
  if (!deletion) return 'not_found';
  const log = deps.logger.child({ accountDeletionId: deletionId });

  const identityDeleted =
    deletion.identity_deleted_at !== null || (await deleteIdentity(deps, deletion, log));

  const windowEndsAt = deletion.requested_at.getTime() + policy.revocationWindowMs;
  const pending = await db
    .selectFrom('account_deletion_grant')
    .select(['connection_id', 'marketplace', 'token_ciphertext'])
    .where('deletion_id', '=', deletionId)
    .where('outcome', '=', 'pending')
    .orderBy('connection_id')
    .execute();
  let stillPending = 0;
  for (const grant of pending) {
    if (grant.token_ciphertext === null) continue;
    const revoked = await revokeGrant(
      deps,
      {
        connectionId: grant.connection_id,
        marketplace: grant.marketplace,
        tokenCiphertext: grant.token_ciphertext,
      },
      log,
    );
    if (revoked) {
      await settleGrant(db, deletionId, grant.connection_id, 'revoked');
    } else if (now() >= windowEndsAt) {
      await settleGrant(db, deletionId, grant.connection_id, 'manual');
      log.warn(
        { connectionId: grant.connection_id, marketplace: grant.marketplace },
        'gave up revoking marketplace access of a deleted account; the seller must revoke it',
      );
    } else {
      stillPending += 1;
    }
  }

  if (identityDeleted && stillPending === 0) {
    const grants = await db
      .selectFrom('account_deletion_grant')
      .select(['marketplace', 'outcome'])
      .where('deletion_id', '=', deletionId)
      .execute();
    await db.deleteFrom('account_deletion').where('id', '=', deletionId).execute();
    log.info(
      {
        revoked: marketplacesWith(grants, 'revoked'),
        revokeManually: marketplacesWith(grants, 'manual'),
      },
      'account deletion completed',
    );
    return 'completed';
  }

  await db.transaction().execute(async (trx) => {
    const { attempts } = await trx
      .updateTable('account_deletion')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', deletionId)
      .returning('attempts')
      .executeTakeFirstOrThrow();
    const delay = policy.delaysMs[Math.min(attempts, policy.delaysMs.length) - 1] ?? 0;
    let runAt = now() + delay;
    // Revocations get one last try when the window ends.
    if (stillPending > 0) runAt = Math.min(runAt, windowEndsAt);
    await scheduleAccountDeletionJob(trx, deletionId, new Date(runAt));
  });
  return 'retrying';
}

/**
 * The Graphile Worker task for `ACCOUNT_DELETION_TASK`. A thrown error (the database failed)
 * makes Graphile run the job again.
 */
export function accountDeletionTask(
  deps: AccountDeletionDependencies,
): (payload: unknown) => Promise<void> {
  return async (payload) => {
    if (!isAccountDeletionJobPayload(payload)) {
      deps.logger.error('account deletion job with an invalid payload; dropping it');
      return;
    }
    await completeAccountDeletion(deps, payload.deletionId);
  };
}

/** Deletes the person at the provider and records it; false when that has to wait. */
async function deleteIdentity(
  deps: AccountDeletionDependencies,
  deletion: DeletionRow,
  log: Logger,
): Promise<boolean> {
  switch (deletion.auth_provider) {
    case 'dev':
      break;
    case 'cognito': {
      if (deps.cognito === undefined) {
        log.error('cannot delete the Cognito user: the worker has no COGNITO_USER_POOL_ID');
        return false;
      }
      if (deletion.provider_username === null) throw new Error('Cognito deletion without user');
      try {
        await deps.cognito.deleteUser({
          username: deletion.provider_username,
          subjectSha256: deletion.auth_subject_sha256,
        });
      } catch (error) {
        log.warn({ err: error }, 'the identity provider could not delete the user; retrying');
        return false;
      }
      break;
    }
    default:
      assertNever(deletion.auth_provider, 'auth provider');
  }
  await deps.db.transaction().execute(async (trx) => {
    await rememberDeletedIdentity(trx, deletion.auth_provider, deletion.auth_subject_sha256);
    await trx
      .updateTable('account_deletion')
      .set({ identity_deleted_at: sql<Date>`now()` })
      .where('id', '=', deletion.id)
      .execute();
  });
  return true;
}

async function revokeGrant(
  deps: AccountDeletionDependencies,
  grant: { connectionId: string; marketplace: Marketplace; tokenCiphertext: Buffer },
  log: Logger,
): Promise<boolean> {
  try {
    return await deps.marketplaceAccess.revoke(grant);
  } catch (error) {
    log.warn(
      { err: error, connectionId: grant.connectionId, marketplace: grant.marketplace },
      'marketplace access could not be revoked',
    );
    return false;
  }
}

/** Records the grant's outcome and deletes its tokens. */
async function settleGrant(
  db: Db,
  deletionId: string,
  connectionId: string,
  outcome: 'revoked' | 'manual',
): Promise<void> {
  await db
    .updateTable('account_deletion_grant')
    .set({ outcome, token_ciphertext: null })
    .where('deletion_id', '=', deletionId)
    .where('connection_id', '=', connectionId)
    .execute();
}

function marketplacesWith(
  grants: readonly { marketplace: Marketplace; outcome: string }[],
  outcome: string,
): Marketplace[] {
  return grants.filter((grant) => grant.outcome === outcome).map((grant) => grant.marketplace);
}
