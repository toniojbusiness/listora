/**
 * Test helpers for other workspaces, imported as `@listora/accounts/testing`. Never imported by
 * runtime code.
 */
import type { Db } from '@listora/db';
import { sql } from 'kysely';

import type { CognitoUserAdmin, CognitoUserToDelete } from './cognito-user-admin.ts';
import { ACCOUNT_DELETION_TASK, accountDeletionJobKey } from './deletion.ts';
import { subjectSha256 } from './identity.ts';
import {
  completeAccountDeletion,
  type AccountDeletionDependencies,
  type AccountDeletionOutcome,
} from './job.ts';
import type { InviteeDirectory, InviteeEmailState } from './invitees.ts';
import type { GrantToRevoke, MarketplaceAccessRevoker } from './marketplace-access.ts';

/**
 * Records deleted usernames; `failWith` makes the next deletions throw. A username belongs to
 * the identity being deleted unless `recreateUser` gave it to a newer user, which a deletion
 * then leaves alone, like `AwsCognitoUserAdmin`.
 */
export class FakeCognitoUserAdmin implements CognitoUserAdmin {
  readonly deleted: string[] = [];
  failWith: Error | undefined;
  readonly #recreated = new Map<string, string>();

  /** The person signed in again: Cognito reused `username` for a new user with `sub`. */
  recreateUser(username: string, sub: string): void {
    this.#recreated.set(username, sub);
  }

  deleteUser(user: CognitoUserToDelete): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    const sub = this.#recreated.get(user.username);
    if (sub !== undefined && !subjectSha256(sub).equals(user.subjectSha256)) {
      return Promise.resolve();
    }
    this.#recreated.delete(user.username);
    this.deleted.push(user.username);
    return Promise.resolve();
  }
}

/**
 * Invitee users in memory, like a user pool: `admitted` holds the addresses that can sign in,
 * `suspended` the ones that cannot right now. Addresses in `unverified` are not deliverable yet
 * (SES's sandbox); `failWith` makes the next calls throw.
 */
export class FakeInviteeDirectory implements InviteeDirectory {
  readonly admitted = new Set<string>();
  readonly suspended = new Set<string>();
  readonly unverified = new Set<string>();
  readonly calls: string[] = [];
  failWith: Error | undefined;

  admit(email: string): Promise<InviteeEmailState> {
    return this.#run(`admit ${email}`, () => {
      this.admitted.add(email);
      return this.#state(email);
    });
  }

  forget(email: string): Promise<void> {
    return this.#run(`forget ${email}`, () => {
      this.admitted.delete(email);
      this.suspended.delete(email);
    });
  }

  suspend(email: string): Promise<void> {
    return this.#run(`suspend ${email}`, () => {
      if (this.admitted.has(email)) this.suspended.add(email);
    });
  }

  resume(email: string): Promise<InviteeEmailState> {
    return this.#run(`resume ${email}`, () => {
      this.admitted.add(email);
      this.suspended.delete(email);
      return this.#state(email);
    });
  }

  #state(email: string): InviteeEmailState {
    return this.unverified.has(email) ? 'verification_sent' : 'deliverable';
  }

  #run<T>(call: string, apply: () => T): Promise<T> {
    this.calls.push(call);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(apply());
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
