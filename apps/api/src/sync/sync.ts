/**
 * Syncing the linked marketplaces (docs/features/sync.md): the seller's Sync now, a pull to
 * refresh, and opening the app ask for read-only checks of every marketplace linked by signing
 * in: its sales (a sale check), the buyers' offers, and its listings once the seller imported
 * them (another import, which brings in what was listed there since). Every one only reads, so a
 * read-only connection is synced like any other; the reads of a marketplace that runs on the
 * seller's iPhone wait there for the app to claim them. Only the reads that passed live on the
 * marketplace are asked for and shown (docs/features/verified-features.md); a marketplace with
 * none is not part of a sync.
 */
import { sql } from 'kysely';

import type { SyncMarketplace } from '@listora/api-contract';
import {
  checksSales,
  enqueueSaleCheck,
  readsOffers,
  requestOfferChecks,
  saleCheckJobKey,
  scheduleSaleCheck,
} from '@listora/automation';
import { inTransaction, lockConnections, type DbExecutor, type Marketplace } from '@listora/db';
import { loadFeatureGate, type FeatureGate } from '@listora/marketplaces';
import { ImportRefusedError, importsFrom, startListingImport } from '@listora/imports';

/** A marketplace synced this recently is not read again (its sales, its offers). */
export const SYNC_MIN_GAP_MS = 2 * 60_000;
/** Listings are read again at most this often: a read goes through every listing. */
export const LISTING_SYNC_MIN_GAP_MS = 6 * 60 * 60_000;

interface SyncConnection {
  id: string;
  marketplace: Marketplace;
  readOnly: boolean;
  /** The reads shown on its marketplace (`syncReads`). */
  reads: ReturnType<typeof syncReads>;
}

/**
 * What a sync reads of a marketplace: only the reads shown there (verified-features.md), every
 * built one in the account's Test mode (test-mode.md).
 */
function syncReads(marketplace: Marketplace, gate: FeatureGate) {
  return {
    sales: checksSales(marketplace, gate),
    offers: readsOffers(marketplace, gate),
    listings: importsFrom(marketplace, gate),
  };
}

/** The connections a sync reads: linked by signing in, working, and with a read shown. */
async function syncConnections(db: DbExecutor, accountId: string): Promise<SyncConnection[]> {
  const gate = await loadFeatureGate(db, accountId);
  const rows = await db
    .selectFrom('marketplace_connection')
    .select(['id', 'marketplace', 'read_only'])
    .where('account_id', '=', accountId)
    .where('mode', '=', 'automation')
    .where('status', 'in', ['connected', 'degraded'])
    .orderBy('marketplace')
    .execute();
  return rows
    .map((row) => ({
      id: row.id,
      marketplace: row.marketplace,
      readOnly: row.read_only,
      reads: syncReads(row.marketplace, gate),
    }))
    .filter((connection) => Object.values(connection.reads).some(Boolean));
}

/** Asks for the read-only checks of every linked marketplace not synced in the last minutes. */
export async function requestSync(
  db: DbExecutor,
  request: { accountId: string; minGapMs?: number; listingGapMs?: number },
): Promise<void> {
  const gapMs = request.minGapMs ?? SYNC_MIN_GAP_MS;
  const listingGapMs = request.listingGapMs ?? LISTING_SYNC_MIN_GAP_MS;
  for (const connection of await syncConnections(db, request.accountId)) {
    const check = {
      accountId: request.accountId,
      connectionId: connection.id,
      marketplace: connection.marketplace,
    };
    if (connection.reads.sales) await syncSales(db, check, gapMs);
    if (connection.reads.listings) await syncListings(db, check, listingGapMs);
  }
  await requestOfferChecks(db, { accountId: request.accountId, minGapMs: gapMs });
}

/** A sale check now, unless one started in the last `gapMs`. */
async function syncSales(
  db: DbExecutor,
  check: { accountId: string; connectionId: string; marketplace: Marketplace },
  gapMs: number,
): Promise<void> {
  await inTransaction(db, async (trx) => {
    // The connection before its schedule and work; gone (unlinked) means nothing to check.
    if ((await lockConnections(trx, check.accountId, [check.connectionId])).size === 0) return;
    const recent = await trx
      .selectFrom('sale_check_schedule')
      .select('connection_id')
      .where('account_id', '=', check.accountId)
      .where('connection_id', '=', check.connectionId)
      .where('last_started_at', '>', sql<Date>`now() - make_interval(secs => ${gapMs / 1000})`)
      .executeTakeFirst();
    if (recent !== undefined) return;
    await scheduleSaleCheck(trx, { ...check, at: 'now', reason: 'sync' });
    await enqueueSaleCheck(trx, check);
  });
}

/**
 * Reads the marketplace's listings again, when the seller imported them before (an import
 * brings in what was listed there since, and settles the rest at once) and the last read is
 * `gapMs` old.
 */
async function syncListings(
  db: DbExecutor,
  check: { accountId: string; connectionId: string; marketplace: Marketplace },
  gapMs: number,
): Promise<void> {
  const newest = await db
    .selectFrom('listing_import')
    .select(['status', 'created_at'])
    .where('account_id', '=', check.accountId)
    .where('connection_id', '=', check.connectionId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (newest?.status !== 'finished') return;
  if (Date.now() - newest.created_at.getTime() < gapMs) return;
  try {
    await startListingImport(db, { accountId: check.accountId, marketplace: check.marketplace });
  } catch (error) {
    // Another import started meanwhile, or the connection went: nothing to sync.
    if (!(error instanceof ImportRefusedError)) throw error;
  }
}

/** Each linked marketplace's sync: what it reads now, what its last sync found, and when. */
export async function syncStatus(db: DbExecutor, accountId: string): Promise<SyncMarketplace[]> {
  const connections = await syncConnections(db, accountId);
  if (connections.length === 0) return [];
  const ids = connections.map((connection) => connection.id);
  const [schedules, lastRuns, offers, imports, waiting, jobs] = await Promise.all([
    db
      .selectFrom('sale_check_schedule')
      .select(['connection_id', 'last_succeeded_at'])
      .where('account_id', '=', accountId)
      .where('connection_id', 'in', ids)
      .execute(),
    db
      .selectFrom('sale_check_run')
      .distinctOn('connection_id')
      .select(['connection_id', 'outcome', 'since', 'orders_seen', 'new_orders', 'finished_at'])
      .where('account_id', '=', accountId)
      .where('connection_id', 'in', ids)
      .where('kind', '=', 'scheduled')
      .where('finished_at', 'is not', null)
      .orderBy('connection_id')
      .orderBy('started_at', 'desc')
      .execute(),
    db
      .selectFrom('offer_check')
      .select(['connection_id', 'last_outcome', 'last_succeeded_at', 'offers_seen'])
      .where('account_id', '=', accountId)
      .where('connection_id', 'in', ids)
      .execute(),
    db
      .selectFrom('listing_import')
      .distinctOn('connection_id')
      .select(['connection_id', 'status', 'imported', 'created_at'])
      .where('account_id', '=', accountId)
      .where('connection_id', 'in', ids)
      .orderBy('connection_id')
      .orderBy('created_at', 'desc')
      .execute(),
    db
      .selectFrom('phone_work')
      .select(['connection_id', 'purpose'])
      .where('account_id', '=', accountId)
      .where('connection_id', 'in', ids)
      .where('purpose', 'in', ['sale_check', 'offer_check', 'listing_import'])
      .execute(),
    sql<{ key: string }>`
      select key from graphile_worker.jobs
      where key = any(${ids.map((id) => saleCheckJobKey(id))}::text[])
    `.execute(db),
  ]);
  const queuedJobs = new Set(jobs.rows.map((row) => row.key));
  return connections.map((connection) => {
    const id = connection.id;
    // Only the reads shown on this marketplace: a hidden one's records say nothing here.
    const shown = connection.reads;
    const run = shown.sales ? lastRuns.find((row) => row.connection_id === id) : undefined;
    const offer = shown.offers ? offers.find((row) => row.connection_id === id) : undefined;
    const listings = shown.listings ? imports.find((row) => row.connection_id === id) : undefined;
    const work = new Set(
      waiting.filter((row) => row.connection_id === id).map((row) => row.purpose),
    );
    const reading = {
      sales: shown.sales && (work.has('sale_check') || queuedJobs.has(saleCheckJobKey(id))),
      offers: shown.offers && work.has('offer_check'),
      listings: listings !== undefined && listings.status !== 'finished',
    };
    const lastSyncedAt = latest(
      shown.sales
        ? (schedules.find((row) => row.connection_id === id)?.last_succeeded_at ?? null)
        : null,
      offer?.last_succeeded_at ?? null,
    );
    const base = {
      marketplace: connection.marketplace,
      readOnly: connection.readOnly,
      ...(lastSyncedAt === null ? {} : { lastSyncedAt: lastSyncedAt.toISOString() }),
    };
    if (reading.sales || reading.offers || reading.listings) {
      const doing = reading.sales
        ? 'Checking sales...'
        : reading.offers
          ? 'Checking offers...'
          : 'Reading your listings...';
      return { ...base, state: 'syncing', statusText: doing };
    }
    if (run?.outcome === 'challenge') {
      return {
        ...base,
        state: 'failed',
        statusText: "Asked to check it's you. Sync again with Listora open to finish the check.",
      };
    }
    if (run?.outcome === 'failed' || offer?.last_outcome === 'failed') {
      const what = run?.outcome === 'failed' ? 'sales' : 'offers';
      return {
        ...base,
        state: 'failed',
        statusText: `Couldn't check ${what}. Sync again to try again.`,
      };
    }
    if (run === undefined && (offer?.last_outcome ?? null) === null) {
      return { ...base, state: 'not_synced', statusText: 'Not synced yet' };
    }
    const found: string[] = [];
    if (run !== undefined) found.push(salesFound(run));
    if (offer?.last_outcome === 'succeeded' && (offer.offers_seen ?? 0) > 0) {
      found.push(count(offer.offers_seen ?? 0, 'offer') + ' waiting');
    }
    if (listings !== undefined && listings.imported > 0) {
      found.push(count(listings.imported, 'new listing') + ' imported');
    }
    return {
      ...base,
      state: 'synced',
      statusText: found.length > 0 ? found.join(', ') : 'Up to date',
    };
  });
}

/** "52 sales found" on the first check (the sales history), then "2 new sales" or "No new sales". */
function salesFound(run: {
  since: Date | null;
  orders_seen: number | null;
  new_orders: number | null;
}) {
  if (run.since === null) return `${count(run.orders_seen ?? 0, 'sale')} found`;
  const fresh = run.new_orders ?? 0;
  return fresh === 0 ? 'No new sales' : count(fresh, 'new sale');
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
