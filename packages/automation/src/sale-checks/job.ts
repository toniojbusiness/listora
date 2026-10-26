/**
 * The sale check (decision D1), run by the browser runner: it reads the seller's sold orders
 * on the marketplace through their browser session, hands each new one to the sale intake (an
 * `inbound_event`, source `poll`, once per order, and the worker's job that records its sale and
 * starts its auto-delist, orders.ts), and schedules the next check from the seller's sales
 * history (interval.ts).
 *
 * Every outcome is recorded on the schedule. A check that met a check automation must not pass
 * has left the connection waiting for a relink (the dispatcher skips it until then, and the
 * relink checks at once); one that failed otherwise tries again after the minimum interval.
 * Only a database failure throws, and the job queue then runs it again.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  type DbExecutor,
  type ExecutionLocation,
  type Marketplace,
  type SaleCheckReason,
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
import { nextSaleCheckDelay, SALE_HISTORY_DAYS } from './interval.ts';
import { orderEventPayload, queueSaleOrder } from './orders.ts';
import { queueSaleCheckForPhone, type SaleCheckJobPayload } from './schedule.ts';

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

export async function runSaleCheck(
  deps: SaleCheckDependencies,
  payload: SaleCheckJobPayload,
  signal: AbortSignal,
): Promise<void> {
  const prepared = await prepareSaleCheck(deps, payload);
  if (prepared === null) return;
  if (prepared.runsOn === 'phone') {
    // The connection's automated steps moved to the phone: its sales are checked there now.
    await queueSaleCheckForPhone(deps.db, {
      ...prepared.key,
      marketplace: prepared.marketplace,
    });
    return;
  }
  let orders: RemoteOrder[];
  try {
    orders = await prepared.adapter.listOrdersSince(prepared.since, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? 300_000)]),
      connection: prepared.connection,
    });
  } catch (error) {
    await recordSaleCheckFailure(deps, prepared, error);
    return;
  }
  await recordSaleCheckOrders(deps, prepared, orders);
}

/** A sale check ready to read the seller's orders. */
export interface PreparedSaleCheck {
  key: { accountId: string; connectionId: string };
  marketplace: Marketplace;
  connection: ConnectionRef;
  adapter: MarketplaceAdapter & Required<Pick<MarketplaceAdapter, 'listOrdersSince'>>;
  /** Orders sold at or after this time (a little before the last check), or every one shown. */
  since: Date | null;
  checkedThrough: Date | null;
  runsOn: ExecutionLocation;
}

/**
 * The check to run, started (`last_started_at`), or `null` when there is none now: the
 * connection can't be checked, or no adapter reads its orders (put off, and recorded).
 */
export async function prepareSaleCheck(
  deps: Pick<SaleCheckDependencies, 'db' | 'adapters' | 'settings' | 'logger'>,
  payload: SaleCheckJobPayload,
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
  const key = { accountId: payload.accountId, connectionId: payload.connectionId };
  const adapter = deps.adapters(found.marketplace);
  if (adapter?.listOrdersSince === undefined || !readsOrders(adapter, connection)) {
    // Until the marketplace's automation adapter can read orders, check again only rarely.
    log.warn({ marketplace: found.marketplace }, 'no adapter reads orders on this marketplace');
    await finish(db, key, {
      outcome: 'failed',
      delayMs: deps.settings.maxIntervalMs,
      reason: 'retry',
      checkedThrough: null,
    });
    return null;
  }
  await db
    .updateTable('sale_check_schedule')
    .set({ last_started_at: sql<Date>`now()` })
    .where('account_id', '=', key.accountId)
    .where('connection_id', '=', key.connectionId)
    .execute();
  return {
    key,
    marketplace: found.marketplace,
    connection,
    adapter: adapter as PreparedSaleCheck['adapter'],
    since:
      found.checked_through === null
        ? null
        : new Date(found.checked_through.getTime() - OVERLAP_MS),
    checkedThrough: found.checked_through,
    runsOn: found.runs_on,
  };
}

/** A check that could not read the orders: tried again soon, or after the relink it needs. */
export async function recordSaleCheckFailure(
  deps: Pick<SaleCheckDependencies, 'db' | 'settings' | 'logger'>,
  prepared: PreparedSaleCheck,
  error: unknown,
): Promise<void> {
  const { db } = deps;
  const status = await connectionStatus(db, prepared.key);
  const challenged = status === 'reauth_required' || status === 'revoked';
  deps.logger.child({ task: 'sale_check', connectionId: prepared.key.connectionId }).warn(
    {
      err: error instanceof Error ? { name: error.name, message: error.message } : error,
      challenged,
    },
    'sale check failed',
  );
  await finish(db, prepared.key, {
    outcome: challenged ? 'challenge' : 'failed',
    // A relink checks at once; until then the dispatcher skips the connection.
    delayMs: challenged ? deps.settings.maxIntervalMs : deps.settings.minIntervalMs,
    reason: 'retry',
    checkedThrough: null,
  });
}

/** Hands the new orders to the sale intake and schedules the next check from the history. */
export async function recordSaleCheckOrders(
  deps: Pick<SaleCheckDependencies, 'db' | 'settings' | 'logger'>,
  prepared: PreparedSaleCheck,
  orders: readonly RemoteOrder[],
): Promise<void> {
  const { db } = deps;
  const { key } = prepared;
  const added = await recordOrders(db, key, prepared.marketplace, orders);
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
  await finish(db, key, {
    outcome: 'succeeded',
    delayMs: next.delayMs,
    reason: 'scheduled',
    checkedThrough: newest ?? now,
  });
  deps.logger.child({ task: 'sale_check', connectionId: key.connectionId }).info(
    {
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

/**
 * Hands each order not seen before to the sale intake: in one transaction per order, its
 * `inbound_event` (source `poll`, once per order) and the worker's job that records its sale
 * (orders.ts). Returns the orders that were new.
 */
async function recordOrders(
  db: DbExecutor,
  key: { accountId: string; connectionId: string },
  marketplace: Marketplace,
  orders: readonly RemoteOrder[],
): Promise<RemoteOrder[]> {
  const added: RemoteOrder[] = [];
  for (const order of orders) {
    await inTransaction(db, async (trx) => {
      const event = await recordInboundEvent(trx, {
        accountId: key.accountId,
        source: 'poll',
        marketplace,
        providerEventId: `order:${order.externalOrderId}`.slice(0, 255),
        signatureOk: null,
        payload: orderEventPayload(key.connectionId, order),
        // An automation connection knows its seller by the session only, not by a user id.
        externalUserId: null,
      });
      // A check handed this order over before.
      if (event.duplicate) return;
      await queueSaleOrder(trx, { accountId: key.accountId, inboundEventId: event.id });
      added.push(order);
    });
  }
  return added;
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

async function finish(
  executor: DbExecutor,
  key: { accountId: string; connectionId: string },
  result: {
    outcome: 'succeeded' | 'failed' | 'challenge';
    delayMs: number;
    reason: 'scheduled' | 'retry';
    checkedThrough: Date | null;
  },
): Promise<void> {
  // A forwarded email that asked for a check while this one ran keeps its sooner time.
  const askedMeanwhile = sql<boolean>`(next_reason = 'email' and next_check_at > last_started_at)`;
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
    })
    .where('account_id', '=', key.accountId)
    .where('connection_id', '=', key.connectionId)
    .execute();
}
