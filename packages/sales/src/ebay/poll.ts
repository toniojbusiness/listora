/**
 * The order poll, the backstop for `ORDER_CONFIRMATION` (eBay delivers notifications on a
 * best-effort basis, and a notification can be lost while the API is down): every 5 minutes,
 * for each connected eBay seller, Fulfillment `getOrders` reads every order changed since the
 * last successful poll and records the paid ones as sales (orders.ts). An order the webhook
 * recorded first is a duplicate and changes nothing; each order also gets one `poll` inbound
 * event, so seeing it again on the next poll is recognized at once.
 *
 * - `ebay_order_poll` (Graphile cron, every 5 minutes, once across all workers) adds one
 *   `ebay_connection_order_poll` job per connection; the job key keeps at most one pending job
 *   per connection, so a slow seller never piles up polls.
 * - A poll reads from 10 minutes before its last successful start (`orders_polled_through`),
 *   because eBay's order views lag a little; the first poll starts at the connection's grant.
 *   The mark moves only when every page was read, so a failed poll is repeated in full.
 * - Each poll costs one Fulfillment call per page (eBay's default limit is 100,000 a day per
 *   application, so about 340 sellers at one page every 5 minutes; T-35 asks for more).
 */
import { addJob, inTransaction, type Db } from '@listora/db';
import { getOrders, type EbayOrder, type OrdersPage } from '@listora/marketplaces';

import { isPaidOrder, recordEbayOrder } from './orders.ts';
import { EbaySyncRetryError, type EbaySyncDependencies } from './process.ts';

export const EBAY_ORDER_POLL_TASK = 'ebay_order_poll';
/** Every 5 minutes (UTC crontab fields; the worker's scheduled task). */
export const EBAY_ORDER_POLL_SCHEDULE = '*/5 * * * *';
export const EBAY_CONNECTION_POLL_TASK = 'ebay_connection_order_poll';

const OVERLAP_MS = 10 * 60_000;
const PAGE_SIZE = 200;
/** 10,000 orders in one poll; a seller with more is caught up over several polls. */
const MAX_PAGES = 50;

export interface EbayConnectionPollPayload {
  connectionId: string;
}

export function isEbayConnectionPollPayload(value: unknown): value is EbayConnectionPollPayload {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['connectionId'] === 'string';
}

/** Adds one poll job per eBay connection that still holds its grant; returns how many. */
export async function scheduleEbayOrderPolls(db: Db): Promise<number> {
  const connections = await db
    .selectFrom('marketplace_connection')
    .select('id')
    .where('marketplace', '=', 'ebay')
    .where('mode', '=', 'api')
    .where('status', 'in', ['connected', 'degraded'])
    .where('token_ciphertext', 'is not', null)
    .orderBy('id')
    .execute();
  for (const connection of connections) {
    const payload: EbayConnectionPollPayload = { connectionId: connection.id };
    await addJob(db, {
      task: EBAY_CONNECTION_POLL_TASK,
      payload: { ...payload },
      jobKey: `ebay-order-poll:${connection.id}`,
    });
  }
  return connections.length;
}

export interface ConnectionPollSummary {
  status: 'polled' | 'skipped' | 'reauth_required';
  orders: number;
  recorded: number;
}

export async function pollEbayConnectionOrders(
  deps: EbaySyncDependencies & { now?: () => Date },
  payload: EbayConnectionPollPayload,
  signal: AbortSignal,
): Promise<ConnectionPollSummary> {
  const now = deps.now ?? (() => new Date());
  const connection = await deps.db
    .selectFrom('marketplace_connection')
    .select(['id', 'account_id', 'external_user_id', 'orders_polled_through', 'created_at'])
    .where('id', '=', payload.connectionId)
    .where('marketplace', '=', 'ebay')
    .where('mode', '=', 'api')
    .where('status', 'in', ['connected', 'degraded'])
    .executeTakeFirst();
  if (connection === undefined || connection.external_user_id === null) {
    return { status: 'skipped', orders: 0, recorded: 0 };
  }
  const sellerUserId = connection.external_user_id;

  const startedAt = now();
  const since = new Date(
    (connection.orders_polled_through ?? connection.created_at).getTime() - OVERLAP_MS,
  );
  const summary: ConnectionPollSummary = { status: 'polled', orders: 0, recorded: 0 };
  let pageUrl: string | null = null;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await readPage(deps, connection.id, since, pageUrl, signal);
    if (result === 'reauth_required') return { ...summary, status: 'reauth_required' };
    for (const order of result.orders) {
      summary.orders += 1;
      if (!isPaidOrder(order)) continue;
      if (await recordPolledOrder(deps.db, connection.account_id, sellerUserId, order)) {
        summary.recorded += 1;
      }
    }
    pageUrl = result.next;
    // The seller's token goes only to eBay's own API host.
    if (pageUrl !== null && !pageUrl.startsWith(`${deps.endpoints.api}/`)) {
      throw new EbaySyncRetryError("eBay's next page is not on eBay's API host");
    }
    if (pageUrl === null) {
      complete = true;
      break;
    }
  }
  if (complete) {
    await deps.db
      .updateTable('marketplace_connection')
      .set({ orders_polled_through: startedAt })
      .where('id', '=', connection.id)
      .where((eb) =>
        eb.or([
          eb('orders_polled_through', 'is', null),
          eb('orders_polled_through', '<', startedAt),
        ]),
      )
      .execute();
  } else {
    deps.logger.warn(
      { connectionId: connection.id, orders: summary.orders },
      'eBay order poll read its page limit; the next poll continues from the same point',
    );
  }
  if (summary.recorded > 0) {
    deps.logger.info(
      { connectionId: connection.id, recorded: summary.recorded },
      'eBay order poll recorded sales the webhook had not',
    );
  }
  return summary;
}

async function recordPolledOrder(
  db: Db,
  accountId: string,
  sellerUserId: string,
  order: EbayOrder,
): Promise<boolean> {
  return inTransaction(db, async (trx) => {
    const result = await recordEbayOrder(trx, {
      accountId,
      sellerUserId,
      order,
      detection: { source: 'poll' },
    });
    return result.type === 'recorded';
  });
}

async function readPage(
  deps: EbaySyncDependencies,
  connectionId: string,
  since: Date,
  pageUrl: string | null,
  signal: AbortSignal,
): Promise<OrdersPage | 'reauth_required'> {
  for (let attempt = 1; ; attempt += 1) {
    const token = await deps.tokens.accessToken(connectionId, signal);
    // The tokens recorded the problem on the connection; the next poll skips it.
    if (token.type === 'reauth_required') return 'reauth_required';
    if (token.type === 'unavailable') {
      throw new EbaySyncRetryError(`the seller's eBay token is unavailable (${token.code})`);
    }
    const result = await getOrders(
      deps.endpoints,
      pageUrl === null ? { modifiedSince: since, limit: PAGE_SIZE } : { pageUrl },
      { token: token.accessToken, signal, timeoutMs: deps.timeoutMs ?? 15_000 },
    );
    if (result.type === 'ok') return result.value;
    if (result.type === 'error' && result.status === 401 && attempt === 1) {
      await deps.tokens.invalidate(connectionId, token.accessToken);
      continue;
    }
    throw new EbaySyncRetryError(
      `eBay's orders could not be read (${result.type === 'error' ? `http_${String(result.status)}` : result.code})`,
    );
  }
}
