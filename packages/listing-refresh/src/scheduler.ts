/**
 * The refresh schedule (`listing_refresh`, every 5 minutes; docs/features/listing-refresh.md):
 * for each marketplace session Listora can refresh through, it queues a refresh for the listings
 * that are due, oldest due first, as ordinary operations (`auto_refresh`), so each one is sent
 * by the engine, confirmed only by a read-back, and visible and retryable when it fails.
 *
 * It stays well inside the shared pace: refreshes may use at most `shareOfLimits` of the
 * connection's automation run limits per hour and per day (each refresh takes about
 * `runsPerRefresh` runs: the share or save, and its read-back), so the seller's own changes,
 * delists, and sale checks always have room, at most `maxUnfinished` refreshes wait on one
 * connection at a time (a phone that is away does not collect a pile), and at most `maxPerTick`
 * are queued per connection per run. No refresh is queued in the seller's quiet window. One run
 * per connection at a time (a transaction-scoped advisory lock), and one refresh per listing
 * per fresh period (its idempotency key), so two workers never queue two.
 */
import { inTransaction, type Db, type DbTransaction, type Marketplace } from '@listora/db';
import { operationMode, SELLER_FEATURES, type AdapterLookup } from '@listora/marketplaces';
import { enqueueOperation } from '@listora/operations';
import type { Logger } from '@listora/shared';
import { sql } from 'kysely';

import { dueAt, effectiveCadence, inQuietWindow, intervalHours } from './cadence.ts';
import { loadRefreshFacts, REFRESH_MARKETPLACES, refreshMarketplaces } from './schedule.ts';
import { loadRefreshSettings, quietWindowOf } from './settings.ts';

export const LISTING_REFRESH_TASK = 'listing_refresh';
export const LISTING_REFRESH_SCHEDULE = '*/5 * * * *';

export const REFRESH_PACE = {
  /** Of each automation run limit (per hour, per day), what refreshes may use. */
  shareOfLimits: 0.5,
  /** Runs one refresh takes: the share or save, and its read-back. */
  runsPerRefresh: 2,
  /** Refreshes not finished yet on one connection, at most. */
  maxUnfinished: 2,
  /** Refreshes queued per connection per run, at most. */
  maxPerTick: 2,
} as const;

/** A connection's automation run limits (the browser runner's, `AUTOMATION_<MARKETPLACE>_*`). */
export interface RunLimits {
  runsPerHour: number;
  runsPerDay: number;
}

export interface ListingRefreshDependencies {
  db: Db;
  adapters: AdapterLookup;
  /** The run limits of a marketplace's sessions; none: Listora doesn't refresh there. */
  limits: (marketplace: Marketplace) => RunLimits | undefined;
  logger: Pick<Logger, 'info'>;
  now?: () => Date;
}

export interface ListingRefreshResult {
  /** Refresh operations queued. */
  queued: number;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export async function runListingRefreshes(
  deps: ListingRefreshDependencies,
): Promise<ListingRefreshResult> {
  const now = deps.now?.() ?? new Date();
  const marketplaces = refreshMarketplaces(SELLER_FEATURES);
  const connections = await deps.db
    .selectFrom('marketplace_connection')
    .select(['id', 'account_id', 'marketplace', 'mode', 'status'])
    .where('status', 'in', ['connected', 'degraded'])
    // A read-only connection never gets a write queued, whatever its adapter can do (read-only.md).
    .where('read_only', '=', false)
    // Where refresh passed live, or in an account's Test mode (docs/features/test-mode.md).
    .where((eb) =>
      eb.or([
        ...(marketplaces.length === 0 ? [] : [eb('marketplace', 'in', marketplaces)]),
        eb(
          'account_id',
          'in',
          eb.selectFrom('account').select('account.id').where('account.test_mode', '=', true),
        ),
      ]),
    )
    .where('marketplace', 'in', REFRESH_MARKETPLACES)
    .orderBy('id')
    .execute();
  let queued = 0;
  for (const connection of connections) {
    const adapter = deps.adapters(connection.marketplace);
    const limits = deps.limits(connection.marketplace);
    if (adapter === undefined || limits === undefined) continue;
    const ref = { id: connection.id, mode: connection.mode, status: connection.status };
    const mode = operationMode(adapter.capabilities(ref), 'refresh');
    if (mode !== 'automation' && mode !== 'api') continue;
    queued += await refreshConnection(deps, { ...connection, limits }, now);
  }
  if (queued > 0) deps.logger.info({ queued }, 'listing refreshes queued');
  return { queued };
}

async function refreshConnection(
  deps: ListingRefreshDependencies,
  connection: { id: string; account_id: string; limits: RunLimits },
  now: Date,
): Promise<number> {
  const accountId = connection.account_id;
  return inTransaction(deps.db, async (trx) => {
    const { rows: locked } = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtext(${`listing_refresh:${connection.id}`})) as locked
    `.execute(trx);
    if (locked[0]?.locked !== true) return 0;

    const settings = await loadRefreshSettings(trx, accountId);
    if (inQuietWindow(now, quietWindowOf(settings))) return 0;
    const room = await roomFor(trx, accountId, connection, now);
    if (room <= 0) return 0;

    const facts = await loadRefreshFacts(trx, accountId, { connectionId: connection.id });
    const due = facts.flatMap((fact) => {
      if (fact.busy) return [];
      const hours = intervalHours(effectiveCadence(fact.itemCadence, settings));
      if (hours === null) return [];
      const at = dueAt(fact.freshAt, hours);
      return at <= now ? [{ fact, at }] : [];
    });
    due.sort((a, b) => a.at.getTime() - b.at.getTime());
    // Asked to show as fresh from now on, to the second (the marketplaces keep their times so).
    const refreshedAfter = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
    let queued = 0;
    for (const { fact } of due.slice(0, room)) {
      const { created } = await enqueueOperation(trx, {
        accountId,
        listingId: fact.listingId,
        kind: 'refresh',
        desired: { refreshedAfter },
        origin: 'auto_refresh',
        idempotencyKey: `listing.refresh:${fact.listingId}:${String(fact.freshAt.getTime())}`,
      });
      if (created) queued += 1;
    }
    return queued;
  });
}

/** How many refreshes the connection has room for now, within `REFRESH_PACE`. */
async function roomFor(
  trx: DbTransaction,
  accountId: string,
  connection: { id: string; limits: RunLimits },
  now: Date,
): Promise<number> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const { rows } = await sql<{ last_hour: number; last_day: number; unfinished: number }>`
    select
      count(*) filter (where op.created_at > ${hourAgo})::int as last_hour,
      count(*) filter (where op.created_at > ${dayAgo})::int as last_day,
      count(*) filter (
        where op.status in ('queued', 'running', 'retrying', 'verifying', 'needs_user_action')
      )::int as unfinished
    from marketplace_operation op
    join marketplace_listing listing
      on listing.account_id = op.account_id and listing.id = op.listing_id
    where op.account_id = ${accountId} and listing.account_id = ${accountId}
      and listing.connection_id = ${connection.id}
      and op.kind = 'refresh'
      and (op.created_at > ${dayAgo}
        or op.status in ('queued', 'running', 'retrying', 'verifying', 'needs_user_action'))
  `.execute(trx);
  const counts = rows[0] ?? { last_hour: 0, last_day: 0, unfinished: 0 };
  const cap = (limit: number) =>
    Math.floor((limit * REFRESH_PACE.shareOfLimits) / REFRESH_PACE.runsPerRefresh);
  return Math.min(
    REFRESH_PACE.maxPerTick,
    REFRESH_PACE.maxUnfinished - counts.unfinished,
    cap(connection.limits.runsPerHour) - counts.last_hour,
    cap(connection.limits.runsPerDay) - counts.last_day,
  );
}
