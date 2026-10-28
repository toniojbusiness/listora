/**
 * Settling an import's entries (docs/features/imports.md): the worker's `listing_import_apply`
 * job, run after every page the import reads. Each listing it read becomes one of:
 *
 * - `already_listed`: Listora already has that listing (by its id on the marketplace);
 * - `merged`: a listing of the item it is the same as (match.ts: its SKU line, else its title
 *   and photos), whose details stay as they are;
 * - `imported`: a new item with the listing's details and photos, listed there;
 * - `needs_you`: it may be an item Listora has, so the seller decides (resolve.ts);
 * - `failed`: its photos could not be fetched, and it is not imported (importing again tries
 *   again).
 *
 * A listing that is imported or merged is `active` on its marketplace as the import's read showed
 * it: the read through the seller's session is its read-back (`last_verified_at`,
 * `remote_snapshot`), so it shows as "Active (confirmed by Depop)", and its item is listed.
 * Nothing on the marketplace changes.
 *
 * Every entry is settled in a transaction that holds the account's import lock, so two imports
 * (Depop's and Poshmark's at once) never make two items of one: the second sees the first's item
 * and merges into it. Photos are fetched before the transaction; the upload objects of a
 * transaction that rolls back are left unreferenced, never pointed at by a row.
 */
import { randomUUID } from 'node:crypto';

import { sql, type Selectable } from 'kysely';

import {
  createInventoryItem,
  inTransaction,
  jsonb,
  type Db,
  type DbTransaction,
  type JsonArray,
  type JsonObject,
  type ListingImportEntryTable,
  type ListingImportOutcome,
  type Marketplace,
} from '@listora/db';
import { MARKETPLACE_NAMES, type ListedListing } from '@listora/marketplaces';
import { remoteSnapshot, syncItemListedStatus } from '@listora/operations';
import { graphilePhotoJobs, storageKeys, type PhotoJobQueue } from '@listora/photos';
import type { Logger } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

import { importedItem, importedListingColumns, type ImportedItem } from './details.ts';
import { matchListing, type MatchCandidate, type MatchResult } from './match.ts';
import { importedPhoto, type ImportedPhoto, type ImportPhotoFetcher } from './photos.ts';
import { listedListing } from './read-entry.ts';

export interface ImportApplyDependencies {
  db: Db;
  storage: ObjectStorage;
  photos: ImportPhotoFetcher;
  /** The photo pipeline's queue (tests record jobs instead). */
  photoJobs?: PhotoJobQueue;
  logger: Logger;
}

export interface ImportApplyPayload {
  accountId: string;
  importId: string;
}

type EntryRow = Selectable<ListingImportEntryTable>;

/** Entries settled per round; each in its own transaction. */
const BATCH = 25;
/** How long all of one listing's photos may take to fetch. */
const PHOTOS_TIMEOUT_MS = 90_000;

/** The worker's job: settles every pending entry, then finishes the import once it can. */
export async function applyListingImport(
  deps: ImportApplyDependencies,
  payload: ImportApplyPayload,
): Promise<void> {
  const log = deps.logger.child({ task: 'listing_import_apply', importId: payload.importId });
  let after: string | null = null;
  for (;;) {
    const entries = await deps.db
      .selectFrom('listing_import_entry')
      .selectAll()
      .where('account_id', '=', payload.accountId)
      .where('import_id', '=', payload.importId)
      .where('outcome', '=', 'pending')
      .$if(after !== null, (query) => query.where('id', '>', after ?? ''))
      .orderBy('id')
      .limit(BATCH)
      .execute();
    if (entries.length === 0) break;
    for (const entry of entries) {
      await settleEntry(deps, entry, log);
      after = entry.id;
    }
  }
  await finishIfSettled(deps.db, payload);
}

/** One entry: decided without photos where it can be, else with them. */
async function settleEntry(
  deps: ImportApplyDependencies,
  entry: EntryRow,
  log: Logger,
): Promise<void> {
  const listing = listedListing(entry.listing);
  if (listing === null) {
    await inTransaction(deps.db, (trx) =>
      settle(trx, entry, 'failed', {
        error: "Listora couldn't read this listing's details.",
      }),
    );
    return;
  }
  let photos: ImportedPhoto[] | null = null;
  for (;;) {
    const decided = await inTransaction(deps.db, (trx) =>
      decide(deps, trx, entry, listing, photos),
    );
    if (decided !== 'needs_photos') return;
    photos = await fetchPhotos(deps, listing, log);
  }
}

/**
 * Settles the entry under the account's import lock, or says it needs the listing's photos first
 * (for the photo match, or for a new item).
 */
async function decide(
  deps: ImportApplyDependencies,
  trx: DbTransaction,
  entry: EntryRow,
  listing: ListedListing,
  photos: ImportedPhoto[] | null,
): Promise<'settled' | 'needs_photos'> {
  await lockAccount(trx, entry.account_id);
  const current = await trx
    .selectFrom('listing_import_entry')
    .select(['outcome', 'new_item'])
    .where('account_id', '=', entry.account_id)
    .where('id', '=', entry.id)
    .forUpdate()
    .executeTakeFirst();
  if (current?.outcome !== 'pending') return 'settled';
  const existing = await trx
    .selectFrom('marketplace_listing')
    .select(['id', 'item_id'])
    .where('account_id', '=', entry.account_id)
    .where('marketplace', '=', entry.marketplace)
    .where('external_listing_id', '=', entry.external_listing_id)
    .executeTakeFirst();
  if (existing !== undefined) {
    await settle(trx, entry, 'already_listed', {
      itemId: existing.item_id,
      listingId: existing.id,
    });
    return 'settled';
  }
  const details = importedItem(entry.marketplace, listing);
  // The seller said it is an item of its own.
  const candidates = current.new_item
    ? []
    : await matchCandidates(trx, entry.account_id, entry.marketplace);
  const bySku = matchListing(
    { sku: listing.details.sku, title: null, brand: null, photoHashes: [] },
    candidates,
  );
  let result: MatchResult = bySku;
  if (bySku.type !== 'match') {
    if (photos === null && listing.details.photoUrls.length > 0) return 'needs_photos';
    result = matchListing(
      {
        sku: null,
        title: details.title,
        brand: details.brand,
        photoHashes: (photos ?? []).map((photo) => photo.phash),
      },
      candidates,
    );
  }
  switch (result.type) {
    case 'match': {
      const listingId = await insertListing(trx, entry, listing, result.itemId);
      if (listingId === null) {
        // The item got a listing there meanwhile: the seller decides.
        await settle(trx, entry, 'needs_you', {
          candidates: [
            { itemId: result.itemId, reason: result.match === 'sku' ? 'sku' : 'photo_and_title' },
          ],
        });
        return 'settled';
      }
      await syncItemListedStatus(trx, entry.account_id, result.itemId);
      await audit(trx, entry, result.itemId, 'listing.imported', { match: result.match });
      await settle(trx, entry, 'merged', {
        itemId: result.itemId,
        listingId,
        match: result.match,
      });
      return 'settled';
    }
    case 'unsure':
      await settle(trx, entry, 'needs_you', { candidates: result.candidates });
      return 'settled';
    case 'new': {
      if (photos === null && listing.details.photoUrls.length > 0) return 'needs_photos';
      if (listing.details.photoUrls.length > 0 && (photos ?? []).length === 0) {
        await settle(trx, entry, 'failed', {
          error: `Listora couldn't get this listing's photos from ${MARKETPLACE_NAMES[entry.marketplace]}. Import again to try again.`,
        });
        return 'settled';
      }
      await createItem(deps, trx, entry, listing, details, photos ?? []);
      return 'settled';
    }
  }
}

/** A new item from the listing, with its photos, listed there. */
export async function createItem(
  deps: Pick<ImportApplyDependencies, 'storage' | 'photoJobs'>,
  trx: DbTransaction,
  entry: EntryRow,
  listing: ListedListing,
  details: ImportedItem,
  photos: readonly ImportedPhoto[],
): Promise<string> {
  const item = await createInventoryItem(trx, entry.account_id, {
    title: details.title,
    description: details.description,
    brand: details.brand,
    category: details.category,
    department: details.department,
    size_label: details.sizeLabel,
    size_system: details.sizeSystem,
    condition: details.condition,
    list_price_cents: details.listPriceCents,
    status: 'ready',
    field_provenance: jsonb(
      Object.fromEntries(
        details.fromListing.map((field) => [
          field === 'listPriceCents' ? 'listPrice' : field,
          'marketplace',
        ]),
      ) as JsonObject,
    ),
  });
  await insertItemPhotos(deps, trx, entry.account_id, item.id, photos);
  const listingId = await insertListing(trx, entry, listing, item.id);
  if (listingId === null) throw new Error('a new item already has a listing there');
  await syncItemListedStatus(trx, entry.account_id, item.id);
  await audit(trx, entry, item.id, 'item.imported', { photos: photos.length });
  await settle(trx, entry, 'imported', { itemId: item.id, listingId });
  return item.id;
}

/**
 * A new item's photos, cover first: each stored as an upload and processed by the photo pipeline
 * like any other.
 */
export async function insertItemPhotos(
  deps: Pick<ImportApplyDependencies, 'storage' | 'photoJobs'>,
  trx: DbTransaction,
  accountId: string,
  itemId: string,
  photos: readonly ImportedPhoto[],
): Promise<void> {
  const jobs = deps.photoJobs ?? graphilePhotoJobs;
  for (const [position, photo] of photos.entries()) {
    const key = storageKeys.upload(accountId, randomUUID());
    await deps.storage.put(key, photo.jpeg, { contentType: 'image/jpeg' });
    const row = await trx
      .insertInto('photo')
      .values({
        account_id: accountId,
        item_id: itemId,
        position,
        role: position === 0 ? 'front' : 'detail',
        storage_key: key,
        sha256: photo.sha256,
        width: photo.width,
        height: photo.height,
        phash: photo.phash,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await jobs.enqueue(trx, { accountId, photoId: row.id });
  }
}

/**
 * The listing on its marketplace, as the import read it: active, confirmed by that read. `null`
 * when the item already has a live listing there (one per item and marketplace).
 */
export async function insertListing(
  trx: DbTransaction,
  entry: EntryRow,
  listing: ListedListing,
  itemId: string,
): Promise<string | null> {
  const live = await trx
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', entry.account_id)
    .where('item_id', '=', itemId)
    .where('marketplace', '=', entry.marketplace)
    .where('status', 'not in', ['ended', 'sold'])
    .executeTakeFirst();
  if (live !== undefined) return null;
  const connection = await trx
    .selectFrom('listing_import')
    .select('connection_id')
    .where('account_id', '=', entry.account_id)
    .where('id', '=', entry.import_id)
    .executeTakeFirstOrThrow();
  const columns = importedListingColumns(entry.marketplace, listing);
  const inserted = await trx
    .insertInto('marketplace_listing')
    .values({
      account_id: entry.account_id,
      item_id: itemId,
      marketplace: entry.marketplace,
      connection_id: connection.connection_id,
      status: 'active',
      external_listing_id: listing.externalListingId,
      external_sku: columns.sku,
      external_url: listing.externalUrl,
      title: columns.title,
      description: columns.description,
      price_cents: columns.priceCents,
      category_ref: columns.categoryRef,
      condition: columns.condition,
      listed_at: entry.created_at,
      last_verified_at: entry.created_at,
      remote_snapshot: jsonb(remoteSnapshot(listing)),
      remote_revision: listing.revision,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

/**
 * The items a listing on `marketplace` may be: not sold, shipped, or archived, and with no live
 * listing there yet, each with its SKU, title, brand, its listings' SKU lines, and its photos'
 * hashes.
 */
export async function matchCandidates(
  trx: DbTransaction,
  accountId: string,
  marketplace: Marketplace,
): Promise<MatchCandidate[]> {
  const rows = await trx
    .selectFrom('inventory_item as item')
    .select((eb) => [
      'item.id',
      'item.sku',
      'item.title',
      'item.brand',
      eb
        .selectFrom('marketplace_listing as listing')
        .select(sql<string[]>`coalesce(array_agg(listing.external_sku), '{}')`.as('skus'))
        .whereRef('listing.account_id', '=', 'item.account_id')
        .whereRef('listing.item_id', '=', 'item.id')
        .where('listing.external_sku', 'is not', null)
        .as('listingSkus'),
      eb
        .selectFrom('photo')
        .select(
          sql<string[]>`coalesce(array_agg(photo.phash order by photo.position), '{}')`.as(
            'hashes',
          ),
        )
        .whereRef('photo.account_id', '=', 'item.account_id')
        .whereRef('photo.item_id', '=', 'item.id')
        .where('photo.phash', 'is not', null)
        .as('photoHashes'),
    ])
    .where('item.account_id', '=', accountId)
    .where('item.status', 'in', ['draft', 'ready', 'listed'])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('marketplace_listing as live')
            .select('live.id')
            .whereRef('live.account_id', '=', 'item.account_id')
            .whereRef('live.item_id', '=', 'item.id')
            .where('live.marketplace', '=', marketplace)
            .where('live.status', 'not in', ['ended', 'sold']),
        ),
      ),
    )
    .execute();
  return rows.map((row) => ({
    itemId: row.id,
    sku: row.sku,
    title: row.title,
    brand: row.brand,
    listingSkus: row.listingSkus ?? [],
    photoHashes: row.photoHashes ?? [],
  }));
}

/**
 * The listing's photos, in order (the first `limit`); one that can't be fetched or read is left
 * out.
 */
export async function fetchPhotos(
  deps: Pick<ImportApplyDependencies, 'photos'>,
  listing: ListedListing,
  log: Logger,
  limit = listing.details.photoUrls.length,
): Promise<ImportedPhoto[]> {
  const signal = AbortSignal.timeout(PHOTOS_TIMEOUT_MS);
  const photos: ImportedPhoto[] = [];
  for (const url of listing.details.photoUrls.slice(0, limit)) {
    try {
      photos.push(await importedPhoto(await deps.photos.fetch(url, signal)));
    } catch (error) {
      log.warn(
        {
          event: 'listing_import_photo_failed',
          host: hostOf(url),
          err: error instanceof Error ? error.message : String(error),
        },
        'import photo not fetched',
      );
    }
  }
  return photos;
}

/** Serializes the account's import decisions, across imports and workers. */
async function lockAccount(trx: DbTransaction, accountId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`listing_import:${accountId}`}, 0))`.execute(
    trx,
  );
}

/** Settles the entry and counts it on its import. */
export async function settle(
  trx: DbTransaction,
  entry: Pick<EntryRow, 'account_id' | 'id' | 'import_id'>,
  outcome: Exclude<ListingImportOutcome, 'pending'>,
  details: {
    itemId?: string;
    listingId?: string;
    match?: 'sku' | 'title_photos' | 'seller';
    candidates?: { itemId: string; reason: string }[];
    error?: string;
  } = {},
): Promise<void> {
  await trx
    .updateTable('listing_import_entry')
    .set({
      outcome,
      settled_at: sql<Date>`now()`,
      item_id: details.itemId ?? null,
      listing_id: details.listingId ?? null,
      match: details.match ?? null,
      candidates: jsonb((details.candidates ?? []) as unknown as JsonArray),
      error_message: details.error?.slice(0, 500) ?? null,
    })
    .where('account_id', '=', entry.account_id)
    .where('id', '=', entry.id)
    .execute();
  await recount(trx, entry);
}

/** The import's counts, from its entries. */
export async function recount(
  trx: DbTransaction,
  entry: Pick<EntryRow, 'account_id' | 'import_id'>,
): Promise<void> {
  await sql`
    update listing_import set
      imported = counts.imported,
      merged = counts.merged,
      already_listed = counts.already_listed,
      needs_you = counts.needs_you,
      failed = counts.failed
    from (
      select
        count(*) filter (where outcome = 'imported')::int as imported,
        count(*) filter (where outcome = 'merged')::int as merged,
        count(*) filter (where outcome = 'already_listed')::int as already_listed,
        count(*) filter (where outcome = 'needs_you')::int as needs_you,
        count(*) filter (where outcome = 'failed')::int as failed
      from listing_import_entry
      where account_id = ${entry.account_id} and import_id = ${entry.import_id}
    ) as counts
    where listing_import.account_id = ${entry.account_id} and listing_import.id = ${entry.import_id}
  `.execute(trx);
}

/** An import whose reading is over and whose entries are all settled is finished. */
async function finishIfSettled(db: Db, payload: ImportApplyPayload): Promise<void> {
  await db
    .updateTable('listing_import')
    .set({ status: 'finished', finished_at: sql<Date>`now()` })
    .where('account_id', '=', payload.accountId)
    .where('id', '=', payload.importId)
    .where('status', '=', 'importing')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('listing_import_entry')
            .select('id')
            .where('account_id', '=', payload.accountId)
            .where('import_id', '=', payload.importId)
            .where('outcome', '=', 'pending'),
        ),
      ),
    )
    .execute();
}

async function audit(
  trx: DbTransaction,
  entry: EntryRow,
  itemId: string,
  action: 'item.imported' | 'listing.imported',
  changes: JsonObject,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      account_id: entry.account_id,
      item_id: itemId,
      actor_kind: 'marketplace',
      action,
      changes: jsonb({
        marketplace: entry.marketplace,
        externalListingId: entry.external_listing_id,
        importId: entry.import_id,
        ...changes,
      }),
    })
    .execute();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
