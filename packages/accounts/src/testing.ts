/**
 * Test helpers for other workspaces, imported as `@listora/accounts/testing`. Never imported by
 * runtime code.
 */
import type { Db } from '@listora/db';
import { sql } from 'kysely';

import type { CognitoUserAdmin } from './cognito-user-admin.ts';
import { ACCOUNT_DELETION_TASK, accountDeletionJobKey } from './deletion.ts';
import {
  completeAccountDeletion,
  type AccountDeletionDependencies,
  type AccountDeletionOutcome,
} from './job.ts';
import type { GrantToRevoke, MarketplaceAccessRevoker } from './marketplace-access.ts';

/** Records deleted usernames; `failWith` makes the next deletions throw. */
export class FakeCognitoUserAdmin implements CognitoUserAdmin {
  readonly deleted: string[] = [];
  failWith: Error | undefined;

  deleteUser(username: string): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.deleted.push(username);
    return Promise.resolve();
  }
}

/**
 * A stand-in for the marketplace adapters' grant revocation: each connection id answers as
 * configured (confirmed by default), and every request is recorded.
 */
export class FakeMarketplaceAccess implements MarketplaceAccessRevoker {
  readonly revoked: GrantToRevoke[] = [];
  readonly #outcomes = new Map<string, boolean | Error>();

  /** How the marketplace answers for `connectionId`: confirmed, unconfirmed, or a failure. */
  answer(connectionId: string, outcome: boolean | Error): void {
    this.#outcomes.set(connectionId, outcome);
  }

  revoke(grant: GrantToRevoke): Promise<boolean> {
    this.revoked.push(grant);
    const outcome = this.#outcomes.get(grant.connectionId) ?? true;
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

export interface AccountDeletionJob {
  deletionId: string;
  runAt: Date;
}

/** The queued `account_deletion` jobs, oldest first. */
export async function accountDeletionJobs(db: Db): Promise<AccountDeletionJob[]> {
  const { rows } = await sql<{ key: string; run_at: Date }>`
    select key, run_at from graphile_worker.jobs
    where task_identifier = ${ACCOUNT_DELETION_TASK}
    order by id
  `.execute(db);
  return rows.map((row) => ({
    deletionId: row.key.slice(accountDeletionJobKey('').length),
    runAt: row.run_at,
  }));
}

/**
 * Runs every queued `account_deletion` job once, in process and whatever its `run_at`, as the
 * worker would once it is due. A run that leaves work queues its next job.
 */
export async function runAccountDeletionJobs(
  deps: AccountDeletionDependencies,
): Promise<AccountDeletionOutcome[]> {
  const outcomes: AccountDeletionOutcome[] = [];
  for (const job of await accountDeletionJobs(deps.db)) {
    await sql`select graphile_worker.remove_job(${accountDeletionJobKey(job.deletionId)})`.execute(
      deps.db,
    );
    outcomes.push(await completeAccountDeletion(deps, job.deletionId));
  }
  return outcomes;
}
