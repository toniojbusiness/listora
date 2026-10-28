/**
 * Where offers are read and answered (docs/features/offers.md). Poshmark and Depop run
 * on the seller's iPhone (none may run in the cloud, `cloudAllowed`), so a read of a
 * connection's offers waits in `phone_work` (purpose `offer_check`, one per connection) and an
 * answer waits there as `offer_response` work, both behind the phone's pacing and the per-seller
 * rate limits like every run. A connection whose steps run in the cloud is not read: no
 * marketplace with offers may run there today, and its offers stay in the marketplace's app.
 *
 * A connection's offers are read when the seller asks: opening Tasks (at most once every 10
 * minutes) and syncing (docs/features/sync.md), never on a timer; and only on a marketplace whose
 * offer reads passed live (docs/features/verified-features.md): the others are never read.
 */
import { sql } from 'kysely';

import { inTransaction, type DbExecutor, type Marketplace } from '@listora/db';
import {
  isFeatureVerified,
  isOfferMarketplace,
  marketplacesWith,
  OFFER_RULES,
  type OfferMarketplace,
} from '@listora/marketplaces';

/** The marketplaces whose offers Listora can read (built; see `offerMarketplaces`). */
export const OFFER_MARKETPLACES = Object.keys(OFFER_RULES) as OfferMarketplace[];

/** The marketplaces whose offers Listora reads and shows: built, and verified live. */
export function offerMarketplaces(): OfferMarketplace[] {
  return marketplacesWith('offers', OFFER_MARKETPLACES);
}

/** Whether Listora reads and shows the marketplace's offers. */
export function readsOffers(marketplace: Marketplace): marketplace is OfferMarketplace {
  return isOfferMarketplace(marketplace) && isFeatureVerified(marketplace, 'offers');
}

/** The least time between two reads the seller asks for (opening Tasks; a sync asks sooner). */
export const OFFER_CHECK_MIN_GAP_MS = 10 * 60_000;

/** An offer read waits behind routine changes and sale checks; an answer goes with changes. */
const PHONE_OFFER_CHECK_PRIORITY = 5;
const PHONE_OFFER_RESPONSE_PRIORITY = 0;

export interface OfferCheckTarget {
  accountId: string;
  connectionId: string;
  marketplace: Marketplace;
}

/**
 * Asks for a read of the connection's offers on the phone, unless one waits there already;
 * returns whether the read waits for the phone now. Only a working automation connection that
 * runs on the phone and is on a marketplace whose offers Listora reads is read.
 */
export async function queueOfferCheck(
  executor: DbExecutor,
  target: OfferCheckTarget,
): Promise<boolean> {
  if (!readsOffers(target.marketplace)) return false;
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .selectFrom('marketplace_connection')
      .select(['runs_on'])
      .where('account_id', '=', target.accountId)
      .where('id', '=', target.connectionId)
      .where('mode', '=', 'automation')
      .where('status', 'in', ['connected', 'degraded'])
      .executeTakeFirst();
    if (connection?.runs_on !== 'phone') return false;
    await trx
      .insertInto('offer_check')
      .values({
        account_id: target.accountId,
        connection_id: target.connectionId,
        marketplace: target.marketplace,
        requested_at: sql<Date>`now()`,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['account_id', 'connection_id'])
          .doUpdateSet({ requested_at: sql<Date>`now()` }),
      )
      .execute();
    await trx
      .insertInto('phone_work')
      .values({
        account_id: target.accountId,
        connection_id: target.connectionId,
        marketplace: target.marketplace,
        purpose: 'offer_check',
        priority: PHONE_OFFER_CHECK_PRIORITY,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['account_id', 'connection_id'])
          .where('purpose', '=', 'offer_check')
          .doNothing(),
      )
      .execute();
    return true;
  });
}

/**
 * The seller opened Tasks: read the offers of each of their connections that were not asked for
 * in the last `minGapMs`. Returns the marketplaces whose read now waits for the phone.
 */
export async function requestOfferChecks(
  executor: DbExecutor,
  request: { accountId: string; minGapMs?: number },
): Promise<Marketplace[]> {
  const gapMs = request.minGapMs ?? OFFER_CHECK_MIN_GAP_MS;
  const marketplaces = offerMarketplaces();
  if (marketplaces.length === 0) return [];
  const connections = await executor
    .selectFrom('marketplace_connection as connection')
    .leftJoin('offer_check as oc', (join) =>
      join
        .onRef('oc.account_id', '=', 'connection.account_id')
        .onRef('oc.connection_id', '=', 'connection.id'),
    )
    .select(['connection.id', 'connection.marketplace'])
    .where('connection.account_id', '=', request.accountId)
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded'])
    .where('connection.runs_on', '=', 'phone')
    .where('connection.marketplace', 'in', marketplaces)
    .where((eb) =>
      eb.or([
        eb('oc.requested_at', 'is', null),
        eb('oc.requested_at', '<', sql<Date>`now() - make_interval(secs => ${gapMs / 1000})`),
      ]),
    )
    .orderBy('connection.marketplace')
    .execute();
  const queued: Marketplace[] = [];
  for (const connection of connections) {
    const target = {
      accountId: request.accountId,
      connectionId: connection.id,
      marketplace: connection.marketplace,
    };
    if (await queueOfferCheck(executor, target)) queued.push(connection.marketplace);
  }
  return queued;
}

/** Hands an answer to the phone, `delayMs` from now; an answer already waiting keeps its time. */
export async function queueOfferResponse(
  executor: DbExecutor,
  target: OfferCheckTarget & { responseId: string },
  delayMs = 0,
): Promise<void> {
  await executor
    .insertInto('phone_work')
    .values({
      account_id: target.accountId,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
      purpose: 'offer_response',
      offer_response_id: target.responseId,
      priority: PHONE_OFFER_RESPONSE_PRIORITY,
      due_at: sql<Date>`now() + make_interval(secs => ${delayMs / 1000})`,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'offer_response_id'])
        .where('offer_response_id', 'is not', null)
        .doNothing(),
    )
    .execute();
}
