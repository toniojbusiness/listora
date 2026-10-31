/**
 * The price drop schedule (`price_drops`, every 5 minutes; docs/features/price-drops.md): for
 * each marketplace session Listora can change prices through, it runs the drops that are due,
 * longest due first, each as an ordinary price change (`reprice_rule`), so it is sent by the
 * engine, confirmed only by a read-back, and visible and retryable when it fails.
 *
 * Drops are automatic writes on live listings, so they are held well inside the shared pace:
 * at most `perConnectionPerDay` a day per connection (the daily cap), at most `shareOfLimits` of
 * the connection's automation run limits per hour and per day (each drop takes about
 * `runsPerDrop` runs: the edit, and its read-back), one at a time per connection, and at least
 * `minGapMinutes` apart, so the seller's own changes, delists, and sale checks always have room
 * and a shop never changes many prices at once. One run per connection at a time (an advisory
 * lock), and one drop per listing per unsold period (its idempotency key).
 */
import { inTransaction, jsonb, type Db, type DbTransaction, type Marketplace } from '@listora/db';
import {
  loadFeatureGate,
  operationMode,
  SELLER_FEATURES,
  type AdapterLookup,
  type FeatureGate,
} from '@listora/marketplaces';
import { enqueueOperation } from '@listora/operations';
import type { Logger } from '@listora/shared';
import { sql } from 'kysely';

import {
  loadDropFacts,
  planDrops,
  PRICE_DROP_MARKETPLACES,
  priceDropMarketplaces,
} from './plan.ts';
import { listDropRules } from './store.ts';

export const PRICE_DROPS_TASK = 'price_drops';
export const PRICE_DROPS_SCHEDULE = '*/5 * * * *';

export const PRICE_DROP_PACE = {
  /** Drops queued per connection in any 24 hours, at most: the daily cap. */
  perConnectionPerDay: 10,
  /** Of each automation run limit (per hour, per day), what drops may use. */
  shareOfLimits: 0.25,
  /** Runs one drop takes: the edit, and its read-back. */
  runsPerDrop: 2,
  /** Drops not finished yet on one connection, at most. */
  maxUnfinished: 1,
  /** Minutes between two drops on one connection, at least. */
  minGapMinutes: 10,
} as const;

/** A connection's automation run limits (the browser runner's, `AUTOMATION_<MARKETPLACE>_*`). */
export interface RunLimits {
  runsPerHour: number;
  runsPerDay: number;
}

export interface PriceDropDependencies {
  db: Db;
  adapters: AdapterLookup;
  /** The run limits of a marketplace's sessions; none: Listora doesn't drop prices there. */
  limits: (marketplace: Marketplace) => RunLimits | undefined;
  logger: Pick<Logger, 'info'>;
  now?: () => Date;
}

export interface PriceDropResult {
  /** Price drops queued. */
  queued: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export async function runPriceDrops(deps: PriceDropDependencies): Promise<PriceDropResult> {
  const now = deps.now?.() ?? new Date();
  const verified = priceDropMarketplaces(SELLER_FEATURES);
  const connections = await deps.db
    .selectFrom('marketplace_connection')
    .select(['id', 'account_id', 'marketplace', 'mode', 'status'])
    .where('status', 'in', ['connected', 'degraded'])
    // A read-only connection never gets a write queued (read-only.md).
    .where('read_only', '=', false)
    .where('marketplace', 'in', PRICE_DROP_MARKETPLACES)
    // Where price drops passed live, or in an account's Test mode (docs/features/test-mode.md).
    .where((eb) =>
      eb.or([
        ...(verified.length === 0 ? [] : [eb('marketplace', 'in', verified)]),
        eb(
          'account_id',
          'in',
          eb.selectFrom('account').select('account.id').where('account.test_mode', '=', true),
        ),
      ]),
    )
    // Only accounts with a rule on.
    .where(
      'account_id',
      'in',
      deps.db.selectFrom('price_drop_rule').select('account_id').where('enabled', '=', true),
    )
    .orderBy('id')
    .execute();
  let queued = 0;
  for (const connection of connections) {
    const adapter = deps.adapters(connection.marketplace);
    const limits = deps.limits(connection.marketplace);
    if (adapter === undefined || limits === undefined) continue;
    const ref = { id: connection.id, mode: connection.mode, status: connection.status };
    // Only a price change Listora sends and reads back itself; an assisted one is the seller's.
    const mode = operationMode(adapter.capabilities(ref), 'price');
    if (mode !== 'automation' && mode !== 'api') continue;
    queued += await dropOnConnection(deps, { ...connection, limits }, now);
  }
  if (queued > 0) deps.logger.info({ queued }, 'price drops queued');
  return { queued };
}

async function dropOnConnection(
  deps: PriceDropDependencies,
  connection: { id: string; account_id: string; limits: RunLimits },
  now: Date,
): Promise<number> {
  const accountId = connection.account_id;
  return inTransaction(deps.db, async (trx) => {
    const { rows: locked } = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtext(${`price_drops:${connection.id}`})) as locked
    `.execute(trx);
    if (locked[0]?.locked !== true) return 0;
    if (!(await hasRoom(trx, accountId, connection, now))) return 0;

    const gate: FeatureGate = await loadFeatureGate(trx, accountId);
    const rules = await listDropRules(trx, accountId);
    const facts = await loadDropFacts(trx, accountId, { connectionId: connection.id });
    const due = planDrops(facts, rules, gate, now).filter(
      ({ fact, plan }) => !fact.busy && plan.state === 'scheduled' && plan.at <= now,
    );
    for (const { fact, rule, plan } of due) {
      if (plan.state !== 'scheduled' || fact.priceCents === null) continue;
      const idempotencyKey = `price_drop:${fact.listingId}:${String(fact.unsoldSince.getTime())}`;
      // One drop per unsold period: one the seller canceled is not sent again.
      const sent = await trx
        .selectFrom('marketplace_operation')
        .select('id')
        .where('account_id', '=', accountId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (sent !== undefined) continue;
      await trx
        .updateTable('marketplace_listing')
        .set({ price_cents: plan.priceCents, desired_version: sql<number>`desired_version + 1` })
        .where('account_id', '=', accountId)
        .where('id', '=', fact.listingId)
        .execute();
      const { operation } = await enqueueOperation(trx, {
        accountId,
        listingId: fact.listingId,
        kind: 'price',
        desired: { priceCents: plan.priceCents, currency: fact.currency },
        origin: 'reprice_rule',
        priceDropRuleId: rule.id,
        idempotencyKey,
      });
      await trx
        .insertInto('audit_log')
        .values({
          account_id: accountId,
          item_id: fact.itemId,
          actor_kind: 'system',
          action: 'listing.price_drop_requested',
          changes: jsonb({
            listingId: fact.listingId,
            operationId: operation.id,
            ruleId: rule.id,
            priceCents: { from: fact.priceCents, to: plan.priceCents },
          }),
        })
        .execute();
      // One drop per connection per run, within the pace.
      return 1;
    }
    return 0;
  });
}

/** Whether the connection has room for another drop now, within `PRICE_DROP_PACE`. */
async function hasRoom(
  trx: DbTransaction,
  accountId: string,
  connection: { id: string; limits: RunLimits },
  now: Date,
): Promise<boolean> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const gapAgo = new Date(now.getTime() - PRICE_DROP_PACE.minGapMinutes * MINUTE_MS);
  const { rows } = await sql<{
    last_hour: number;
    last_day: number;
    last_gap: number;
    unfinished: number;
  }>`
    select
      count(*) filter (where op.created_at > ${hourAgo})::int as last_hour,
      count(*) filter (where op.created_at > ${dayAgo})::int as last_day,
      count(*) filter (where op.created_at > ${gapAgo})::int as last_gap,
      count(*) filter (
        where op.status in ('queued', 'running', 'retrying', 'verifying', 'needs_user_action')
      )::int as unfinished
    from marketplace_operation op
    join marketplace_listing listing
      on listing.account_id = op.account_id and listing.id = op.listing_id
    where op.account_id = ${accountId} and listing.account_id = ${accountId}
      and listing.connection_id = ${connection.id}
      and op.origin = 'reprice_rule'
      and (op.created_at > ${dayAgo}
        or op.status in ('queued', 'running', 'retrying', 'verifying', 'needs_user_action'))
  `.execute(trx);
  const counts = rows[0] ?? { last_hour: 0, last_day: 0, last_gap: 0, unfinished: 0 };
  const cap = (limit: number) =>
    Math.floor((limit * PRICE_DROP_PACE.shareOfLimits) / PRICE_DROP_PACE.runsPerDrop);
  return (
    counts.unfinished < PRICE_DROP_PACE.maxUnfinished &&
    counts.last_gap === 0 &&
    counts.last_day <
      Math.min(PRICE_DROP_PACE.perConnectionPerDay, cap(connection.limits.runsPerDay)) &&
    counts.last_hour < cap(connection.limits.runsPerHour)
  );
}
