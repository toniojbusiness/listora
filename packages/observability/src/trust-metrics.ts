/**
 * Computes the trust metrics (catalog.ts) from committed rows. Reading the database, rather
 * than counting inside the code that changes an operation, means a change that rolls back is
 * never counted, every writer is covered (the worker's steps, a user's confirmation through
 * the API, a later orchestrator), and the numbers do not depend on which process made them.
 */
import { sql } from 'kysely';

import {
  DELETION_COMPLETION_DEADLINE_MS,
  type Db,
  type OperationKind,
  type OperationStatus,
} from '@listora/db';

import type { MetricGroup } from './emf.ts';

/** Settled operations are counted per half-open window `[from, to)` of their settled time. */
export interface MetricsWindow {
  readonly from: Date;
  readonly to: Date;
}

/** Operation kinds that take a listing down. */
export const DELIST_KINDS = ['end', 'mark_sold'] as const satisfies readonly OperationKind[];

/** Unfinished statuses whose count and age are published per status. */
export const STUCK_STATUSES = [
  'verifying',
  'retrying',
  'needs_user_action',
] as const satisfies readonly OperationStatus[];

/** Statuses of an operation the engine still owes a verified result (not the user). */
export const UNVERIFIED_STATUSES = [
  'queued',
  'running',
  'retrying',
  'verifying',
] as const satisfies readonly OperationStatus[];

/** Connection statuses that only the seller can fix, by linking the marketplace again. */
export const RELINK_STATUSES = ['reauth_required', 'revoked'] as const;

const MICROS_PER_DOLLAR = 1_000_000;

function isDelist(kind: OperationKind): boolean {
  return (DELIST_KINDS as readonly OperationKind[]).includes(kind);
}

/**
 * Operations that succeeded or failed in the window, timestamped at its start:
 * `VerifiedSuccess` and `OperationFailed` per marketplace and kind (`VerifiedSuccess` per
 * marketplace too), `DelistFailed` when any delist settled, `DelistLatency` per marketplace
 * for delists after a sale, and `DelistEverywhereLatency` for each sale whose last delist
 * settled then.
 */
export async function collectSettledOperations(
  db: Db,
  window: MetricsWindow,
): Promise<MetricGroup[]> {
  const rows = await db
    .selectFrom('operation_event as event')
    .innerJoin('marketplace_operation as op', (join) =>
      join
        .onRef('op.account_id', '=', 'event.account_id')
        .onRef('op.id', '=', 'event.operation_id'),
    )
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'op.account_id')
        .onRef('listing.id', '=', 'op.listing_id'),
    )
    .leftJoin('delist_run as run', (join) =>
      join.onRef('run.account_id', '=', 'op.account_id').onRef('run.id', '=', 'op.delist_run_id'),
    )
    .leftJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'run.account_id').onRef('sale.id', '=', 'run.sale_id'),
    )
    .select([
      'event.to_status as status',
      'event.created_at as settledAt',
      'op.kind as kind',
      'listing.marketplace as marketplace',
      'sale.created_at as saleRecordedAt',
      'run.id as runId',
    ])
    .where('event.to_status', 'in', ['succeeded', 'failed'])
    .where('event.created_at', '>=', window.from)
    .where('event.created_at', '<', window.to)
    .orderBy('event.created_at')
    .orderBy('event.id')
    .execute();

  const outcomes = new Map<string, { marketplace: string; kind: string; verified: number[] }>();
  const latencies = new Map<string, number[]>();
  const runsSettled = new Set<string>();
  let delists = 0;
  let delistFailures = 0;
  for (const row of rows) {
    const succeeded = row.status === 'succeeded';
    const key = `${row.marketplace}/${row.kind}`;
    const outcome = outcomes.get(key) ?? {
      marketplace: row.marketplace,
      kind: row.kind,
      verified: [],
    };
    outcome.verified.push(succeeded ? 1 : 0);
    outcomes.set(key, outcome);
    if (!isDelist(row.kind)) continue;
    delists += 1;
    if (!succeeded) delistFailures += 1;
    if (succeeded && row.runId !== null) runsSettled.add(row.runId);
    if (succeeded && row.saleRecordedAt !== null) {
      const latency = Math.max(0, row.settledAt.getTime() - row.saleRecordedAt.getTime());
      const values = latencies.get(row.marketplace) ?? [];
      values.push(latency);
      latencies.set(row.marketplace, values);
    }
  }

  const timestamp = window.from;
  const groups: MetricGroup[] = [...outcomes.values()].flatMap(
    ({ marketplace, kind, verified }) => {
      const dimensions = { Marketplace: marketplace, Kind: kind };
      return [
        { timestamp, dimensions, values: { VerifiedSuccess: verified } },
        {
          timestamp,
          dimensions,
          values: { OperationFailed: [verified.filter((value) => value === 0).length] },
        },
      ];
    },
  );
  if (delists > 0) {
    groups.push({ timestamp, dimensions: {}, values: { DelistFailed: [delistFailures] } });
  }
  for (const [marketplace, values] of latencies) {
    groups.push({
      timestamp,
      dimensions: { Marketplace: marketplace },
      values: { DelistLatency: values },
    });
  }
  const everywhere = await delistedEverywhereLatencies(db, window, [...runsSettled]);
  if (everywhere.length > 0) {
    groups.push({ timestamp, dimensions: {}, values: { DelistEverywhereLatency: everywhere } });
  }
  return groups;
}

/**
 * From the sale being recorded to its item's last other listing delisted and confirmed, for
 * each of `runIds` whose last delist settled in the window and whose every delist succeeded.
 */
async function delistedEverywhereLatencies(
  db: Db,
  window: MetricsWindow,
  runIds: readonly string[],
): Promise<number[]> {
  if (runIds.length === 0) return [];
  const { rows } = await sql<{ saleRecordedAt: Date; lastSettledAt: Date | null; done: boolean }>`
    select sale.created_at as "saleRecordedAt",
      bool_and(op.status = 'succeeded') as done,
      max((
        select max(event.created_at) from operation_event as event
        where event.account_id = op.account_id and event.operation_id = op.id
          and event.to_status = 'succeeded'
      )) as "lastSettledAt"
    from marketplace_operation as op
    join delist_run as run on run.account_id = op.account_id and run.id = op.delist_run_id
    join sale on sale.account_id = run.account_id and sale.id = run.sale_id
    where op.delist_run_id = any(${[...runIds]}::uuid[])
    group by run.id, sale.created_at
  `.execute(db);
  return rows.flatMap((row) =>
    row.done &&
    row.lastSettledAt !== null &&
    row.lastSettledAt >= window.from &&
    row.lastSettledAt < window.to
      ? [Math.max(0, row.lastSettledAt.getTime() - row.saleRecordedAt.getTime())]
      : [],
  );
}

/**
 * The state at `now`: unfinished operations (count and oldest age per stuck status, and the
 * oldest unverified one), each account's AI cost today (UTC), and connection health.
 */
export async function collectCurrentState(db: Db, now: Date): Promise<MetricGroup[]> {
  const { rows: unfinished } = await sql<{
    status: OperationStatus;
    count: number;
    oldestSeconds: number;
  }>`
    select op.status, count(*)::int as count,
      extract(epoch from max(${now}::timestamptz - coalesce(queued.at, op.created_at)))::float8
        as "oldestSeconds"
    from marketplace_operation as op
    -- Since the operation was last queued: created, or retried by the user.
    left join lateral (
      select max(event.created_at) as at
      from operation_event as event
      where event.account_id = op.account_id and event.operation_id = op.id
        and event.to_status = 'queued'
    ) as queued on true
    where op.status in (${sql.join([...new Set([...UNVERIFIED_STATUSES, ...STUCK_STATUSES])])})
    group by op.status
  `.execute(db);
  const byStatus = new Map(
    unfinished.map((row) => [
      row.status,
      { count: row.count, oldestSeconds: Math.max(0, Math.floor(row.oldestSeconds)) },
    ]),
  );
  const oldestSeconds = (status: OperationStatus): number =>
    byStatus.get(status)?.oldestSeconds ?? 0;

  const groups: MetricGroup[] = STUCK_STATUSES.map((status) => ({
    timestamp: now,
    dimensions: { Status: status },
    values: {
      StuckOperations: [byStatus.get(status)?.count ?? 0],
      OldestStuckOperationAge: [oldestSeconds(status)],
    },
  }));
  groups.push({
    timestamp: now,
    dimensions: {},
    values: {
      OldestUnverifiedOperationAge: [Math.max(...UNVERIFIED_STATUSES.map(oldestSeconds))],
    },
  });

  const spend = await db
    .selectFrom('ai_usage_daily')
    .select(['account_id as accountId', 'cost_micros as costMicros'])
    .where('usage_date', '=', sql<string>`(${now}::timestamptz at time zone 'UTC')::date`)
    .where('cost_micros', '>', 0)
    .orderBy('account_id')
    .execute();
  for (const { accountId, costMicros } of spend) {
    groups.push({
      timestamp: now,
      dimensions: { AccountId: accountId },
      values: { AiDailyCostUsd: [costMicros / MICROS_PER_DOLLAR] },
    });
  }

  const connections = await db
    .selectFrom('marketplace_connection')
    .select((eb) => ['marketplace', 'status', eb.fn.countAll<string>().as('count')])
    .groupBy(['marketplace', 'status'])
    .orderBy('marketplace')
    .orderBy('status')
    .execute();
  let needingRelink = 0;
  for (const { marketplace, status, count } of connections) {
    groups.push({
      timestamp: now,
      dimensions: { Marketplace: marketplace, Status: status },
      values: { MarketplaceConnections: [Number(count)] },
    });
    if ((RELINK_STATUSES as readonly string[]).includes(status)) needingRelink += Number(count);
  }
  groups.push({
    timestamp: now,
    dimensions: {},
    values: { ConnectionsNeedingRelink: [needingRelink] },
  });

  const unhealthy = await db
    .selectFrom('sale_check_schedule as schedule')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'schedule.account_id')
        .onRef('connection.id', '=', 'schedule.connection_id'),
    )
    .select((eb) => ['schedule.marketplace', eb.fn.countAll<string>().as('count')])
    .where('schedule.health', '<>', 'healthy')
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded'])
    .groupBy('schedule.marketplace')
    .orderBy('schedule.marketplace')
    .execute();
  for (const { marketplace, count } of unhealthy) {
    groups.push({
      timestamp: now,
      dimensions: { Marketplace: marketplace },
      values: { UnhealthySaleChecks: [Number(count)] },
    });
  }

  const overdueBefore = new Date(now.getTime() - DELETION_COMPLETION_DEADLINE_MS);
  const overdue = await db
    .selectFrom('account_deletion')
    .select('id')
    .where('requested_at', '<', overdueBefore)
    .unionAll(
      db.selectFrom('connection_deletion').select('id').where('requested_at', '<', overdueBefore),
    )
    .execute();
  groups.push({
    timestamp: now,
    dimensions: {},
    values: { OverdueDeletions: [overdue.length] },
  });
  return groups;
}
