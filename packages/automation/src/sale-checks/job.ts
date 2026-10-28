/**
 * The sale check (decision D1), run by the browser runner or, for a connection that runs on the
 * phone, by the server with the phone's answers (phone/work.ts): it reads the seller's sold
 * orders on the marketplace through their browser session, hands each new one to the sale
 * intake (an `inbound_event`, source `poll`, once per order, and the worker's job that records
 * its sale and starts its auto-delist, orders.ts), and schedules the next check from the
 * seller's sales history (interval.ts).
 *
 * Every check is recorded as a `sale_check_run` (docs/features/activity.md): where and when it
 * ran, what it read, how many sold orders it saw and handed over, and why it failed. Its outcome
 * also moves the connection's sale-check health (health.ts). A check that met a check
 * automation must not pass has left the connection waiting for a relink (the dispatcher skips
 * it until then, and the relink checks at once); one that failed otherwise tries again after
 * the minimum interval. Only a database failure throws, and the job queue then runs it again.
 *
 * A connection's first check (no `checked_through` yet) reads the seller's sales history: every
 * sold order the pages show, up to the adapter's history limit, each handed over like a new one
 * (docs/features/sales.md, "Sales history").
 *
 * A `history` read is the same read with nothing handed over: it reads every sold order the
 * pages show and records what it saw, to prove a marketplace's sale check reads the seller's
 * real sold items, without acting on any of them and without touching the schedule.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type AutomationRunHost,
  type DbExecutor,
  type ExecutionLocation,
  type JsonArray,
  type Marketplace,
  type SaleCheckReason,
  type SaleCheckRunKind,
} from '@listora/db';
import type {
  AdapterLookup,
  ConnectionRef,
  MarketplaceAdapter,
  RemoteOrder,
} from '@listora/marketplaces';
import { recordInboundEvent } from '@listora/sales';
import type { Logger } from '@listora/shared';

import type { SaleCheckSettings } from '../settings.ts';
import { readFailure, recordReadFailed, recordReadSucceeded } from '../read-health/health.ts';
import { saleCheckError, saleCheckErrorMessage } from './health.ts';
import { nextSaleCheckDelay, SALE_HISTORY_DAYS } from './interval.ts';
import { orderEventPayload, queueSaleOrder } from './orders.ts';
import { checksSales, queueSaleCheckForPhone, type SaleCheckJobPayload } from './schedule.ts';
import { queueSoldItemPhotos } from './sold-photos.ts';

export interface SaleCheckDependencies {
  db: DbExecutor;
  adapters: AdapterLookup;
  settings: SaleCheckSettings;
  logger: Logger;
  /** The deadline of one check (default 5 minutes). */
  timeoutMs?: number;
}

/** Orders from a little before the last check, in case one showed up late. */
const OVERLAP_MS = 24 * 3_600_000;
/** Orders a check's record keeps of what it read (newest first). */
const RECORDED_ORDERS = 100;

export async function runSaleCheck(
  deps: SaleCheckDependencies,
  payload: SaleCheckJobPayload,
  signal: AbortSignal,
): Promise<void> {
  const kind: SaleCheckRunKind = payload.history === true ? 'history' : 'scheduled';
  const prepared = await prepareSaleCheck(deps, payload, kind);
  if (prepared === null) return;
  if (prepared.runsOn === 'phone') {
    // The connection's automated steps moved to the phone: its sales are checked there now.
    await queueSaleCheckForPhone(
      deps.db,
      { ...prepared.key, marketplace: prepared.marketplace },
      kind,
    );
    return;
  }
  const started = await startSaleCheckRun(deps.db, prepared, 'runner');
  let orders: RemoteOrder[];
  try {
    orders = await started.adapter.listOrdersSince(started.since, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? 300_000)]),
      connection: started.connection,
    });
  } catch (error) {
    await recordSaleCheckFailure(deps, started, error);
    return;
  }
  await recordSaleCheckOrders(deps, started, orders);
}

/** A sale check ready to read the seller's orders. */
export interface PreparedSaleCheck {
  key: { accountId: string; connectionId: string };
  marketplace: Marketplace;
  connection: ConnectionRef;
  adapter: MarketplaceAdapter & Required<Pick<MarketplaceAdapter, 'listOrdersSince'>>;
  kind: SaleCheckRunKind;
  /** Why a scheduled check runs now (the schedule's reason). */
  reason: SaleCheckReason;
  /** Orders sold at or after this time (a little before the last check), or every one shown. */
  since: Date | null;
  checkedThrough: Date | null;
  runsOn: ExecutionLocation;
}

/** A prepared check with its record (`sale_check_run`), which its result finishes. */
export interface StartedSaleCheck extends PreparedSaleCheck {
  runId: string;
}

/**
 * The check to run, started (`last_started_at`, for a scheduled check), or `null` when there is
 * none now: the connection can't be checked, or no adapter reads its orders (put off, and
 * recorded). A history read reads every order shown and leaves the schedule alone.
 */
export async function prepareSaleCheck(
  deps: Pick<SaleCheckDependencies, 'db' | 'adapters' | 'settings' | 'logger'>,
  payload: Pick<SaleCheckJobPayload, 'accountId' | 'connectionId'>,
  kind: SaleCheckRunKind = 'scheduled',
): Promise<PreparedSaleCheck | null> {
  const { db } = deps;
  const log = deps.logger.child({ task: 'sale_check', connectionId: payload.connectionId });
  const found = await db
    .selectFrom('sale_check_schedule as schedule')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'schedule.account_id')
        .onRef('connection.id', '=', 'schedule.connection_id'),
    )
    .select([
      'connection.id',
      'connection.mode',
      'connection.status',
      'connection.runs_on',
      'schedule.marketplace',
      'schedule.checked_through',
      'schedule.next_reason',
    ])
    .where('schedule.account_id', '=', payload.accountId)
    .where('schedule.connection_id', '=', payload.connectionId)
    .executeTakeFirst();
  if (found === undefined) return null;
  const connection: ConnectionRef = { id: found.id, mode: found.mode, status: found.status };
  if (
    found.mode !== 'automation' ||
    (found.status !== 'connected' && found.status !== 'degraded')
  ) {
    log.debug({ status: found.status }, 'the connection cannot be checked now');
    return null;
  }
  if (kind === 'scheduled' && !checksSales(found.marketplace)) {
    // A check queued before its marketplace's checks were hidden (verified-features.md).
    log.debug({ marketplace: found.marketplace }, 'sale checks are not shown on this marketplace');
    return null;
  }
  const key = { accountId: payload.accountId, connectionId: payload.connectionId };
  const adapter = deps.adapters(found.marketplace);
  if (adapter?.listOrdersSince === undefined || !readsOrders(adapter, connection)) {
    // Until the marketplace's automation adapter can read orders, check again only rarely.
    log.warn({ marketplace: found.marketplace }, 'no adapter reads orders on this marketplace');
    if (kind === 'scheduled') {
      await finish(db, key, {
        outcome: 'failed',
        delayMs: deps.settings.maxIntervalMs,
        reason: 'retry',
        checkedThrough: null,
      });
    }
    return null;
  }
  if (kind === 'scheduled') {
    await db
      .updateTable('sale_check_schedule')
      .set({ last_started_at: sql<Date>`now()` })
      .where('account_id', '=', key.accountId)
      .where('connection_id', '=', key.connectionId)
      .execute();
  }
  return {
    key,
    marketplace: found.marketplace,
    connection,
    adapter: adapter as PreparedSaleCheck['adapter'],
    kind,
    reason: found.next_reason,
    since:
      kind === 'history' || found.checked_through === null
        ? null
        : new Date(found.checked_through.getTime() - OVERLAP_MS),
    checkedThrough: found.checked_through,
    runsOn: found.runs_on,
  };
}

/**
 * Records that the check starts on `host` (its `sale_check_run`). An earlier check of the same
 * kind on the connection that never finished (its runner or phone stopped mid-check) is
 * finished first, as interrupted.
 */
export async function startSaleCheckRun(
  db: DbExecutor,
  prepared: PreparedSaleCheck,
  host: AutomationRunHost,
): Promise<StartedSaleCheck> {
  const { key } = prepared;
  await db
    .updateTable('sale_check_run')
    .set({
      finished_at: sql<Date>`now()`,
      outcome: 'failed',
      error_code: 'interrupted',
      error_message: saleCheckErrorMessage('interrupted', prepared.marketplace),
    })
    .where('account_id', '=', key.accountId)
    .where('connection_id', '=', key.connectionId)
    .where('kind', '=', prepared.kind)
    .where('finished_at', 'is', null)
    .execute();
  const run = await db
    .insertInto('sale_check_run')
    .values({
      account_id: key.accountId,
      connection_id: key.connectionId,
      marketplace: prepared.marketplace,
      kind: prepared.kind,
      reason: prepared.kind === 'scheduled' ? prepared.reason : null,
      host,
      since: prepared.since,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { ...prepared, runId: run.id };
}

/** The check as a background read, whose health the owner's alerts keep. */
function readTarget(prepared: StartedSaleCheck) {
  return {
    accountId: prepared.key.accountId,
    connectionId: prepared.key.connectionId,
    marketplace: prepared.marketplace,
    read: 'sale_check',
  } as const;
}

/** A check that could not read the orders: tried again soon, or after the relink it needs. */
export async function recordSaleCheckFailure(
  deps: Pick<SaleCheckDependencies, 'db' | 'settings' | 'logger'>,
  prepared: StartedSaleCheck,
  error: unknown,
): Promise<void> {
  const { db } = deps;
  const status = await connectionStatus(db, prepared.key);
  const challenged = status === 'reauth_required' || status === 'revoked';
  const failure = saleCheckError(error, prepared.marketplace);
  deps.logger.child({ task: 'sale_check', connectionId: prepared.key.connectionId }).warn(
    {
      event: 'sale_check_failed',
      runId: prepared.runId,
      kind: prepared.kind,
      marketplace: prepared.marketplace,
      code: failure.code,
      err: error instanceof Error ? { name: error.name, message: error.message } : error,
      challenged,
    },
    'sale check failed',
  );
  const outcome = challenged ? 'challenge' : 'failed';
  await finishRun(db, prepared, { outcome, error: failure });
  if (prepared.kind === 'history') return;
  await recordReadFailed(db, readTarget(prepared), readFailure(error));
  await finish(db, prepared.key, {
    outcome,
    // A relink checks at once; until then the dispatcher skips the connection.
    delayMs: challenged ? deps.settings.maxIntervalMs : deps.settings.minIntervalMs,
    reason: 'retry',
    checkedThrough: null,
    error: failure,
    alertAfterFailures: deps.settings.alertAfterFailures,
  });
}

/**
 * Hands the new orders to the sale intake and schedules the next check from the history; a
 * history read only records what it read.
 */
export async function recordSaleCheckOrders(
  deps: Pick<SaleCheckDependencies, 'db' | 'settings' | 'logger'>,
  prepared: StartedSaleCheck,
  orders: readonly RemoteOrder[],
): Promise<void> {
  const { db } = deps;
  const { key } = prepared;
  const log = deps.logger.child({ task: 'sale_check', connectionId: key.connectionId });
  if (prepared.kind === 'history') {
    await finishRun(db, prepared, { outcome: 'succeeded', orders, added: 0 });
    log.info(
      {
        event: 'sale_history_read',
        runId: prepared.runId,
        marketplace: prepared.marketplace,
        orders: orders.length,
      },
      'sale history read',
    );
    return;
  }
  const added = await recordOrders(db, prepared, orders);
  // The new orders count as sales already: the worker records them as sales right after.
  const history = await saleTimes(db, key.accountId, prepared.marketplace);
  const now = new Date();
  const next = nextSaleCheckDelay(
    now,
    [...history, ...added.map((order) => order.soldAt)],
    deps.settings,
  );
  const newest = orders.reduce<Date | null>(
    (latest, order) => (latest === null || order.soldAt > latest ? order.soldAt : latest),
    prepared.checkedThrough,
  );
  await finishRun(db, prepared, { outcome: 'succeeded', orders, added: added.length });
  await recordReadSucceeded(db, readTarget(prepared));
  await finish(db, key, {
    outcome: 'succeeded',
    delayMs: next.delayMs,
    reason: 'scheduled',
    checkedThrough: newest ?? now,
  });
  log.info(
    {
      event: 'sale_check_finished',
      runId: prepared.runId,
      marketplace: prepared.marketplace,
      orders: orders.length,
      added: added.length,
      nextInMs: next.delayMs,
      basis: next.basis,
    },
    'sale check finished',
  );
}

/** Whether the adapter serving the connection checks for sales by reading orders (`poll`). */
export function readsOrders(
  adapter: MarketplaceAdapter | undefined,
  connection: ConnectionRef,
): boolean {
  return (
    adapter?.listOrdersSince !== undefined &&
    adapter.capabilities(connection).saleDetection.includes('poll')
  );
}

/** One order a check read, as its record keeps it: no buyer, no address. */
export interface SaleCheckOrderRecord {
  orderId: string;
  soldAt: string;
  items: { listingId: string | null; title: string | null; priceCents: number }[];
}

/** What a check read, newest first, at most `RECORDED_ORDERS`. */
export function saleCheckOrderRecords(orders: readonly RemoteOrder[]): SaleCheckOrderRecord[] {
  return [...orders]
    .sort((a, b) => b.soldAt.getTime() - a.soldAt.getTime())
    .slice(0, RECORDED_ORDERS)
    .map((order) => ({
      orderId: order.externalOrderId.slice(0, 255),
      soldAt: order.soldAt.toISOString(),
      items: order.items.slice(0, 20).map((item) => ({
        listingId: item.externalListingId,
        title: item.title === null ? null : item.title.slice(0, 200),
        priceCents: item.priceCents,
      })),
    }));
}

/**
 * Hands each order not seen before to the sale intake: in one transaction per order, its
 * `inbound_event` (source `poll`, once per order, naming this check) and the worker's job that
 * records its sale (orders.ts). Returns the orders that were new.
 */
async function recordOrders(
  db: DbExecutor,
  prepared: StartedSaleCheck,
  orders: readonly RemoteOrder[],
): Promise<RemoteOrder[]> {
  const { key, marketplace } = prepared;
  const added: RemoteOrder[] = [];
  for (const order of orders) {
    await inTransaction(db, async (trx) => {
      const handOver = (providerEventId: string) =>
        recordInboundEvent(trx, {
          accountId: key.accountId,
          source: 'poll',
          marketplace,
          providerEventId: providerEventId.slice(0, 255),
          signatureOk: null,
          payload: orderEventPayload(key.connectionId, order, prepared.runId),
          // An automation connection knows its seller by the session only, not by a user id.
          externalUserId: null,
        });
      let event = await handOver(`order:${order.externalOrderId}`);
      // A check handed this order over before. A sales history read hands it over once more
      // when it was dropped then (`ignored`: before Listora recorded the sales of listings it
      // doesn't have); recording it again is a no-op for a sale already recorded. A recorded
      // sale whose sold item has no photos gets the sold listing's (sold-photos.ts).
      if (
        event.duplicate &&
        prepared.since === null &&
        (await wasIgnored(trx, key.accountId, event.id))
      ) {
        event = await handOver(`history:order:${order.externalOrderId}`);
      }
      if (event.duplicate) {
        await queueSoldItemPhotos(trx, { ...key, marketplace, runId: prepared.runId }, order);
        return;
      }
      await queueSaleOrder(trx, { accountId: key.accountId, inboundEventId: event.id });
      added.push(order);
    });
  }
  return added;
}

/** Whether an order's earlier event recorded no sale: nothing of it was a Listora listing then. */
async function wasIgnored(db: DbExecutor, accountId: string, eventId: string): Promise<boolean> {
  const event = await db
    .selectFrom('inbound_event')
    .select('result')
    .where('account_id', '=', accountId)
    .where('id', '=', eventId)
    .executeTakeFirst();
  return event?.result === 'ignored';
}

/** Finishes the check's record with what it read, or why it failed. */
async function finishRun(
  db: DbExecutor,
  prepared: StartedSaleCheck,
  result:
    | { outcome: 'succeeded'; orders: readonly RemoteOrder[]; added: number }
    | { outcome: 'failed' | 'challenge'; error: { code: string; message: string } },
): Promise<void> {
  const { key } = prepared;
  // The browser session that read the orders: the connection's newest sale-check run since
  // this check started (the runner's, or the phone's call).
  const session = await db
    .selectFrom('automation_run')
    .select('id')
    .where('account_id', '=', key.accountId)
    .where('connection_id', '=', key.connectionId)
    .where('purpose', '=', 'sale_check')
    .where(
      'started_at',
      '>=',
      db
        .selectFrom('sale_check_run')
        .select('started_at')
        .where('account_id', '=', key.accountId)
        .where('id', '=', prepared.runId),
    )
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const read =
    result.outcome === 'succeeded'
      ? (() => {
          const times = result.orders.map((order) => order.soldAt.getTime());
          return {
            orders_seen: result.orders.length,
            items_seen: result.orders.reduce((total, order) => total + order.items.length, 0),
            new_orders: result.added,
            newest_sold_at: times.length === 0 ? null : new Date(Math.max(...times)),
            oldest_sold_at: times.length === 0 ? null : new Date(Math.min(...times)),
            orders: jsonb(saleCheckOrderRecords(result.orders) as unknown as JsonArray),
          };
        })()
      : {
          error_code: result.error.code,
          error_message: result.error.message.slice(0, 500),
        };
  await db
    .updateTable('sale_check_run')
    .set({
      finished_at: sql<Date>`now()`,
      outcome: result.outcome,
      automation_run_id: session?.id ?? null,
      ...read,
    })
    .where('account_id', '=', key.accountId)
    .where('id', '=', prepared.runId)
    .where('finished_at', 'is', null)
    .execute();
}

/** When the seller's recorded sales on the marketplace happened, within the history window. */
async function saleTimes(
  db: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
): Promise<Date[]> {
  const rows = await db
    .selectFrom('sale')
    .select('sold_at')
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace)
    .where('sold_at', '>', sql<Date>`now() - make_interval(days => ${SALE_HISTORY_DAYS})`)
    .execute();
  return rows.map((row) => row.sold_at);
}

async function connectionStatus(
  db: DbExecutor,
  key: { accountId: string; connectionId: string },
): Promise<string | undefined> {
  const row = await db
    .selectFrom('marketplace_connection')
    .select('status')
    .where('account_id', '=', key.accountId)
    .where('id', '=', key.connectionId)
    .executeTakeFirst();
  return row?.status;
}

/**
 * Records a scheduled check's outcome on the schedule: the next check, and the health. A check
 * that worked makes it healthy and ends any problem; a failure counts, and enough in a row make
 * the sale checks `failing` (health.ts announces it).
 */
async function finish(
  executor: DbExecutor,
  key: { accountId: string; connectionId: string },
  result:
    | {
        outcome: 'succeeded';
        delayMs: number;
        reason: 'scheduled' | 'retry';
        checkedThrough: Date | null;
      }
    | {
        outcome: 'failed' | 'challenge';
        delayMs: number;
        reason: 'scheduled' | 'retry';
        checkedThrough: null;
        /** Absent when no check could run (no adapter reads the orders). */
        error?: { code: string; message: string };
        alertAfterFailures?: number;
      },
): Promise<void> {
  // A forwarded email, an accepted offer, or the seller's sync that asked for a check while this
  // one ran keeps its sooner time.
  const askedMeanwhile = sql<boolean>`(next_reason in ('email', 'offer', 'sync') and next_check_at > last_started_at)`;
  const health =
    result.outcome === 'succeeded'
      ? {
          last_succeeded_at: sql<Date>`now()`,
          failures_in_a_row: 0,
          last_error_code: null,
          last_error_message: null,
          health: 'healthy' as const,
          unhealthy_since: null,
          alerted_at: null,
        }
      : result.error === undefined
        ? {}
        : (() => {
            const failing = sql<boolean>`failures_in_a_row + 1 >= ${result.alertAfterFailures ?? 1}`;
            return {
              failures_in_a_row: sql<number>`failures_in_a_row + 1`,
              last_error_code: result.error.code,
              last_error_message: result.error.message.slice(0, 500),
              health: sql<'failing'>`case when ${failing} then 'failing' else health end`,
              unhealthy_since: sql<Date | null>`case when ${failing} and health = 'healthy'
                then now() else unhealthy_since end`,
            };
          })();
  await executor
    .updateTable('sale_check_schedule')
    .set({
      last_finished_at: sql<Date>`now()`,
      last_outcome: result.outcome,
      next_check_at: sql<Date>`case when ${askedMeanwhile} then next_check_at
        else now() + make_interval(secs => ${result.delayMs / 1000}) end`,
      next_reason: sql<SaleCheckReason>`case when ${askedMeanwhile} then next_reason
        else ${result.reason} end`,
      ...(result.checkedThrough === null ? {} : { checked_through: result.checkedThrough }),
      ...health,
    })
    .where('account_id', '=', key.accountId)
    .where('connection_id', '=', key.connectionId)
    .execute();
}
