/**
 * The sale check (decision D1), run by the browser runner: it reads the seller's sold orders
 * on the marketplace through their browser session, hands each new one to the sale intake as an
 * `inbound_event` (`recordInboundEvent` in @listora/sales, source `poll`, deduplicated by
 * order), and schedules the next check from the seller's sales history (interval.ts). The sale
 * intake processes the events: it records the sale and delists the item everywhere else.
 *
 * Every outcome is recorded on the schedule. A check that met a check automation must not pass
 * has left the connection waiting for a relink (the dispatcher skips it until then, and the
 * relink checks at once); one that failed otherwise tries again after the minimum interval.
 * Only a database failure throws, and the job queue then runs it again.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  type Db,
  type DbExecutor,
  type Marketplace,
  type SaleCheckReason,
} from '@listora/db';
import type {
  AdapterLookup,
  ConnectionRef,
  MarketplaceAdapter,
  RemoteOrder,
} from '@listora/marketplaces';
import { finishInboundEvent, recordInboundEvent, recordSale } from '@listora/sales';
import type { Logger } from '@listora/shared';

import type { SaleCheckSettings } from '../settings.ts';
import { nextSaleCheckDelay, SALE_HISTORY_DAYS } from './interval.ts';
import type { SaleCheckJobPayload } from './schedule.ts';

export interface SaleCheckDependencies {
  db: Db;
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
      'schedule.marketplace',
      'schedule.checked_through',
    ])
    .where('schedule.account_id', '=', payload.accountId)
    .where('schedule.connection_id', '=', payload.connectionId)
    .executeTakeFirst();
  if (found === undefined) return;
  const connection: ConnectionRef = { id: found.id, mode: found.mode, status: found.status };
  if (
    found.mode !== 'automation' ||
    (found.status !== 'connected' && found.status !== 'degraded')
  ) {
    log.debug({ status: found.status }, 'the connection cannot be checked now');
    return;
  }
  const key = { accountId: payload.accountId, connectionId: payload.connectionId };
  const adapter = deps.adapters(found.marketplace);
  if (!readsOrders(adapter, connection)) {
    // Until the marketplace's automation adapter can read orders, check again only rarely.
    log.warn({ marketplace: found.marketplace }, 'no adapter reads orders on this marketplace');
    await finish(db, key, {
      outcome: 'failed',
      delayMs: deps.settings.maxIntervalMs,
      reason: 'retry',
      checkedThrough: null,
    });
    return;
  }
  await db
    .updateTable('sale_check_schedule')
    .set({ last_started_at: sql<Date>`now()` })
    .where('account_id', '=', key.accountId)
    .where('connection_id', '=', key.connectionId)
    .execute();

  const since =
    found.checked_through === null ? null : new Date(found.checked_through.getTime() - OVERLAP_MS);
  let orders: RemoteOrder[];
  try {
    if (adapter?.listOrdersSince === undefined) throw new Error('the adapter reads no orders');
    orders = await adapter.listOrdersSince(since, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? 300_000)]),
      connection,
    });
  } catch (error) {
    const status = await connectionStatus(db, key);
    const challenged = status === 'reauth_required' || status === 'revoked';
    log.warn(
      {
        err: error instanceof Error ? { name: error.name, message: error.message } : error,
        challenged,
      },
      'sale check failed',
    );
    await finish(db, key, {
      outcome: challenged ? 'challenge' : 'failed',
      // A relink checks at once; until then the dispatcher skips the connection.
      delayMs: challenged ? deps.settings.maxIntervalMs : deps.settings.minIntervalMs,
      reason: 'retry',
      checkedThrough: null,
    });
    return;
  }

  const recorded = await recordOrders(db, key, found.marketplace, orders);
  // The sales just recorded are part of the history the next check adapts to.
  const history = await saleTimes(db, payload.accountId, found.marketplace);
  const now = new Date();
  const next = nextSaleCheckDelay(now, history, deps.settings);
  const newest = orders.reduce<Date | null>(
    (latest, order) => (latest === null || order.soldAt > latest ? order.soldAt : latest),
    found.checked_through,
  );
  await finish(db, key, {
    outcome: 'succeeded',
    delayMs: next.delayMs,
    reason: 'scheduled',
    checkedThrough: newest ?? now,
  });
  log.info(
    {
      orders: orders.length,
      added: recorded.added,
      sales: recorded.sales,
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
 * Hands each order not seen before to the sale intake, as the eBay order poll does
 * (@listora/sales): in one transaction per order, its `inbound_event` (source `poll`, once per
 * order) and, when one of its lines is a Listora listing, its sale, whose `sale_recorded` job
 * the auto-delist orchestrator consumes. The event is finished `processed` when a sale was
 * recorded and `ignored` otherwise (no line Listora knows, or the sale was recorded before).
 */
async function recordOrders(
  db: Db,
  key: { accountId: string; connectionId: string },
  marketplace: Marketplace,
  orders: readonly RemoteOrder[],
): Promise<{ added: number; sales: number }> {
  let added = 0;
  let sales = 0;
  for (const order of orders) {
    await inTransaction(db, async (trx) => {
      const event = await recordInboundEvent(trx, {
        accountId: key.accountId,
        source: 'poll',
        marketplace,
        providerEventId: `order:${order.externalOrderId}`.slice(0, 255),
        signatureOk: null,
        payload: {
          connectionId: key.connectionId,
          externalOrderId: order.externalOrderId,
          soldAt: order.soldAt.toISOString(),
          items: order.items.map((item) => ({
            externalListingId: item.externalListingId,
            title: item.title,
            priceCents: item.priceCents,
            currency: item.currency,
          })),
        },
        // An automation connection knows its seller by the session only, not by a user id.
        externalUserId: null,
      });
      // A check handled this order before, in a transaction that also recorded its outcome.
      if (event.duplicate) return;
      added += 1;
      const sale = await recordSale(trx, {
        accountId: key.accountId,
        marketplace,
        externalOrderId: order.externalOrderId,
        soldAt: order.soldAt,
        currency: order.items[0]?.currency ?? 'USD',
        // The order pages a sale check reads show no shipping charge.
        shippingChargedCents: 0,
        detectionSource: 'poll',
        inboundEventId: event.id,
        shipBy: null,
        lines: order.items.map((item) => ({
          externalListingId: item.externalListingId,
          externalSku: null,
          quantity: 1,
          priceCents: item.priceCents,
        })),
      });
      if (sale.type === 'recorded') sales += 1;
      await finishInboundEvent(
        trx,
        key.accountId,
        event.id,
        sale.type === 'recorded' ? 'processed' : 'ignored',
      );
    });
  }
  return { added, sales };
}

/** When the seller's recorded sales on the marketplace happened, within the history window. */
async function saleTimes(db: Db, accountId: string, marketplace: Marketplace): Promise<Date[]> {
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
  db: Db,
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
