/**
 * The truth of a delist run, for the app: per listing, what the marketplace confirmed or the
 * user did, read from the run's operations and their tasks every time (docs/features/auto-delist.md).
 *
 * Only two results count as done: `delisted`, which a read-back of the marketplace confirmed,
 * and `user_confirmed`, which the user confirmed for an assisted listing. Everything else (still
 * delisting, being checked, failed, waiting for the user, canceled) keeps the run open, so the
 * run is `completed` only when every listing is one of the two.
 */
import type {
  ConnectionMode,
  ConnectionStatus,
  DbExecutor,
  DelistRunStatus,
  ListingStatus,
  Marketplace,
  OperationKind,
  OperationStatus,
  SaleStatus,
  SuccessEvidence,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import {
  DEFAULT_RETRY_POLICY,
  describeListingStatus,
  maxAttempts,
  type StatusDisplay,
} from '@listora/operations';
import { assertNever } from '@listora/shared';

export const DELIST_RESULT_STATES = [
  'pending',
  'verifying',
  'delisted',
  'user_confirmed',
  'needs_user_action',
  'failed',
  'canceled',
] as const;
export type DelistResultState = (typeof DELIST_RESULT_STATES)[number];

/** The results that count as done; nothing else is ever shown as delisted. */
export const DONE_STATES = ['delisted', 'user_confirmed'] as const satisfies DelistResultState[];

/** The results the SLA re-alerts about: not done, and not stopped by the user. */
export const ALERT_STATES = [
  'pending',
  'verifying',
  'needs_user_action',
  'failed',
] as const satisfies DelistResultState[];

export interface DelistOperationFacts {
  kind: OperationKind;
  status: OperationStatus;
  attempts: number;
  errorMessage: string | null;
  successEvidence: SuccessEvidence | null;
}

export interface DelistResult {
  listingId: string;
  marketplace: Marketplace;
  /**
   * `api` while the listing is on an API connection, `automation` while it is on an automation
   * connection whose browser session works; otherwise the user does the delist.
   */
  mode: 'api' | 'automation' | 'assisted';
  operationId: string;
  operation: DelistOperationFacts;
  /** The attempts the operation gets, for "retry 2 of 6". */
  maxAttempts: number;
  state: DelistResultState;
  display: StatusDisplay;
  /** The assisted delist's task, newest first: the open one, or the one the user finished. */
  userTaskId: string | null;
  updatedAt: Date;
}

export interface DelistRunView {
  id: string;
  accountId: string;
  saleId: string;
  itemId: string;
  /** The marketplace the item sold on. */
  soldOn: Marketplace;
  saleStatus: SaleStatus;
  /** Computed from the results, never read from the stored column (which the SLA job keeps). */
  status: DelistRunStatus;
  display: StatusDisplay;
  results: DelistResult[];
  startedAt: Date;
  /** When the last listing was done, once the run is completed. */
  completedAt: Date | null;
  realertedAt: Date | null;
  escalatedAt: Date | null;
  /** The home-screen banner: 30 minutes passed and the run is still not completed. */
  escalated: boolean;
}

export function delistResultState(
  operation: Pick<DelistOperationFacts, 'status' | 'successEvidence'>,
): DelistResultState {
  switch (operation.status) {
    case 'queued':
    case 'running':
    case 'retrying':
      return 'pending';
    case 'verifying':
      return 'verifying';
    case 'needs_user_action':
      return 'needs_user_action';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'succeeded':
      switch (operation.successEvidence) {
        case 'read_back':
          return 'delisted';
        case 'user_confirmation':
          return 'user_confirmed';
        case null:
          // The database refuses a success without evidence; never show one as done.
          return 'verifying';
        default:
          return assertNever(operation.successEvidence, 'success evidence');
      }
    default:
      return assertNever(operation.status, 'operation status');
  }
}

/**
 * One listing's honest label: `Delisted (confirmed by eBay)` only after a read-back,
 * `Done (you confirmed)` only after the user's confirmation, and otherwise the operation's own
 * progress (`Delisting... retry 2 of 6`, `Checking...`, `Action needed - delist on Poshmark`,
 * `Delist failed - Retry`).
 */
export function describeDelistResult(input: {
  marketplace: Marketplace;
  listingStatus: ListingStatus;
  operation: DelistOperationFacts;
  maxAttempts: number;
}): StatusDisplay {
  const name = MARKETPLACE_NAMES[input.marketplace];
  const state = delistResultState(input.operation);
  if (state === 'delisted') {
    const done = input.operation.kind === 'mark_sold' ? 'Marked sold' : 'Delisted';
    return { tone: 'success', label: `${done} (confirmed by ${name})` };
  }
  if (state === 'canceled') {
    return {
      tone: 'action_needed',
      label: 'Delist canceled',
      detail: `Listora stopped delisting it on ${name}. Check the listing there.`,
    };
  }
  return describeListingStatus({
    marketplace: input.marketplace,
    listingStatus: input.listingStatus,
    operation: input.operation,
    maxAttempts: input.maxAttempts,
  });
}

/** The run's status and summary label, from its results. */
export function summarizeDelistRun(
  results: readonly Pick<DelistResult, 'marketplace' | 'state'>[],
): { status: DelistRunStatus; display: StatusDisplay } {
  if (results.length === 0) {
    return { status: 'completed', display: { tone: 'neutral', label: 'Not listed anywhere else' } };
  }
  const where = (states: readonly DelistResultState[]): string =>
    listNames(results.filter((result) => states.includes(result.state)).map((r) => r.marketplace));
  if (results.every((result) => isDone(result.state))) {
    return { status: 'completed', display: { tone: 'success', label: 'Delisted everywhere' } };
  }
  if (results.some((result) => result.state === 'failed')) {
    return {
      status: 'attention_needed',
      display: { tone: 'failed', label: `Delist failed on ${where(['failed'])} - Retry` },
    };
  }
  if (results.some((result) => result.state === 'needs_user_action')) {
    return {
      status: 'attention_needed',
      display: {
        tone: 'action_needed',
        label: `Action needed - delist on ${where(['needs_user_action'])}`,
      },
    };
  }
  if (results.some((result) => result.state === 'canceled')) {
    return {
      status: 'attention_needed',
      display: { tone: 'action_needed', label: `Delist canceled on ${where(['canceled'])}` },
    };
  }
  return {
    status: 'in_progress',
    display: { tone: 'in_progress', label: `Delisting on ${where(['pending', 'verifying'])}...` },
  };
}

export function isDone(state: DelistResultState): boolean {
  return (DONE_STATES as readonly DelistResultState[]).includes(state);
}

/** "Poshmark", "Poshmark and Mercari", "eBay, Depop, and Mercari". */
export function listNames(marketplaces: readonly Marketplace[]): string {
  const names = [...new Set(marketplaces)].map((marketplace) => MARKETPLACE_NAMES[marketplace]);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`;
}

export type DelistRunScope =
  { runIds: readonly string[] } | { itemIds: readonly string[] } | { saleIds: readonly string[] };

/**
 * The account's delist runs in scope, oldest first, each with its results ordered by
 * marketplace. Runs of another account are never returned.
 */
export async function loadDelistRuns(
  executor: DbExecutor,
  accountId: string,
  scope: DelistRunScope,
): Promise<DelistRunView[]> {
  const ids = 'runIds' in scope ? scope.runIds : 'itemIds' in scope ? scope.itemIds : scope.saleIds;
  if (ids.length === 0) return [];
  const column = 'runIds' in scope ? 'run.id' : 'itemIds' in scope ? 'run.item_id' : 'run.sale_id';
  const runs = await executor
    .selectFrom('delist_run as run')
    .innerJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'run.account_id').onRef('sale.id', '=', 'run.sale_id'),
    )
    .select([
      'run.id',
      'run.account_id',
      'run.sale_id',
      'run.item_id',
      'run.completed_at',
      'run.realerted_at',
      'run.escalated_at',
      'run.created_at',
      'sale.marketplace',
      'sale.status as sale_status',
    ])
    .where('run.account_id', '=', accountId)
    .where(column, 'in', ids)
    .orderBy('run.created_at')
    .orderBy('run.id')
    .execute();
  if (runs.length === 0) return [];

  const operations = await executor
    .selectFrom('marketplace_operation as op')
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'op.account_id')
        .onRef('listing.id', '=', 'op.listing_id'),
    )
    .leftJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'listing.account_id')
        .onRef('connection.id', '=', 'listing.connection_id'),
    )
    .select([
      'op.id',
      'op.delist_run_id',
      'op.kind',
      'op.status',
      'op.attempts',
      'op.error_message',
      'op.success_evidence',
      'op.updated_at',
      'listing.id as listing_id',
      'listing.marketplace',
      'listing.status as listing_status',
      'connection.mode as connection_mode',
      'connection.status as connection_status',
    ])
    .where('op.account_id', '=', accountId)
    .where(
      'op.delist_run_id',
      'in',
      runs.map((run) => run.id),
    )
    .orderBy('listing.marketplace')
    .orderBy('op.created_at')
    .orderBy('op.id')
    .execute();
  const tasks =
    operations.length === 0
      ? []
      : await executor
          .selectFrom('user_task')
          .select(['id', 'operation_id', 'status'])
          .where('account_id', '=', accountId)
          .where(
            'delist_run_id',
            'in',
            runs.map((run) => run.id),
          )
          .where('operation_id', 'is not', null)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .execute();
  const taskFor = new Map<string, string>();
  for (const task of tasks) {
    if (task.operation_id === null) continue;
    // The newest task, unless an older one is still open (a Retry adds another).
    const current = taskFor.get(task.operation_id);
    if (current === undefined || task.status === 'open') taskFor.set(task.operation_id, task.id);
  }

  const max = maxAttempts(DEFAULT_RETRY_POLICY);
  const resultsFor = new Map<string, DelistResult[]>();
  for (const op of operations) {
    if (op.delist_run_id === null) continue;
    const operation: DelistOperationFacts = {
      kind: op.kind,
      status: op.status,
      attempts: op.attempts,
      errorMessage: op.error_message,
      successEvidence: op.success_evidence,
    };
    const result: DelistResult = {
      listingId: op.listing_id,
      marketplace: op.marketplace,
      mode: delistMode(op.connection_mode, op.connection_status),
      operationId: op.id,
      operation,
      maxAttempts: max,
      state: delistResultState(operation),
      display: describeDelistResult({
        marketplace: op.marketplace,
        listingStatus: op.listing_status,
        operation,
        maxAttempts: max,
      }),
      userTaskId: taskFor.get(op.id) ?? null,
      updatedAt: op.updated_at,
    };
    const list = resultsFor.get(op.delist_run_id) ?? [];
    list.push(result);
    resultsFor.set(op.delist_run_id, list);
  }

  return runs.map((run) => {
    const results = resultsFor.get(run.id) ?? [];
    const { status, display } = summarizeDelistRun(results);
    const lastDone = results.reduce<Date>(
      (latest, result) => (result.updatedAt > latest ? result.updatedAt : latest),
      run.created_at,
    );
    return {
      id: run.id,
      accountId: run.account_id,
      saleId: run.sale_id,
      itemId: run.item_id,
      soldOn: run.marketplace,
      saleStatus: run.sale_status,
      status,
      display,
      results,
      startedAt: run.created_at,
      completedAt: status === 'completed' ? (run.completed_at ?? lastDone) : null,
      realertedAt: run.realerted_at,
      escalatedAt: run.escalated_at,
      escalated: run.escalated_at !== null && status !== 'completed',
    };
  });
}

/** How a listing's delist is done, under its connection (as listing views say it). */
function delistMode(
  mode: ConnectionMode | null,
  status: ConnectionStatus | null,
): DelistResult['mode'] {
  if (mode === 'api') return 'api';
  // A session waiting to be relinked leaves the delist to the user.
  if (mode === 'automation' && (status === 'connected' || status === 'degraded')) {
    return 'automation';
  }
  return 'assisted';
}
