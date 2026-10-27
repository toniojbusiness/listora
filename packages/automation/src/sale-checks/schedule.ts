/**
 * Sale-check scheduling in Postgres (`sale_check_schedule`, one row per automation connection)
 * and the check's job in the job queue. The worker's dispatch task (dispatch.ts) adds the job
 * of every check that is due; the browser runner runs it (job.ts) and schedules the next one.
 * A forwarded sale email asks for a check at once (`requestSaleCheck`), so the sale is seen on
 * the marketplace and the delist starts without waiting for the schedule.
 */
import { sql } from 'kysely';

import type { DbExecutor, Marketplace, SaleCheckReason, SaleCheckRunKind } from '@listora/db';
import { inTransaction } from '@listora/db';

/** The browser runner's task that checks one connection for sales (job.ts). */
export const SALE_CHECK_TASK = 'automation_sale_check';

export interface SaleCheckJobPayload {
  accountId: string;
  connectionId: string;
  /** A read-only read of the seller's sold history (job.ts) instead of a sale check. */
  history?: boolean;
}

export function isSaleCheckJobPayload(value: unknown): value is SaleCheckJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, connectionId, history } = value as Record<string, unknown>;
  return (
    typeof accountId === 'string' &&
    typeof connectionId === 'string' &&
    (history === undefined || typeof history === 'boolean')
  );
}

export function saleCheckJobKey(
  connectionId: string,
  kind: SaleCheckRunKind = 'scheduled',
): string {
  return kind === 'history' ? `sale-history:${connectionId}` : `sale-check:${connectionId}`;
}

export interface ScheduledCheck {
  accountId: string;
  connectionId: string;
  marketplace: Marketplace;
}

/** Sets when the connection's next check is due, and why. */
export async function scheduleSaleCheck(
  executor: DbExecutor,
  check: ScheduledCheck & { at: Date | 'now'; reason: SaleCheckReason },
): Promise<void> {
  const at = check.at === 'now' ? sql<Date>`now()` : check.at;
  await executor
    .insertInto('sale_check_schedule')
    .values({
      account_id: check.accountId,
      connection_id: check.connectionId,
      marketplace: check.marketplace,
      next_check_at: at,
      next_reason: check.reason,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'connection_id']).doUpdateSet({
        next_check_at: at,
        next_reason: check.reason,
      }),
    )
    .execute();
}

/**
 * Adds the connection's check job (or, with `kind` `history`, its read of the sold history)
 * unless one is already waiting or running; returns whether it added one.
 */
export async function enqueueSaleCheck(
  executor: DbExecutor,
  check: ScheduledCheck,
  kind: SaleCheckRunKind = 'scheduled',
): Promise<boolean> {
  const connection = await executor
    .selectFrom('marketplace_connection')
    .select('runs_on')
    .where('account_id', '=', check.accountId)
    .where('id', '=', check.connectionId)
    .executeTakeFirst();
  // The connection's automated steps run on the phone, so its sales are checked there too.
  if (connection?.runs_on === 'phone') return queueSaleCheckForPhone(executor, check, kind);
  const key = saleCheckJobKey(check.connectionId, kind);
  const { rows } = await sql<{ id: string }>`
    select id from graphile_worker.jobs where key = ${key} limit 1
  `.execute(executor);
  if (rows.length > 0) return false;
  const payload: SaleCheckJobPayload = {
    accountId: check.accountId,
    connectionId: check.connectionId,
    ...(kind === 'history' ? { history: true } : {}),
  };
  await sql`
    select graphile_worker.add_job(
      identifier => ${SALE_CHECK_TASK},
      payload => ${JSON.stringify(payload)}::json,
      max_attempts => 3,
      job_key => ${key},
      job_key_mode => 'preserve_run_at'
    )
  `.execute(executor);
  return true;
}

/** Phone work runs lowest first, as jobs do (delists after a sale are -10). */
const PHONE_SALE_CHECK_PRIORITY = -5;

/** A read of the sold history waits behind routine changes: it decides nothing. */
const PHONE_SALE_HISTORY_PRIORITY = 5;

/**
 * Hands the connection's sale check (or its read of the sold history) to the phone
 * (docs/features/phone-execution.md), unless it waits there already; returns whether it added
 * it.
 */
export async function queueSaleCheckForPhone(
  executor: DbExecutor,
  check: ScheduledCheck,
  kind: SaleCheckRunKind = 'scheduled',
): Promise<boolean> {
  const purpose = kind === 'history' ? 'sale_history' : 'sale_check';
  const added = await executor
    .insertInto('phone_work')
    .values({
      account_id: check.accountId,
      connection_id: check.connectionId,
      marketplace: check.marketplace,
      purpose,
      // A sale check goes ahead of routine changes: a sale it finds starts delists.
      priority: kind === 'history' ? PHONE_SALE_HISTORY_PRIORITY : PHONE_SALE_CHECK_PRIORITY,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'connection_id']).where('purpose', '=', purpose).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return added !== undefined;
}

/**
 * A forwarded sale email says something sold on the marketplace: check the seller's automation
 * connection there now. Returns whether there was a working connection to check (without one,
 * the email's sale goes through the sale intake alone).
 */
export async function requestSaleCheck(
  executor: DbExecutor,
  request: { accountId: string; marketplace: Marketplace },
): Promise<boolean> {
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', request.accountId)
      .where('marketplace', '=', request.marketplace)
      .where('mode', '=', 'automation')
      .where('status', 'in', ['connected', 'degraded'])
      .executeTakeFirst();
    if (connection === undefined) return false;
    const check = {
      accountId: request.accountId,
      connectionId: connection.id,
      marketplace: request.marketplace,
    };
    await scheduleSaleCheck(trx, { ...check, at: 'now', reason: 'email' });
    await enqueueSaleCheck(trx, check);
    return true;
  });
}

/**
 * Asks for a read-only read of the seller's sold history on the marketplace
 * (docs/features/activity.md): it reads every sold order the pages show and records what it
 * read, without handing any to the sale intake. Returns the connection it will read, or `null`
 * when the account has no working automation connection there.
 */
export async function requestSaleHistoryRead(
  executor: DbExecutor,
  request: { accountId: string; marketplace: Marketplace },
): Promise<{ connectionId: string; runsOn: 'cloud' | 'phone'; queued: boolean } | null> {
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .selectFrom('marketplace_connection')
      .innerJoin('sale_check_schedule as schedule', (join) =>
        join
          .onRef('schedule.account_id', '=', 'marketplace_connection.account_id')
          .onRef('schedule.connection_id', '=', 'marketplace_connection.id'),
      )
      .select(['marketplace_connection.id', 'marketplace_connection.runs_on'])
      .where('marketplace_connection.account_id', '=', request.accountId)
      .where('marketplace_connection.marketplace', '=', request.marketplace)
      .where('marketplace_connection.mode', '=', 'automation')
      .where('marketplace_connection.status', 'in', ['connected', 'degraded'])
      .executeTakeFirst();
    if (connection === undefined) return null;
    const queued = await enqueueSaleCheck(
      trx,
      {
        accountId: request.accountId,
        connectionId: connection.id,
        marketplace: request.marketplace,
      },
      'history',
    );
    return { connectionId: connection.id, runsOn: connection.runs_on, queued };
  });
}

/** Checks that are due, on connections that can be checked, oldest first. */
export async function dueSaleChecks(executor: DbExecutor, limit = 100): Promise<ScheduledCheck[]> {
  const rows = await executor
    .selectFrom('sale_check_schedule as schedule')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'schedule.account_id')
        .onRef('connection.id', '=', 'schedule.connection_id'),
    )
    .select(['schedule.account_id', 'schedule.connection_id', 'schedule.marketplace'])
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded'])
    .where('schedule.next_check_at', '<=', sql<Date>`now()`)
    .orderBy('schedule.next_check_at')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    accountId: row.account_id,
    connectionId: row.connection_id,
    marketplace: row.marketplace,
  }));
}
