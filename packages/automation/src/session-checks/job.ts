/**
 * The session check (decision D1), run by the browser runner right after the seller links a
 * marketplace: it opens the stored session once and runs the marketplace adapter's read-only
 * health script, then records on the connection's `session_check` whether the marketplace
 * accepted it. The app shows the marketplace as linked only after a passed check, so a session
 * that does not work is never reported as linked.
 *
 * - **Passed**: the health script read the seller's account page.
 * - **Failed, relink**: the marketplace rejected the session or showed a check automation must
 *   not pass. The runner's session handling has already discarded the session and asked the
 *   seller to log in again (the vault's `markNeedsRelink`).
 * - **Failed, can't check**: no automation adapter serves the marketplace yet, or the
 *   marketplace could not be read (rate limit, timeout, an error page, or the runner's browser
 *   did not start) on any of `SESSION_CHECK_ATTEMPTS` attempts. The session is kept: the
 *   seller can check it again (`requestSessionRecheck`) without signing in, or link again.
 *
 * Only a database failure throws, and the job queue then runs the job again.
 */
import { sql } from 'kysely';

import type { Db, Marketplace } from '@listora/db';
import {
  MARKETPLACE_NAMES,
  type ConnectionRef,
  type Health,
  type MarketplaceAdapter,
} from '@listora/marketplaces';
import { assertNever, type Logger } from '@listora/shared';

import { isAutomatedMarketplace, type AutomatedMarketplace } from '../profiles.ts';
import { addSessionCheckJob, type SessionCheckJobPayload } from './schedule.ts';

/** Attempts a check gets when the marketplace can't be read, before it fails. */
export const SESSION_CHECK_ATTEMPTS = 3;

export interface SessionCheckDependencies {
  db: Db;
  /**
   * The runner's automation adapters (with a browser). A marketplace without one can't be
   * checked: its assisted adapter would report healthy without ever opening the session.
   */
  automation: Partial<Record<AutomatedMarketplace, MarketplaceAdapter>>;
  logger: Logger;
  /** The deadline of one attempt (default 2 minutes). */
  timeoutMs?: number;
  /** The wait before attempt `attempt + 1` (default 30 seconds, then 2 minutes). */
  retryDelayMs?: (attempt: number) => number;
}

interface Failure {
  code: string;
  message: string;
}

export async function runSessionCheck(
  deps: SessionCheckDependencies,
  payload: SessionCheckJobPayload,
  signal: AbortSignal,
): Promise<void> {
  const { db } = deps;
  const log = deps.logger.child({ task: 'session_check', connectionId: payload.connectionId });
  const found = await db
    .selectFrom('session_check as check')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'check.account_id')
        .onRef('connection.id', '=', 'check.connection_id'),
    )
    .select([
      'check.marketplace',
      'check.attempts',
      'connection.mode',
      'connection.status',
      'connection.last_error',
    ])
    .where('check.account_id', '=', payload.accountId)
    .where('check.connection_id', '=', payload.connectionId)
    .where('check.check_id', '=', payload.checkId)
    .where('check.status', '=', 'pending')
    .executeTakeFirst();
  // Already decided, or the seller linked again since (that link has its own job).
  if (found === undefined) return;

  const attempt = found.attempts + 1;
  const name = MARKETPLACE_NAMES[found.marketplace];
  const record = (result: 'passed' | Failure): Promise<void> =>
    finish(db, payload, attempt, result).then((recorded) => {
      log.info(
        { result: result === 'passed' ? 'passed' : result.code, attempt, recorded },
        'session check finished',
      );
    });

  if (
    found.mode !== 'automation' ||
    (found.status !== 'connected' && found.status !== 'degraded')
  ) {
    await record({
      code: 'session_rejected',
      message: found.last_error ?? `Log in to ${name} again to link it.`,
    });
    return;
  }
  const adapter = isAutomatedMarketplace(found.marketplace)
    ? deps.automation[found.marketplace]
    : undefined;
  if (adapter === undefined) {
    await record({
      code: 'automation_unavailable',
      message: `Listora can't automate ${name} yet, so it can't check this login. Your listings there stay assisted.`,
    });
    return;
  }

  const connection: ConnectionRef = {
    id: payload.connectionId,
    mode: found.mode,
    status: found.status,
  };
  const health = await adapter.healthCheck({
    connection,
    signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? 120_000)]),
  });
  // The runner is stopping: the job runs again on the next runner, attempt not counted.
  if (signal.aborted) throw new Error('the session check stopped with the runner');
  const failure = healthFailure(health);
  if (failure === null) {
    await record('passed');
    return;
  }
  if (health.status === 'degraded' && attempt < SESSION_CHECK_ATTEMPTS) {
    const delayMs = (deps.retryDelayMs ?? defaultRetryDelayMs)(attempt);
    await retryLater(db, payload, found.marketplace, attempt, delayMs);
    log.info({ code: failure.code, attempt, delayMs }, 'session check will try again');
    return;
  }
  // What the seller can do about it is the view's to say (`describeAutomationSession`).
  await record(failure);
}

function healthFailure(health: Health): Failure | null {
  switch (health.status) {
    case 'ok':
      return null;
    case 'degraded':
    case 'reauth_required':
    case 'revoked':
      return { code: health.code, message: health.message };
    default:
      return assertNever(health, 'health');
  }
}

function defaultRetryDelayMs(attempt: number): number {
  return attempt === 1 ? 30_000 : 120_000;
}

/** Records the check's result, unless it is no longer the pending check the job was for. */
async function finish(
  db: Db,
  payload: SessionCheckJobPayload,
  attempt: number,
  result: 'passed' | Failure,
): Promise<boolean> {
  const updated = await db
    .updateTable('session_check')
    .set({
      status: result === 'passed' ? 'passed' : 'failed',
      attempts: attempt,
      failure_code: result === 'passed' ? null : result.code.slice(0, 100),
      failure_message: result === 'passed' ? null : result.message.slice(0, 1000),
      finished_at: sql<Date>`now()`,
    })
    .where('account_id', '=', payload.accountId)
    .where('connection_id', '=', payload.connectionId)
    .where('check_id', '=', payload.checkId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return updated.numUpdatedRows > 0n;
}

async function retryLater(
  db: Db,
  payload: SessionCheckJobPayload,
  marketplace: Marketplace,
  attempt: number,
  delayMs: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('session_check')
      .set({ attempts: attempt })
      .where('account_id', '=', payload.accountId)
      .where('connection_id', '=', payload.connectionId)
      .where('check_id', '=', payload.checkId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) return;
    await addSessionCheckJob(trx, { ...payload, marketplace }, delayMs);
  });
}
