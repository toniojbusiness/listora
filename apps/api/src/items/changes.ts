/**
 * The item screen's wait for a change (`waitForItemChange`, docs/features/operations.md,
 * "Following a change"): while a change to the item's listings runs or waits, the app waits
 * here instead of reading the item every second. Every new or updated operation notifies
 * `item_change` with its item's id (migration `20261028224729_item_change_notify`), and the
 * wait answers the moment that transaction commits.
 */
import { KeyedSignals, listenForSignals, type DbExecutor } from '@listora/db';
import type { Logger } from '@listora/shared';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';
import { findItem } from './repository.ts';

/** The channel `marketplace_operation` notifies, with the operation's item id. */
export const ITEM_CHANGE_CHANNEL = 'item_change';

/** The longest one wait holds (under the API gateway's 30-second limit). */
export const ITEM_CHANGE_WAIT_MAX_SECONDS = 20;

/**
 * How often a wait looks while signals do not reach this process (their connection is down):
 * the item screen's change then shows within this, as with the app's own polling before.
 */
export const ITEM_CHANGE_LOOK_SECONDS = 3;

export interface ItemChangeDependencies extends RouteDependencies {
  /** Signals keyed by item id; without them a wait looks every `ITEM_CHANGE_LOOK_SECONDS`. */
  itemChanges: KeyedSignals | undefined;
}

export function registerItemChangeRoutes(app: FastifyInstance, deps: ItemChangeDependencies): void {
  contractRoute(app, deps, 'waitForItemChange', async ({ tenant, db, params, query, request }) => {
    if ((await findItem(db, tenant, params.itemId)) === undefined) throw notFound('Item');
    // The wait ends when the app gives up on it (its connection closes).
    const gone = new AbortController();
    const abort = (): void => {
      gone.abort();
    };
    const socket = request.raw.socket;
    socket.once('close', abort);
    try {
      const body = await waitForItemChange(deps.itemChanges, db, tenant, params.itemId, {
        after: query.after,
        maxMs: Math.min(query.waitSeconds, ITEM_CHANGE_WAIT_MAX_SECONDS) * 1000,
        signal: gone.signal,
      });
      return { status: 200, body };
    } finally {
      socket.off('close', abort);
    }
  });
}

/**
 * Waits until the item's operations differ from those `after` stands for, `maxMs` passed, or
 * `signal` aborts. Without `after` it answers at once, `changed`. Reads only.
 */
export async function waitForItemChange(
  signals: KeyedSignals | undefined,
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  options: { after: string | undefined; maxMs: number; signal?: AbortSignal },
): Promise<{ changed: boolean; token: string }> {
  if (options.after === undefined) {
    return { changed: true, token: await itemOperationsToken(db, tenant, itemId) };
  }
  const source = signals ?? NO_SIGNALS;
  const deadline = Date.now() + options.maxMs;
  for (;;) {
    // Subscribed before the read, so a change committed in between still wakes the wait.
    const subscription = source.subscribe(itemId);
    try {
      const token = await itemOperationsToken(db, tenant, itemId);
      if (token !== options.after) return { changed: true, token };
      const left = deadline - Date.now();
      const wait = Math.min(left, source.listening ? Infinity : ITEM_CHANGE_LOOK_SECONDS * 1000);
      if (wait <= 0) return { changed: false, token };
      const woke = await subscription.wait(wait, options.signal);
      if (woke === 'aborted' || (woke === 'timeout' && wait >= left)) {
        return { changed: false, token };
      }
    } finally {
      subscription.cancel();
    }
  }
}

/** Never signaled: a wait on it only looks on its schedule. */
const NO_SIGNALS = new KeyedSignals(() => false);

/**
 * A digest of every operation on the item's listings (their status, attempts, next attempt,
 * and last update), so any change to any of them gives another token.
 */
export async function itemOperationsToken(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<string> {
  const row = await db
    .selectFrom('marketplace_operation as operation')
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'operation.account_id')
        .onRef('listing.id', '=', 'operation.listing_id'),
    )
    .select(
      sql<string>`md5(coalesce(string_agg(concat_ws('|', operation.id, operation.status,
        operation.attempts, operation.next_attempt_at, operation.updated_at), ','
        order by operation.id), ''))`.as('token'),
    )
    .where('listing.account_id', '=', tenant.accountId)
    .where('listing.item_id', '=', itemId)
    .executeTakeFirstOrThrow();
  return row.token;
}

/**
 * Signals from Postgres: one listener on `item_change` (its own connection), for the
 * process's lifetime. `close` stops it.
 */
export function listenForItemChanges(options: { connectionString: string; logger: Logger }): {
  signals: KeyedSignals;
  close: () => Promise<void>;
} {
  return listenForSignals({
    connectionString: options.connectionString,
    channel: ITEM_CHANGE_CHANNEL,
    onListening: (listening) => {
      options.logger.info({ listening }, 'item change signals');
    },
    onError: (error) => {
      options.logger.warn({ err: error }, 'item change signals lost their connection');
    },
  });
}
