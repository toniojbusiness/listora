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
  type PreArchiveItemStatus,
} from '@listora/db';
import { sql } from 'kysely';

import type { Tenant } from '../tenancy.ts';
import type { DetailColumns, FieldProvenance } from './details.ts';
import type { PhotoRow } from '../photos/mapping.ts';

/** Listing statuses that are not live on a marketplace (contract: `deleteItem`). */
export const NOT_LIVE_LISTING_STATUSES = [
  'draft',
  'ended',
] as const satisfies readonly ListingStatus[];

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
  if (filter.beforeId !== undefined) query = query.where('id', '<', filter.beforeId);
  return query
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
}

/** Each listed item's cover photo (its first), keyed by item id. */
export async function coverPhotoRows(
  db: DbExecutor,
  tenant: Tenant,
  itemIds: readonly string[],
): Promise<Map<string, PhotoRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('photo')
    .selectAll()
    .distinctOn('item_id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', 'in', itemIds)
    .orderBy('item_id')
    .orderBy('position')
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

/** Whether any of the item's listings is live (anything but `draft` or `ended`). */
export async function hasLiveListing(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('status', 'not in', NOT_LIVE_LISTING_STATUSES)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
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
 * Deletes the item with its draft and ended listings; photos, analyses, and its audit history
 * go with it (foreign-key cascades). Marketplace history that must be kept (operations, sales)
 * makes the database refuse, which the caller reports as a conflict.
 */
export async function deleteItem(
  trx: DbTransaction,
  tenant: Tenant,
  itemId: string,
): Promise<void> {
  await trx
    .deleteFrom('marketplace_listing')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('status', 'in', NOT_LIVE_LISTING_STATUSES)
    .execute();
  await trx
    .deleteFrom('inventory_item')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .execute();
}
