/**
 * Drift resync: reads a listing back from its marketplace when the marketplace says it changed
 * (eBay's `LISTING` notification, a sale), so a change the seller made on the marketplace
 * itself reaches Listora. It records only what a read shows, the way an operation's read-back
 * does (status, `remote_snapshot`, `last_verified_at`), and never touches an operation.
 *
 * - **One at a time with the listing's operations.** The job runs in the listing's queue
 *   (`listing:<id>`), so it never overlaps an operation step. A listing with an unfinished
 *   operation is left alone: that operation's own read-back records the truth.
 * - **Never from a stale read.** With `readFreshness: 'revision'`, a read older than the
 *   newest revision Listora has seen changes nothing. Without revisions (eBay), a read that
 *   differs from the row is recorded only when a second read a delay later shows the same.
 * - **Absence.** Only an authoritative not-found ends the listing; any other empty answer
 *   decides nothing.
 * - Listings with a pending (unverified) id are the engine's: resync skips them.
 */
import { sql, type Selectable } from 'kysely';

import {
  inTransaction,
  jsonb,
  type Db,
  type DbExecutor,
  type JsonObject,
  type MarketplaceListingTable,
} from '@listora/db';
import type {
  AdapterLookup,
  ConnectionRef,
  RemoteListingState,
  RemoteListingStatus,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { remoteSnapshot } from './evidence.ts';
import { listingQueueName } from './jobs.ts';
import { UNFINISHED_STATUSES } from './state-machine.ts';

/** The Graphile Worker task the worker runs `runListingResync` under. */
export const LISTING_RESYNC_TASK = 'listing_resync';

/** A read that differs from the row is confirmed at most this many times before giving up. */
const MAX_CONFIRMATION_ROUNDS = 3;
const RESYNC_MAX_ATTEMPTS = 5;

export interface ListingResyncPayload {
  accountId: string;
  listingId: string;
  /** The differing read the previous run saw, waiting for a second read to agree. */
  pending?: string;
  /** How many differing reads were seen so far. */
  round?: number;
}

export function isListingResyncPayload(value: unknown): value is ListingResyncPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, listingId, pending, round } = value as Record<string, unknown>;
  return (
    typeof accountId === 'string' &&
    typeof listingId === 'string' &&
    (pending === undefined || typeof pending === 'string') &&
    (round === undefined || typeof round === 'number')
  );
}

/**
 * Adds the listing's resync job on the caller's connection. A resync already waiting keeps its
 * time, so a burst of notifications reads the listing once.
 */
export async function enqueueListingResync(
  executor: DbExecutor,
  payload: ListingResyncPayload,
  runAt: Date | null = null,
): Promise<void> {
  await sql`
    select graphile_worker.add_job(
      identifier => ${LISTING_RESYNC_TASK},
      payload => ${JSON.stringify(payload)}::json,
      queue_name => ${listingQueueName(payload.listingId)},
      run_at => ${runAt}::timestamptz,
      max_attempts => ${RESYNC_MAX_ATTEMPTS},
      job_key => ${`resync:${payload.listingId}`},
      job_key_mode => ${payload.pending === undefined ? 'preserve_run_at' : 'replace'}
    )
  `.execute(executor);
}

export interface ListingResyncDependencies {
  db: Db;
  adapters: AdapterLookup;
  logger: Logger;
  /** Deadline for the read (default 60 s). */
  callTimeoutMs?: number;
  /** How long a differing read waits for its confirming read (default 30 s). */
  confirmDelayMs?: number;
}

export type ResyncOutcome =
  | 'updated'
  | 'unchanged'
  | 'confirming'
  | 'unsettled'
  | 'stale'
  | 'inconclusive'
  | 'busy'
  | 'not_readable'
  | 'gone';

type ListingRow = Selectable<MarketplaceListingTable>;

interface Observation {
  status: RemoteListingStatus;
  snapshot: JsonObject | null;
  revision: number | null;
}

/** Reads the listing and records what the marketplace shows. Throws when it cannot be read. */
export async function runListingResync(
  deps: ListingResyncDependencies,
  payload: ListingResyncPayload,
  signal: AbortSignal,
): Promise<ResyncOutcome> {
  const listing = await deps.db
    .selectFrom('marketplace_listing')
    .selectAll()
    .where('account_id', '=', payload.accountId)
    .where('id', '=', payload.listingId)
    .executeTakeFirst();
  if (listing === undefined || listing.external_listing_id === null) return 'gone';
  if (listing.pending_external_listing_id !== null) return 'busy';
  if (await hasUnfinishedOperation(deps.db, listing)) return 'busy';
  const adapter = deps.adapters(listing.marketplace);
  if (adapter === undefined) return 'not_readable';
  const connection = await loadConnection(deps.db, listing);
  const capabilities = adapter.capabilities(connection);
  if (capabilities.verifyRead !== 'api') return 'not_readable';

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(deps.callTimeoutMs ?? 60_000)]);
  const remote: RemoteListingState = await adapter.readListing(
    {
      listingId: listing.id,
      externalListingId: listing.external_listing_id,
      externalSku: listing.external_sku,
      externalUrl: listing.external_url,
    },
    { signal: deadline, connection },
  );
  const observed = observation(remote);
  if (observed === undefined) return 'inconclusive';

  const log = deps.logger.child({ listingId: listing.id, accountId: listing.account_id });
  if (sameAsRow(listing, observed)) {
    if (observed.snapshot !== null) await touchVerified(deps.db, listing);
    return 'unchanged';
  }
  if (capabilities.readFreshness === 'revision') {
    if (
      observed.revision !== null &&
      listing.remote_revision !== null &&
      observed.revision < listing.remote_revision
    ) {
      return 'stale';
    }
  } else {
    const digest = JSON.stringify(observed);
    if (payload.pending !== digest) {
      const round = (payload.round ?? 0) + 1;
      if (round > MAX_CONFIRMATION_ROUNDS) {
        log.warn('listing resync: the marketplace kept answering differently; left as it was');
        return 'unsettled';
      }
      await enqueueListingResync(
        deps.db,
        { accountId: listing.account_id, listingId: listing.id, pending: digest, round },
        new Date(Date.now() + (deps.confirmDelayMs ?? 30_000)),
      );
      return 'confirming';
    }
  }

  const updated = await record(deps.db, listing, observed);
  if (updated) {
    log.info(
      { from: listing.status, to: observed.status },
      'listing resync recorded a change made on the marketplace',
    );
  }
  return updated ? 'updated' : 'busy';
}

function observation(remote: RemoteListingState): Observation | undefined {
  if (remote.found) {
    return { status: remote.status, snapshot: remoteSnapshot(remote), revision: remote.revision };
  }
  return remote.authoritative ? { status: 'ended', snapshot: null, revision: null } : undefined;
}

function sameAsRow(listing: ListingRow, observed: Observation): boolean {
  if (listing.status !== observed.status) return false;
  if (observed.snapshot === null) return true;
  return canonical(listing.remote_snapshot) === canonical(observed.snapshot);
}

async function record(db: Db, listing: ListingRow, observed: Observation): Promise<boolean> {
  return inTransaction(db, async (trx) => {
    // Under the row lock: an operation enqueued meanwhile owns the listing's truth.
    const locked = await trx
      .selectFrom('marketplace_listing')
      .select(['id', 'pending_external_listing_id', 'external_listing_id'])
      .where('account_id', '=', listing.account_id)
      .where('id', '=', listing.id)
      .forUpdate()
      .executeTakeFirst();
    if (
      locked?.external_listing_id !== listing.external_listing_id ||
      locked.pending_external_listing_id !== null ||
      (await hasUnfinishedOperation(trx, listing))
    ) {
      return false;
    }
    await trx
      .updateTable('marketplace_listing')
      .set({
        status: observed.status,
        ...(observed.snapshot === null
          ? {}
          : {
              remote_snapshot: jsonb(observed.snapshot),
              last_verified_at: sql<Date>`now()`,
              remote_revision: sql<
                number | null
              >`greatest(remote_revision, ${observed.revision}::bigint)`,
            }),
        ...(observed.status === 'active'
          ? { listed_at: sql<Date>`coalesce(listed_at, now())`, ended_at: null }
          : { ended_at: sql<Date>`coalesce(ended_at, now())` }),
      })
      .where('account_id', '=', listing.account_id)
      .where('id', '=', listing.id)
      .execute();
    return true;
  });
}

async function touchVerified(db: Db, listing: ListingRow): Promise<void> {
  await db
    .updateTable('marketplace_listing')
    .set({ last_verified_at: sql<Date>`now()` })
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.id)
    .where('status', '=', listing.status)
    .execute();
}

async function hasUnfinishedOperation(executor: DbExecutor, listing: ListingRow): Promise<boolean> {
  const row = await executor
    .selectFrom('marketplace_operation')
    .select('id')
    .where('account_id', '=', listing.account_id)
    .where('listing_id', '=', listing.id)
    .where('status', 'in', [...UNFINISHED_STATUSES])
    .executeTakeFirst();
  return row !== undefined;
}

async function loadConnection(db: Db, listing: ListingRow): Promise<ConnectionRef | null> {
  if (listing.connection_id === null) return null;
  const connection = await db
    .selectFrom('marketplace_connection')
    .select(['id', 'mode'])
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.connection_id)
    .executeTakeFirst();
  return connection ?? null;
}

/** Key-sorted JSON, so two snapshots compare by content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}
