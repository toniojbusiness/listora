/**
 * Session checks (decision D1): after the seller links a marketplace from the iPhone app, the
 * browser runner opens the stored session once and runs the marketplace's read-only health
 * script, so the app shows the marketplace as linked only once the marketplace accepted the
 * session (docs/features/marketplace-linking.md). One `session_check` row per automation
 * connection holds the newest link's check; each link starts a new one (`requestSessionCheck`,
 * in the linking transaction), the seller can check the same session again
 * (`requestSessionRecheck`, Retry check), and the runner records the result (job.ts).
 */
import { sql } from 'kysely';

import { SESSION_CHECK_DEADLINE_MS } from '@listora/connections';
import { inTransaction, type DbExecutor, type Marketplace } from '@listora/db';

/** The browser runner's task that checks one newly linked session (job.ts). */
export const SESSION_CHECK_TASK = 'automation_session_check';

export interface SessionCheckJobPayload {
  accountId: string;
  connectionId: string;
  /** The link the job checks; a job for an older link records nothing. */
  checkId: string;
}

export function isSessionCheckJobPayload(value: unknown): value is SessionCheckJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, connectionId, checkId } = value as Record<string, unknown>;
  return (
    typeof accountId === 'string' && typeof connectionId === 'string' && typeof checkId === 'string'
  );
}

export function sessionCheckJobKey(connectionId: string): string {
  return `session-check:${connectionId}`;
}

export interface SessionCheckTarget {
  accountId: string;
  connectionId: string;
  marketplace: Marketplace;
}

/**
 * Starts the check of the session just linked on the connection: the connection's check is
 * pending again under a new check id, and its job replaces any job still waiting for an older
 * link. Call it in the transaction that stores the session.
 */
export async function requestSessionCheck(
  executor: DbExecutor,
  target: SessionCheckTarget,
): Promise<{ checkId: string }> {
  const { check_id: checkId } = await executor
    .insertInto('session_check')
    .values({
      account_id: target.accountId,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'connection_id']).doUpdateSet({
        check_id: sql<string>`uuidv7()`,
        status: 'pending',
        attempts: 0,
        failure_code: null,
        failure_message: null,
        requested_at: sql<Date>`now()`,
        finished_at: null,
      }),
    )
    .returning('check_id')
    .executeTakeFirstOrThrow();
  await addSessionCheckJob(executor, { ...target, checkId }, null);
  return { checkId };
}

/**
 * Checks the session already stored on the connection again (Retry check), so a check that
 * failed or did not finish can be repeated without the seller signing in again. Only an
 * automation connection that holds a session can be checked; a check still running within its
 * deadline is left to finish rather than started over. Returns false when there is no session
 * to check (none was linked, or the marketplace rejected it and it waits for a relink).
 */
export async function requestSessionRecheck(
  executor: DbExecutor,
  target: { accountId: string; connectionId: string },
  now: Date,
): Promise<boolean> {
  return inTransaction(executor, async (trx) => {
    // The connection's row lock orders this after any session write in flight (a relink).
    const connection = await trx
      .selectFrom('marketplace_connection')
      .select('marketplace')
      .where('account_id', '=', target.accountId)
      .where('id', '=', target.connectionId)
      .where('mode', '=', 'automation')
      .where('status', 'in', ['connected', 'degraded'])
      .where('token_ciphertext', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (connection === undefined) return false;
    const current = await trx
      .selectFrom('session_check')
      .select(['status', 'requested_at'])
      .where('account_id', '=', target.accountId)
      .where('connection_id', '=', target.connectionId)
      .executeTakeFirst();
    const running =
      current?.status === 'pending' &&
      now.getTime() - current.requested_at.getTime() < SESSION_CHECK_DEADLINE_MS;
    if (!running) {
      await requestSessionCheck(trx, { ...target, marketplace: connection.marketplace });
    }
    return true;
  });
}

/** Adds (or replaces) the connection's check job, to run now or after `delayMs`. */
export async function addSessionCheckJob(
  executor: DbExecutor,
  check: SessionCheckTarget & { checkId: string },
  delayMs: number | null,
): Promise<void> {
  const payload: SessionCheckJobPayload = {
    accountId: check.accountId,
    connectionId: check.connectionId,
    checkId: check.checkId,
  };
  const runAt =
    delayMs === null ? sql`now()` : sql`now() + make_interval(secs => ${delayMs / 1000})`;
  // The job's own attempts cover only Listora's failures (the database); the check counts the
  // marketplace's in `session_check.attempts`.
  await sql`
    select graphile_worker.add_job(
      identifier => ${SESSION_CHECK_TASK},
      payload => ${JSON.stringify(payload)}::json,
      run_at => ${runAt},
      max_attempts => 3,
      job_key => ${sessionCheckJobKey(check.connectionId)},
      job_key_mode => 'replace'
    )
  `.execute(executor);
}
