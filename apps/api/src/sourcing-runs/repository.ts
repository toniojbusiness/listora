/**
 * Sourcing runs (docs/features/thrift-scan.md): one trip to a store, whose scans and kept items
 * belong to it. Every function takes the request's `Tenant` and filters on its account.
 */
import type { SourcingRun } from '@listora/api-contract';
import type { DbExecutor, SourcingRunTable } from '@listora/db';
import { isAppFeatureOn, loadFeatureGate } from '@listora/marketplaces';
import { sql, type Selectable } from 'kysely';

import { notFound } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';

export type SourcingRunRow = Selectable<SourcingRunTable>;

/**
 * Refuses an account the thrift scan is not on for: hidden until it passes live, except in the
 * owner's Test mode (docs/features/verified-features.md), so for anyone else it does not exist.
 */
export async function assertThriftScanOn(db: DbExecutor, tenant: Tenant): Promise<void> {
  const gate = await loadFeatureGate(db, tenant.accountId);
  if (!isAppFeatureOn('thrift_scan', gate)) throw notFound('Thrift scan');
}

export async function insertRun(
  db: DbExecutor,
  tenant: Tenant,
  place: string | null,
): Promise<SourcingRunRow> {
  return db
    .insertInto('sourcing_run')
    .values({
      account_id: tenant.accountId,
      created_by_user_id: tenant.userId,
      place,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findRun(
  db: DbExecutor,
  tenant: Tenant,
  runId: string,
): Promise<SourcingRunRow | undefined> {
  return db
    .selectFrom('sourcing_run')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', runId)
    .executeTakeFirst();
}

/** The run, locked for the rest of the transaction; undefined when the account has none. */
export async function lockRun(
  db: DbExecutor,
  tenant: Tenant,
  runId: string,
): Promise<SourcingRunRow | undefined> {
  return db
    .selectFrom('sourcing_run')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', runId)
    .forUpdate()
    .executeTakeFirst();
}

/** Ends the run; its scans not kept count as skipped. */
export async function endRun(
  db: DbExecutor,
  tenant: Tenant,
  run: SourcingRunRow,
  now: Date,
): Promise<SourcingRunRow> {
  if (run.ended_at !== null) return run;
  await db
    .updateTable('item_scan')
    .set({ decision: 'skipped' })
    .where('account_id', '=', tenant.accountId)
    .where('run_id', '=', run.id)
    .where('decision', '=', 'undecided')
    .execute();
  return db
    .updateTable('sourcing_run')
    .set({ ended_at: now })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', run.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Counts one more scan of the run, and one more kept when `kept`. */
export async function countScan(
  db: DbExecutor,
  tenant: Tenant,
  runId: string,
  what: 'scanned' | 'kept',
): Promise<void> {
  await db
    .updateTable('sourcing_run')
    .set(
      what === 'scanned'
        ? { scan_count: sql<number>`scan_count + 1` }
        : { kept_count: sql<number>`kept_count + 1` },
    )
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', runId)
    .execute();
}

/** Records the run's checkout: the haul it became, and the place and miles of the trip. */
export async function markCheckedOut(
  db: DbExecutor,
  tenant: Tenant,
  runId: string,
  checkout: { haulId: string; place: string | null; miles: number | null; at: Date },
): Promise<SourcingRunRow> {
  return db
    .updateTable('sourcing_run')
    .set({
      haul_id: checkout.haulId,
      place: checkout.place,
      miles: checkout.miles,
      checked_out_at: checkout.at,
    })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', runId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function runView(row: SourcingRunRow): SourcingRun {
  return {
    id: row.id,
    ...(row.place === null ? {} : { place: row.place }),
    startedAt: row.started_at.toISOString(),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
    scanCount: row.scan_count,
    keptCount: row.kept_count,
    ...(row.checked_out_at === null ? {} : { checkedOutAt: row.checked_out_at.toISOString() }),
    ...(row.haul_id === null ? {} : { haulId: row.haul_id }),
    ...(row.miles === null ? {} : { miles: row.miles }),
  };
}
