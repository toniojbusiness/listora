/**
 * Marketplace listing queries. Like every repository, each function takes the request's
 * `Tenant` and filters on its account.
 */
import type { ListingVariant } from '@listora/api-contract';
import {
  jsonb,
  type ConnectionMode,
  type ConnectionStatus,
  type DbExecutor,
  type DbTransaction,
  type ItemStatus,
  type ListingStatus,
  type Marketplace,
  type MarketplaceListingTable,
  type MarketplaceOperationTable,
} from '@listora/db';
import { listingIsReadOnly, REFUSED_CONTENT_ERROR } from '@listora/operations';
import { sql, type Selectable } from 'kysely';

import type { Tenant } from '../tenancy.ts';

/**
 * A listing with the mode and status of its connection (null when it has none), whether it is
 * read only (docs/features/read-only.md), and its item's status.
 */
export type ListingRow = Selectable<MarketplaceListingTable> & {
  connection_mode: ConnectionMode | null;
  connection_status: ConnectionStatus | null;
  read_only: boolean;
  item_status: ItemStatus;
};

export type OperationRow = Selectable<MarketplaceOperationTable>;

function listingQuery(db: DbExecutor, tenant: Tenant) {
  return db
    .selectFrom('marketplace_listing as listing')
    .leftJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'listing.account_id')
        .onRef('connection.id', '=', 'listing.connection_id'),
    )
    .innerJoin('inventory_item as item', (join) =>
      join
        .onRef('item.account_id', '=', 'listing.account_id')
        .onRef('item.id', '=', 'listing.item_id'),
    )
    .selectAll('listing')
    .select([
      'connection.mode as connection_mode',
      'connection.status as connection_status',
      listingIsReadOnly('listing').as('read_only'),
      'item.status as item_status',
    ])
    .where('listing.account_id', '=', tenant.accountId);
}

/**
 * Each item's newest listing per marketplace (its live one, or its latest history), keyed by
 * item id and ordered by marketplace.
 */
export async function itemListingRows(
  db: DbExecutor,
  tenant: Tenant,
  itemIds: readonly string[],
): Promise<Map<string, ListingRow[]>> {
  const byItem = new Map<string, ListingRow[]>();
  if (itemIds.length === 0) return byItem;
  const rows = await listingQuery(db, tenant)
    .distinctOn(['listing.item_id', 'listing.marketplace'])
    .where('listing.item_id', 'in', itemIds)
    .orderBy('listing.item_id')
    .orderBy('listing.marketplace')
    .orderBy('listing.id', 'desc')
    .execute();
  for (const row of rows) {
    const list = byItem.get(row.item_id) ?? [];
    list.push(row);
    byItem.set(row.item_id, list);
  }
  return byItem;
}

/** The listings with these ids (of the tenant's account), in no particular order. */
export async function listingRowsByIds(
  db: DbExecutor,
  tenant: Tenant,
  listingIds: readonly string[],
): Promise<ListingRow[]> {
  if (listingIds.length === 0) return [];
  return listingQuery(db, tenant).where('listing.id', 'in', listingIds).execute();
}

export async function findListing(
  db: DbExecutor,
  tenant: Tenant,
  listingId: string,
): Promise<ListingRow | undefined> {
  return listingQuery(db, tenant).where('listing.id', '=', listingId).executeTakeFirst();
}

/** How a shared URL identifies its listing: by listing id, or (a short link) by URL alone. */
export interface ListingIdentity {
  marketplace: Marketplace;
  listingId: string | null;
  url: string;
}

/**
 * The listing this identity names, live or not, with its item's SKU. A listing id is unique
 * per account and marketplace whatever the status, whether confirmed or still pending a
 * read-back, and so is a short link's URL.
 */
export async function findListingByIdentity(
  db: DbExecutor,
  tenant: Tenant,
  identity: ListingIdentity,
): Promise<{ id: string; itemId: string; sku: string } | undefined> {
  let query = db
    .selectFrom('marketplace_listing as listing')
    .innerJoin('inventory_item as item', (join) =>
      join
        .onRef('item.account_id', '=', 'listing.account_id')
        .onRef('item.id', '=', 'listing.item_id'),
    )
    .select(['listing.id as id', 'listing.item_id as itemId', 'item.sku as sku'])
    .where('listing.account_id', '=', tenant.accountId)
    .where('listing.marketplace', '=', identity.marketplace);
  query =
    identity.listingId === null
      ? query
          .where('listing.external_listing_id', 'is', null)
          .where('listing.external_url', '=', identity.url)
      : query.where((eb) =>
          eb.or([
            eb('listing.external_listing_id', '=', identity.listingId),
            eb('listing.pending_external_listing_id', '=', identity.listingId),
          ]),
        );
  return query.executeTakeFirst();
}

/** Whether the item already has a listing on this marketplace that is not ended or sold. */
export async function hasLiveListingOn(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  marketplace: Marketplace,
): Promise<boolean> {
  const row = await db
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('marketplace', '=', marketplace)
    .where('status', 'not in', ['ended', 'sold'])
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Records a listing the user created on the marketplace and confirmed: `active`, with no
 * connection (so it is assisted) and no read-back.
 */
export async function insertLinkedListing(
  trx: DbTransaction,
  tenant: Tenant,
  itemId: string,
  identity: ListingIdentity,
): Promise<ListingRow> {
  const { id } = await trx
    .insertInto('marketplace_listing')
    .values({
      account_id: tenant.accountId,
      item_id: itemId,
      marketplace: identity.marketplace,
      status: 'active',
      external_listing_id: identity.listingId,
      external_url: identity.url,
      user_confirmed_at: sql<Date>`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const row = await findListing(trx, tenant, id);
  if (!row) throw new Error(`listing ${id} vanished inside its own transaction`);
  return row;
}

/**
 * Each listing's newest operation that was not canceled (a canceled one never reached the
 * marketplace, so the one before it still speaks for the listing), keyed by listing id.
 */
export async function latestOperations(
  db: DbExecutor,
  tenant: Tenant,
  listingIds: readonly string[],
): Promise<Map<string, OperationRow>> {
  const byListing = new Map<string, OperationRow>();
  if (listingIds.length === 0) return byListing;
  const rows = await db
    .selectFrom('marketplace_operation')
    .selectAll()
    .distinctOn('listing_id')
    .where('account_id', '=', tenant.accountId)
    .where('listing_id', 'in', listingIds)
    .where('status', '<>', 'canceled')
    .orderBy('listing_id')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  for (const row of rows) byListing.set(row.listing_id, row);
  return byListing;
}

/**
 * Whether the listing has an operation that may have reached the marketplace: canceled ones and
 * ones Listora refused before sending (`REFUSED_CONTENT_ERROR`) don't count.
 */
export async function hasSentOperations(
  db: DbExecutor,
  tenant: Tenant,
  listingId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('marketplace_operation')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('listing_id', '=', listingId)
    .where('status', '<>', 'canceled')
    .where((eb) =>
      eb.or([
        eb('status', '<>', 'failed'),
        eb('error_code', 'is distinct from', REFUSED_CONTENT_ERROR),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Row-locks the listing until the transaction ends, so two actions on one listing are decided
 * one after the other; then reads it with its connection's mode.
 */
export async function lockListing(
  trx: DbTransaction,
  tenant: Tenant,
  listingId: string,
): Promise<ListingRow | undefined> {
  const locked = await trx
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', listingId)
    .forUpdate()
    .executeTakeFirst();
  return locked === undefined ? undefined : findListing(trx, tenant, locked.id);
}

/** The listing columns of a variant (the contract's `ListingVariant`). */
export function variantColumns(variant: ListingVariant) {
  return {
    title: variant.title,
    description: variant.description,
    price_cents: variant.price.amountCents,
    currency: variant.price.currency,
    category_ref: variant.categoryRef ?? null,
    condition: variant.condition ?? null,
    aspects: jsonb(variant.aspects ?? []),
    hashtags: variant.hashtags ?? [],
  };
}

/** A new `draft` listing: Listora's variant, nothing sent to the marketplace yet. */
export async function insertDraftListing(
  trx: DbTransaction,
  tenant: Tenant,
  input: {
    itemId: string;
    marketplace: Marketplace;
    connectionId: string | null;
    variant: ListingVariant;
  },
): Promise<ListingRow> {
  const { id } = await trx
    .insertInto('marketplace_listing')
    .values({
      account_id: tenant.accountId,
      item_id: input.itemId,
      marketplace: input.marketplace,
      connection_id: input.connectionId,
      status: 'draft',
      ...variantColumns(input.variant),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const row = await findListing(trx, tenant, id);
  if (!row) throw new Error(`listing ${id} vanished inside its own transaction`);
  return row;
}

/**
 * Replaces the listing's variant, Listora's version of it, and counts the change in
 * `desired_version`. On a live listing it is what the queued operation asks for; the
 * marketplace's own state is in `remote_snapshot` until a read-back confirms it.
 */
export async function updateVariant(
  trx: DbTransaction,
  tenant: Tenant,
  listingId: string,
  variant: ListingVariant,
): Promise<ListingRow> {
  await trx
    .updateTable('marketplace_listing')
    .set({ ...variantColumns(variant), desired_version: sql<number>`desired_version + 1` })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', listingId)
    .execute();
  const row = await findListing(trx, tenant, listingId);
  if (!row) throw new Error(`listing ${listingId} vanished inside its own transaction`);
  return row;
}

/** Changes only the variant's price (a price change), counted in `desired_version`. */
export async function updateVariantPrice(
  trx: DbTransaction,
  tenant: Tenant,
  listingId: string,
  priceCents: number,
): Promise<void> {
  await trx
    .updateTable('marketplace_listing')
    .set({ price_cents: priceCents, desired_version: sql<number>`desired_version + 1` })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', listingId)
    .execute();
}

export interface ListingListFilter {
  marketplace: Marketplace | undefined;
  statuses: readonly ListingStatus[] | undefined;
  /** Return only listings older than this one (keyset pagination). */
  beforeId: string | undefined;
  limit: number;
}

/** Newest first, up to `limit + 1` rows so the caller can tell whether another page exists. */
export async function listListingRows(
  db: DbExecutor,
  tenant: Tenant,
  filter: ListingListFilter,
): Promise<ListingRow[]> {
  let query = listingQuery(db, tenant);
  if (filter.marketplace !== undefined) {
    query = query.where('listing.marketplace', '=', filter.marketplace);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    query = query.where('listing.status', 'in', filter.statuses);
  }
  if (filter.beforeId !== undefined) query = query.where('listing.id', '<', filter.beforeId);
  return query
    .orderBy('listing.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
}
