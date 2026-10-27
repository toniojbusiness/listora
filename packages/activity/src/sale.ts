/**
 * Why a sale happened the way it did (docs/features/activity.md): how Listora learned of it
 * (which sale check saw it, where and when, or the marketplace's notification, a forwarded
 * email, the seller's entry), when it was recorded, what delist ran on each other marketplace
 * and how each ended, and the whole timeline of it. For the seller's "How Listora found this
 * sale" and for an operator digging into a sale that went wrong.
 */
import type {
  AutomationRunHost,
  DbExecutor,
  Marketplace,
  OperationKind,
  OperationStatus,
  SaleCheckReason,
  SaleCheckRunKind,
  SaleDetectionSource,
  SuccessEvidence,
  UserTaskStatus,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import type { ActivityEntry } from './entry.ts';
import { loadActivity } from './load.ts';
import { saleDetectionWords } from './words.ts';

export interface SaleCheckSummary {
  id: string;
  kind: SaleCheckRunKind;
  reason: SaleCheckReason | null;
  host: AutomationRunHost;
  startedAt: Date;
  finishedAt: Date | null;
  ordersSeen: number | null;
  newOrders: number | null;
  /** The browser session that read the orders, while its record is kept. */
  runId: string | null;
}

export interface SaleDelist {
  itemId: string;
  marketplace: Marketplace;
  listingId: string | null;
  /** The delist operation, or the seller's task for an assisted listing. */
  operationId: string | null;
  taskId: string | null;
  kind: OperationKind | null;
  status: OperationStatus | UserTaskStatus;
  /** What happened, in the seller's words. */
  result: string;
  attempts: number | null;
  error: { code: string; message: string } | null;
  startedAt: Date;
  /** When it settled (succeeded, failed, done, dismissed, canceled); null while it runs. */
  settledAt: Date | null;
}

export interface SaleExplanation {
  saleId: string;
  marketplace: Marketplace;
  externalOrderId: string | null;
  soldAt: Date;
  recordedAt: Date;
  detectionSource: SaleDetectionSource;
  /** How Listora learned of it, in the seller's words. */
  detection: string;
  /** The sale check that saw it, while its record is kept. */
  check: SaleCheckSummary | null;
  /** When the marketplace's notification, the check's order, or the email arrived. */
  reportedAt: Date | null;
  delists: SaleDelist[];
  entries: ActivityEntry[];
}

const SETTLED: readonly string[] = ['succeeded', 'failed', 'canceled', 'done', 'dismissed'];

/** The explanation of one of the account's sales, or `undefined` when it has no such sale. */
export async function loadSaleExplanation(
  db: DbExecutor,
  sale: { accountId: string; saleId: string },
  options: { limit?: number } = {},
): Promise<SaleExplanation | undefined> {
  const row = await db
    .selectFrom('sale')
    .leftJoin('sale_check_run as check', (join) =>
      join
        .onRef('check.account_id', '=', 'sale.account_id')
        .onRef('check.id', '=', 'sale.sale_check_run_id'),
    )
    .leftJoin('inbound_event as event', (join) =>
      join
        .onRef('event.account_id', '=', 'sale.account_id')
        .onRef('event.id', '=', 'sale.inbound_event_id'),
    )
    .select([
      'sale.id',
      'sale.marketplace',
      'sale.external_order_id',
      'sale.sold_at',
      'sale.created_at',
      'sale.detection_source',
      'check.id as check_id',
      'check.kind as check_kind',
      'check.reason as check_reason',
      'check.host as check_host',
      'check.started_at as check_started_at',
      'check.finished_at as check_finished_at',
      'check.orders_seen as check_orders_seen',
      'check.new_orders as check_new_orders',
      'check.automation_run_id as check_run_id',
      'event.created_at as reported_at',
    ])
    .where('sale.account_id', '=', sale.accountId)
    .where('sale.id', '=', sale.saleId)
    .executeTakeFirst();
  if (row === undefined) return undefined;

  const check: SaleCheckSummary | null =
    row.check_id === null ||
    row.check_kind === null ||
    row.check_host === null ||
    row.check_started_at === null
      ? null
      : {
          id: row.check_id,
          kind: row.check_kind,
          reason: row.check_reason,
          host: row.check_host,
          startedAt: row.check_started_at,
          finishedAt: row.check_finished_at,
          ordersSeen: row.check_orders_seen,
          newOrders: row.check_new_orders,
          runId: row.check_run_id,
        };
  const [delists, entries] = await Promise.all([
    saleDelists(db, sale),
    loadActivity(db, { ...sale, limit: options.limit ?? 200 }),
  ]);
  return {
    saleId: row.id,
    marketplace: row.marketplace,
    externalOrderId: row.external_order_id,
    soldAt: row.sold_at,
    recordedAt: row.created_at,
    detectionSource: row.detection_source,
    detection: saleDetectionWords(row.detection_source, row.marketplace, check),
    check,
    reportedAt: row.reported_at,
    delists,
    entries,
  };
}

/** Every delist the sale started, an operation or the seller's task, by marketplace. */
async function saleDelists(
  db: DbExecutor,
  sale: { accountId: string; saleId: string },
): Promise<SaleDelist[]> {
  const operations = await db
    .selectFrom('marketplace_operation as op')
    .innerJoin('delist_run as run', (join) =>
      join.onRef('run.account_id', '=', 'op.account_id').onRef('run.id', '=', 'op.delist_run_id'),
    )
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'op.account_id')
        .onRef('listing.id', '=', 'op.listing_id'),
    )
    .select([
      'op.id',
      'op.kind',
      'op.status',
      'op.attempts',
      'op.error_code',
      'op.error_message',
      'op.success_evidence',
      'op.created_at',
      'op.updated_at',
      'run.item_id',
      'listing.id as listing_id',
      'listing.marketplace',
    ])
    .where('op.account_id', '=', sale.accountId)
    .where('run.sale_id', '=', sale.saleId)
    .orderBy('op.created_at')
    .execute();
  const tasks = await db
    .selectFrom('user_task as task')
    .innerJoin('delist_run as run', (join) =>
      join
        .onRef('run.account_id', '=', 'task.account_id')
        .onRef('run.id', '=', 'task.delist_run_id'),
    )
    .leftJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'task.account_id')
        .onRef('listing.id', '=', 'task.listing_id'),
    )
    .select([
      'task.id',
      'task.status',
      'task.created_at',
      'task.completed_at',
      'task.updated_at',
      'run.item_id',
      'listing.id as listing_id',
      'listing.marketplace',
    ])
    .where('task.account_id', '=', sale.accountId)
    .where('run.sale_id', '=', sale.saleId)
    // A task that stands in for an operation is shown with it.
    .where('task.operation_id', 'is', null)
    .orderBy('task.created_at')
    .execute();
  return [
    ...operations.map((op): SaleDelist => ({
      itemId: op.item_id,
      marketplace: op.marketplace,
      listingId: op.listing_id,
      operationId: op.id,
      taskId: null,
      kind: op.kind,
      status: op.status,
      result: delistResult(op.marketplace, op.status, op.success_evidence, op.error_message),
      attempts: op.attempts,
      error:
        op.error_code === null
          ? null
          : { code: op.error_code, message: op.error_message ?? 'It failed.' },
      startedAt: op.created_at,
      settledAt: SETTLED.includes(op.status) ? op.updated_at : null,
    })),
    ...tasks.flatMap((task): SaleDelist[] =>
      task.marketplace === null
        ? []
        : [
            {
              itemId: task.item_id,
              marketplace: task.marketplace,
              listingId: task.listing_id,
              operationId: null,
              taskId: task.id,
              kind: null,
              status: task.status,
              result:
                task.status === 'open'
                  ? `Waiting for you to delist it on ${MARKETPLACE_NAMES[task.marketplace]}.`
                  : task.status === 'done'
                    ? 'Done (you confirmed).'
                    : 'You dismissed it.',
              attempts: null,
              error: null,
              startedAt: task.created_at,
              settledAt: task.status === 'open' ? null : (task.completed_at ?? task.updated_at),
            },
          ],
    ),
  ];
}

/** A delist operation's result, in the seller's words. */
function delistResult(
  marketplace: Marketplace,
  status: OperationStatus,
  evidence: SuccessEvidence | null,
  error: string | null,
): string {
  const name = MARKETPLACE_NAMES[marketplace];
  switch (status) {
    case 'succeeded':
      return evidence === 'user_confirmation'
        ? 'Done (you confirmed).'
        : `Delisted (confirmed by ${name}).`;
    case 'failed':
      return `Delist failed: ${error ?? 'it failed.'}`;
    case 'needs_user_action':
      return `Waiting for you to delist it on ${name}.`;
    case 'canceled':
      return 'Canceled.';
    case 'queued':
    case 'running':
    case 'retrying':
    case 'verifying':
      return `Delisting on ${name}...`;
    default:
      return assertNever(status, 'operation status');
  }
}
