/**
 * Inventory item queries. Every function takes the request's `Tenant` and filters on its
 * account, so an item of another account is indistinguishable from one that does not exist.
 */
import type { ItemStatus } from '@listora/api-contract';
import {
  createInventoryItem,
  jsonb,
  type DbExecutor,
  type DbTransaction,
  type InventoryItem,
  type JsonObject,
  type ListingStatus,
  type Marketplace,
  type OperationStatus,
  type PreArchiveItemStatus,
} from '@listora/db';
import { cancelOperation, keepDeletedItemOperations } from '@listora/operations';
import { sql } from 'kysely';

import type { Tenant } from '../tenancy.ts';
import type { DetailColumns, FieldProvenance } from './details.ts';
import type { PhotoRow } from '../photos/mapping.ts';

/**
 * Listing statuses that are not live on a marketplace (contract: `deleteItem`): never posted,
 * or already off it (ended, or sold and so no longer for sale).
 */
export const NOT_LIVE_LISTING_STATUSES = [
  'draft',
  'ended',
  'sold',
] as const satisfies readonly ListingStatus[];

/** Operation statuses whose work may still reach the marketplace. */
const IN_FLIGHT_OPERATION_STATUSES = [
  'queued',
  'running',
  'retrying',
  'verifying',
] as const satisfies readonly OperationStatus[];

export async function findItem(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<InventoryItem | undefined> {
  return db
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .executeTakeFirst();
}

/**
 * Reads and row-locks the item until the transaction ends, so concurrent changes to the item
 * and its photos are applied one after another.
 */
export async function lockItem(
  trx: DbTransaction,
  tenant: Tenant,
  itemId: string,
): Promise<InventoryItem | undefined> {
  return trx
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .forUpdate()
    .executeTakeFirst();
}

export async function findItemBySku(
  db: DbExecutor,
  tenant: Tenant,
  sku: string,
): Promise<InventoryItem | undefined> {
  return db
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('sku', '=', sku)
    .executeTakeFirst();
}

export interface ItemListFilter {
  statuses: readonly ItemStatus[] | undefined;
  search: string | undefined;
  /** Only items with a listing on it that is not ended or sold. */
  marketplace: Marketplace | undefined;
  /** Only items of this brand, ignoring case. */
  brand: string | undefined;
  /**
   * Only items that need the seller: a listing whose newest operation that was not canceled
   * failed or waits for the seller (`needs_user_action`).
   */
  attention?: boolean | undefined;
  /** Return only items older than this one (keyset pagination). */
  beforeId: string | undefined;
  limit: number;
}

/**
 * Newest first. Item ids are UUIDv7, so id order is creation order and a page boundary is a
 * single id. Returns up to `limit + 1` rows so the caller can tell whether another page exists.
 */
export async function listItemRows(
  db: DbExecutor,
  tenant: Tenant,
  filter: ItemListFilter,
): Promise<InventoryItem[]> {
  let query = db
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId);
  if (filter.statuses && filter.statuses.length > 0) {
    query = query.where('status', 'in', filter.statuses);
  }
  if (filter.search !== undefined && filter.search !== '') {
    const pattern = `%${filter.search.replace(/[\\%_]/g, '\\$&')}%`;
    query = query.where((eb) =>
      eb.or([
        eb('sku', 'ilike', pattern),
        eb('title', 'ilike', pattern),
        eb('brand', 'ilike', pattern),
        sql<boolean>`exists (select 1 from unnest(${eb.ref('keywords')}) as keyword where keyword ilike ${pattern})`,
      ]),
    );
  }
  if (filter.brand !== undefined && filter.brand !== '') {
    query = query.where(sql<string>`lower(brand)`, '=', filter.brand.toLowerCase());
  }
  const { marketplace } = filter;
  if (marketplace !== undefined) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('marketplace_listing as listing')
          .select('listing.id')
          .whereRef('listing.account_id', '=', 'inventory_item.account_id')
          .whereRef('listing.item_id', '=', 'inventory_item.id')
          .where('listing.marketplace', '=', marketplace)
          .where('listing.status', 'not in', ['ended', 'sold']),
      ),
    );
  }
  if (filter.attention === true) {
    // The same newest operation the listing's status speaks for (`latestOperations`).
    query = query.where(
      sql<boolean>`exists (
        select 1 from marketplace_listing as listing
        cross join lateral (
          select operation.status from marketplace_operation as operation
          where operation.account_id = listing.account_id
            and operation.listing_id = listing.id
            and operation.status <> 'canceled'
          order by operation.created_at desc, operation.id desc
          limit 1
        ) as latest
        where listing.account_id = inventory_item.account_id
          and listing.item_id = inventory_item.id
          and latest.status in ('failed', 'needs_user_action')
      )`,
    );
  }
  if (filter.beforeId !== undefined) query = query.where('id', '<', filter.beforeId);
  return query
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
}

/**
 * Each listed item's cover photo (its first), keyed by item id. Positions are gapless from 0
 * (photos/repository.ts), so the cover is the row at position 0: one index lookup per item
 * instead of reading and sorting all of its photos.
 */
export async function coverPhotoRows(
  db: DbExecutor,
  tenant: Tenant,
  itemIds: readonly string[],
): Promise<Map<string, PhotoRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('photo')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('item_id', 'in', itemIds)
    .where('position', '=', 0)
    .execute();
  return new Map(rows.map((row) => [row.item_id, row]));
}

export async function storageLocationSummary(
  db: DbExecutor,
  tenant: Tenant,
  locationId: string,
): Promise<{ id: string; code: string; label: string | null } | undefined> {
  return db
    .selectFrom('storage_location')
    .select(['id', 'code', 'label'])
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', locationId)
    .executeTakeFirst();
}

export async function analysisBelongsToItem(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  analysisId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('ai_analysis')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('id', '=', analysisId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Creates a draft with the account's next SKU, in the caller's transaction. */
export async function insertItem(
  trx: DbTransaction,
  tenant: Tenant,
  columns: DetailColumns,
  provenance: FieldProvenance,
): Promise<InventoryItem> {
  const { measurements, ...rest } = columns;
  return createInventoryItem(trx, tenant.accountId, {
    ...rest,
    measurements: jsonb(measurements),
    field_provenance: jsonb(provenance as JsonObject),
  });
}

/**
 * Replaces the item's details and status if it is still at `expectedVersion`. Returns the
 * updated row, or undefined when the version no longer matches.
 */
export async function updateItem(
  trx: DbTransaction,
  tenant: Tenant,
  itemId: string,
  expectedVersion: number,
  changes: {
    columns: DetailColumns;
    status: ItemStatus;
    preArchiveStatus: PreArchiveItemStatus | null;
    provenance: FieldProvenance;
  },
): Promise<InventoryItem | undefined> {
  const { measurements, ...rest } = changes.columns;
  return trx
    .updateTable('inventory_item')
    .set({
      ...rest,
      status: changes.status,
      pre_archive_status: changes.preArchiveStatus,
      measurements: jsonb(measurements),
      field_provenance: jsonb(changes.provenance as JsonObject),
    })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
}

/** The marketplaces where one of the item's listings may be live (`NOT_LIVE_LISTING_STATUSES`). */
export async function liveListingMarketplaces(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<Marketplace[]> {
  const rows = await db
    .selectFrom('marketplace_listing')
    .select('marketplace')
    .distinct()
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('status', 'not in', NOT_LIVE_LISTING_STATUSES)
    .orderBy('marketplace')
    .execute();
  return rows.map((row) => row.marketplace);
}

/** Whether any of the item's listings may be live (`NOT_LIVE_LISTING_STATUSES`). */
export async function hasLiveListing(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<boolean> {
  return (await liveListingMarketplaces(db, tenant, itemId)).length > 0;
}

/** The marketplaces where a change to one of the item's listings is still in flight. */
export async function inFlightOperationMarketplaces(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<Marketplace[]> {
  const rows = await db
    .selectFrom('marketplace_operation as operation')
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'operation.account_id')
        .onRef('listing.id', '=', 'operation.listing_id'),
    )
    .select('listing.marketplace')
    .distinct()
    .where('operation.account_id', '=', tenant.accountId)
    .where('listing.item_id', '=', itemId)
    .where('operation.status', 'in', IN_FLIGHT_OPERATION_STATUSES)
    .orderBy('listing.marketplace')
    .execute();
  return rows.map((row) => row.marketplace);
}

/** Whether the item was sold in any marketplace order (whatever became of the order). */
export async function hasSale(db: DbExecutor, tenant: Tenant, itemId: string): Promise<boolean> {
  const row = await db
    .selectFrom('sale_item')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Deletes the item with every listing of it, keeping the history of what was done on the
 * marketplaces (docs/features/items.md, Deleting an item): what the item and each listing were go
 * to `deleted_item` and `deleted_listing`, and each listing's operations move onto its
 * `deleted_listing` row, with their events, browser sessions, and phone work. An operation still
 * waiting for the seller is canceled first, since its task goes with the listing. Photos,
 * analyses, tasks, and the item's own audit history go with the item (foreign-key cascades).
 * Nothing changes on a marketplace: a listing still up there stays up, no longer tracked. The
 * caller first refuses an item with a sale, whose records are kept, or with a change in flight.
 */
export async function deleteItem(
  trx: DbTransaction,
  tenant: Tenant,
  item: Pick<InventoryItem, 'id' | 'sku' | 'title'>,
): Promise<void> {
  const listings = trx
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', item.id);
  const waiting = await trx
    .selectFrom('marketplace_operation')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('listing_id', 'in', listings)
    .where('status', '=', 'needs_user_action')
    .execute();
  for (const { id } of waiting) {
    await cancelOperation(trx, {
      accountId: tenant.accountId,
      operationId: id,
      reason: 'item_deleted',
    });
  }
  await trx
    .insertInto('deleted_item')
    .values({ id: item.id, account_id: tenant.accountId, sku: item.sku, title: item.title })
    .execute();
  await trx
    .insertInto('deleted_listing')
    .columns(['id', 'account_id', 'item_id', 'marketplace', 'status', 'external_listing_id'])
    .expression(
      trx
        .selectFrom('marketplace_listing')
        .select(['id', 'account_id', 'item_id', 'marketplace', 'status', 'external_listing_id'])
        .where('account_id', '=', tenant.accountId)
        .where('item_id', '=', item.id),
    )
    .execute();
  await keepDeletedItemOperations(trx, { accountId: tenant.accountId, itemId: item.id });
  await trx
    .deleteFrom('marketplace_listing')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', item.id)
    .execute();
  await trx
    .deleteFrom('inventory_item')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', item.id)
    .execute();
}
