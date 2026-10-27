/**
 * Sale-check health (docs/features/activity.md): a missed sale is never silent. Each automation
 * connection's schedule keeps whether its sale checks work. A check that works makes it
 * `healthy`; `alertAfterFailures` failed checks in a row make it `failing` (job.ts records
 * both); a check `overdueMs` past due that has not run makes it `overdue` (this job). Either
 * problem shows a Today card and, once per problem, a notification naming the marketplace and
 * the reason, so the seller knows sales there are not being seen and why.
 *
 * The words for a problem live here, so the Today card and the notification say the same.
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
      return `${name}'s sold items page has changed, so Listora couldn't read it.`;
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

/** The title and detail of a problem, the same on Today and in the notification. */
export function saleCheckProblemWords(
  problem: SaleCheckProblem,
  now: Date,
): { title: string; detail: string } {
  const name = MARKETPLACE_NAMES[problem.marketplace];
  const consequence = `Until it can, a sale on ${name} is not delisted elsewhere automatically.`;
  if (problem.health === 'failing') {
    const reason = problem.lastErrorMessage ?? `Listora couldn't read your ${name} sales.`;
    return {
      title: `Listora can't check ${name} for sales`,
      detail: `The last ${String(problem.failuresInARow)} checks failed: ${reason} Listora keeps trying. ${consequence}`,
    };
  }
  const since =
    problem.lastSucceededAt === null
      ? 'yet'
      : `in ${elapsed(now.getTime() - problem.lastSucceededAt.getTime())}`;
  const ask =
    problem.runsOn === 'phone'
      ? `Open Listora on your iPhone so it can check.`
      : 'Listora keeps trying.';
  return {
    title: `Listora hasn't checked ${name} for sales ${since}`,
    detail: `${ask} ${consequence}`,
  };
}

/** The notification for a problem, sent once per problem. */
export function saleCheckProblemNotification(
  accountId: string,
  problem: SaleCheckProblem,
  now: Date,
): PushNotification {
  const words = saleCheckProblemWords(problem, now);
  return {
    accountId,
    category: SALE_CHECKS_CATEGORY,
    title: words.title,
    body: words.detail,
    urgency: 'normal',
    threadId: `sale_checks:${problem.marketplace}`,
    data: { connectionId: problem.connectionId, marketplace: problem.marketplace },
  };
}

/** The connections of an account whose sale checks have a problem, while they still work. */
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
 * One round of the scheduled task: marks the checks that are overdue, then announces every
 * problem not announced yet, one notification per problem (the schedule's `alerted_at`, set in
 * the transaction that queues it). Returns how many it marked and announced.
 */
export async function runSaleCheckHealth(
  deps: SaleCheckHealthDependencies,
): Promise<{ overdue: number; alerted: number }> {
  const { db } = deps;
  const now = new Date(deps.now?.() ?? Date.now());
  const marked = await sql<{ account_id: string; marketplace: Marketplace }>`
    update sale_check_schedule as schedule
    set health = 'overdue', unhealthy_since = schedule.next_check_at
    from marketplace_connection as connection
    where connection.account_id = schedule.account_id
      and connection.id = schedule.connection_id
      and connection.mode = 'automation'
      and connection.status in ('connected', 'degraded')
      and schedule.health = 'healthy'
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
      await enqueuePush(trx, saleCheckProblemNotification(row.account_id, problem, now), {
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

/** A duration in whole hours (or minutes under an hour), for "in 8 hours". */
function elapsed(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  return `${String(Math.floor(hours / 24))} days`;
}
