/**
 * Sale-check health (docs/features/activity.md): a missed sale is never silent. Each automation
 * connection's schedule keeps whether its sale checks work. A check that works makes it
 * `healthy`; `alertAfterFailures` failed checks in a row make it `failing` (job.ts records
 * both); a check `overdueMs` past due that has not run makes it `overdue` (this job). Either
 * problem raises the owner's `sale-checks-unhealthy` alarm and shows in the support views
 * (`admin sale-checks`). It is Listora's to fix, so the seller is told only when they can fix
 * it: once per problem, a notification asks them to open Listora when the checks run on their
 * iPhone and it has not been opened. Nothing else reaches Today or a notification.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  type Db,
  type DbExecutor,
  type ExecutionLocation,
  type Marketplace,
  type SaleCheckHealth,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { enqueuePush, type PushNotification } from '@listora/push';
import type { Logger } from '@listora/shared';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import type { SaleCheckSettings } from '../settings.ts';
import { verifiedSaleCheckMarketplaces } from './schedule.ts';

/** The worker's scheduled task that marks overdue checks and announces problems. */
export const SALE_CHECK_HEALTH_TASK = 'sale_check_health';
/** Every 5 minutes (UTC crontab fields). */
export const SALE_CHECK_HEALTH_SCHEDULE = '*/5 * * * *';

/** The app's notification category; tapping it opens Today. */
export const SALE_CHECKS_CATEGORY = 'sale_checks_need_attention';

/** Why a sale check failed: a short code for operators and words for the seller. */
export interface SaleCheckError {
  code: string;
  /** Names the marketplace; safe to show the seller. */
  message: string;
}

/** What a sale check's error was, in words the seller understands. */
export function saleCheckError(error: unknown, marketplace: Marketplace): SaleCheckError {
  const code = error instanceof AutomationReadError ? error.code : 'error';
  return { code: code.slice(0, 100), message: saleCheckErrorMessage(code, marketplace) };
}

/** The seller's words for a failed check's code. */
export function saleCheckErrorMessage(code: string, marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  switch (code) {
    case 'element_missing':
      return `Listora couldn't read ${name}'s sold items page.`;
    case 'step_timeout':
    case 'timeout':
      return `${name}'s pages took too long to load.`;
    case 'rate_limited':
      return `${name} asked Listora to slow down.`;
    case 'server_error':
      return `${name} had a problem showing your sales.`;
    case 'unreachable':
      return `Listora couldn't reach ${name}.`;
    case 'browser_unavailable':
      return `Listora's browser didn't start. The problem is on Listora's side, not ${name}'s.`;
    case 'stopped_for_check':
      return `${name} wants you to complete a check in Listora on your iPhone.`;
    case 'aborted':
    case 'phone_stopped':
    case 'interrupted':
      return 'The check stopped before it finished.';
    case 'no_session':
      return `Listora has no ${name} sign-in to check with.`;
    case 'automation_paced':
    case 'automation_busy':
      return `Listora was busy in your ${name} account.`;
    case 'captcha':
    case 'bot_check':
    case 'login_challenge':
    case 'session_rejected':
    case 'unexpected_page':
      return `${name} asked Listora to sign in again.`;
    case 'unsupported':
      return `Listora can't read ${name} sales yet.`;
    default:
      return `Listora couldn't read your ${name} sales.`;
  }
}

/** One connection whose sale checks have a problem, as Today and the notification tell it. */
export interface SaleCheckProblem {
  connectionId: string;
  marketplace: Marketplace;
  health: Exclude<SaleCheckHealth, 'healthy'>;
  failuresInARow: number;
  /** The last failure's words (`saleCheckErrorMessage`), if a check failed. */
  lastErrorMessage: string | null;
  lastSucceededAt: Date | null;
  unhealthySince: Date;
  runsOn: ExecutionLocation;
}

/**
 * The seller's notification for a problem, or null when there is nothing they can do about it.
 * The one problem only the seller can fix is checks that run on their iPhone and are overdue
 * because Listora has not been opened there; a check that fails is Listora's own problem.
 */
export function saleCheckProblemNotification(
  accountId: string,
  problem: SaleCheckProblem,
): PushNotification | null {
  if (problem.runsOn !== 'phone' || problem.health !== 'overdue') return null;
  const name = MARKETPLACE_NAMES[problem.marketplace];
  return {
    accountId,
    category: SALE_CHECKS_CATEGORY,
    title: `Open Listora to keep ${name} in sync`,
    body: `Listora checks your ${name} sales from your iPhone. Open the app so a sale there is delisted everywhere else.`,
    urgency: 'normal',
    threadId: `sale_checks:${problem.marketplace}`,
    data: { connectionId: problem.connectionId, marketplace: problem.marketplace },
  };
}

/**
 * The connections of an account whose sale checks have a problem, while they still work: the
 * support views' and the health task's, never a screen the seller sees.
 */
export async function loadSaleCheckProblems(
  db: DbExecutor,
  accountId: string,
): Promise<SaleCheckProblem[]> {
  const rows = await db
    .selectFrom('sale_check_schedule as schedule')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'schedule.account_id')
        .onRef('connection.id', '=', 'schedule.connection_id'),
    )
    .select([
      'schedule.connection_id',
      'schedule.marketplace',
      'schedule.health',
      'schedule.failures_in_a_row',
      'schedule.last_error_message',
      'schedule.last_succeeded_at',
      'schedule.unhealthy_since',
      'connection.runs_on',
    ])
    .where('schedule.account_id', '=', accountId)
    .where('schedule.health', '<>', 'healthy')
    // A connection only the seller can fix has its own reconnect card and notification.
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded'])
    .orderBy('schedule.unhealthy_since')
    .execute();
  return rows.map((row) => ({
    connectionId: row.connection_id,
    marketplace: row.marketplace,
    health: row.health === 'failing' ? 'failing' : 'overdue',
    failuresInARow: row.failures_in_a_row,
    lastErrorMessage: row.last_error_message,
    lastSucceededAt: row.last_succeeded_at,
    unhealthySince: row.unhealthy_since ?? new Date(0),
    runsOn: row.runs_on,
  }));
}

export interface SaleCheckHealthDependencies {
  db: Db;
  settings: Pick<SaleCheckSettings, 'overdueMs'>;
  logger: Logger;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

/**
 * One round of the scheduled task: marks the checks that are overdue, then settles every problem
 * not settled yet (the schedule's `alerted_at`): one notification for a problem the seller can
 * fix, queued in the transaction that sets it, and none for the rest. Returns how many it marked
 * and how many sellers it told.
 */
export async function runSaleCheckHealth(
  deps: SaleCheckHealthDependencies,
): Promise<{ overdue: number; alerted: number }> {
  const { db } = deps;
  const now = new Date(deps.now?.() ?? Date.now());
  // A marketplace whose sale checks are hidden is never checked, so never overdue either.
  const checked = verifiedSaleCheckMarketplaces();
  const marked = await sql<{ account_id: string; marketplace: Marketplace }>`
    update sale_check_schedule as schedule
    set health = 'overdue', unhealthy_since = schedule.next_check_at
    from marketplace_connection as connection
    where connection.account_id = schedule.account_id
      and connection.id = schedule.connection_id
      and connection.mode = 'automation'
      and connection.status in ('connected', 'degraded')
      and schedule.health = 'healthy'
      and (
        schedule.marketplace = any(${checked}::text[])
        -- In Test mode (docs/features/test-mode.md) every built check runs, so it can be overdue.
        or exists (
          select 1 from account where account.id = schedule.account_id and account.test_mode
        )
      )
      and schedule.next_check_at < ${now}::timestamptz - make_interval(secs => ${deps.settings.overdueMs / 1000})
    returning schedule.account_id, schedule.marketplace
  `.execute(db);
  const log = deps.logger.child({ task: SALE_CHECK_HEALTH_TASK });
  for (const row of marked.rows) {
    log.warn(
      { event: 'sale_check_overdue', accountId: row.account_id, marketplace: row.marketplace },
      'sale checks are overdue',
    );
  }

  const due = await db
    .selectFrom('sale_check_schedule as schedule')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'schedule.account_id')
        .onRef('connection.id', '=', 'schedule.connection_id'),
    )
    .select(['schedule.account_id', 'schedule.connection_id'])
    .where('schedule.health', '<>', 'healthy')
    .where('schedule.alerted_at', 'is', null)
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded'])
    .orderBy('schedule.unhealthy_since')
    .limit(500)
    .execute();
  let alerted = 0;
  for (const row of due) {
    const sent = await inTransaction(db, async (trx) => {
      const claimed = await trx
        .updateTable('sale_check_schedule')
        .set({ alerted_at: now })
        .where('account_id', '=', row.account_id)
        .where('connection_id', '=', row.connection_id)
        .where('health', '<>', 'healthy')
        .where('alerted_at', 'is', null)
        .returning('unhealthy_since')
        .executeTakeFirst();
      if (claimed === undefined || claimed.unhealthy_since === null) return false;
      const problem = (await loadSaleCheckProblems(trx, row.account_id)).find(
        (candidate) => candidate.connectionId === row.connection_id,
      );
      if (problem === undefined) return false;
      const notification = saleCheckProblemNotification(row.account_id, problem);
      if (notification === null) return false;
      await enqueuePush(trx, notification, {
        key: `sale_checks:${row.connection_id}:${String(claimed.unhealthy_since.getTime())}`,
      });
      log.warn(
        {
          event: 'sale_check_alert',
          accountId: row.account_id,
          connectionId: row.connection_id,
          marketplace: problem.marketplace,
          health: problem.health,
          failuresInARow: problem.failuresInARow,
        },
        'told the seller their sale checks have a problem',
      );
      return true;
    });
    if (sent) alerted += 1;
  }
  return { overdue: marked.rows.length, alerted };
}
