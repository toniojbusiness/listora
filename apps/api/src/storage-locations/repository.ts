import type { DbExecutor, DbTransaction, StorageLocationTable } from '@listora/db';
import type { Selectable } from 'kysely';

import type { Tenant } from '../tenancy.ts';

export type StorageLocationRow = Selectable<StorageLocationTable>;

/** An account has at most this many bins, so the list is always one answer. */
export const MAX_LOCATIONS = 1000;
/** The most items a bin's screen lists; `itemCount` counts them all. */
export const MAX_LISTED_ITEMS = 500;

/** Item statuses of things that have left the shelf: a bin no longer holds them. */
export const GONE_STATUSES = ['sold_pending_delist', 'sold', 'shipped'] as const;

/** Every bin of the account, newest first. */
export async function listLocationRows(
  db: DbExecutor,
  tenant: Tenant,
): Promise<StorageLocationRow[]> {
  return db
    .selectFrom('storage_location')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

export async function findLocation(
  db: DbExecutor,
  tenant: Tenant,
  locationId: string,
): Promise<StorageLocationRow | undefined> {
  return db
    .selectFrom('storage_location')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', locationId)
    .executeTakeFirst();
}

/** Row-locks the bin until the transaction ends. */
export async function lockLocation(
  trx: DbTransaction,
  tenant: Tenant,
  locationId: string,
): Promise<StorageLocationRow | undefined> {
  return trx
    .selectFrom('storage_location')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', locationId)
    .forUpdate()
    .executeTakeFirst();
}

/** The id of the account's bin with this code, if any (other than `exceptId`). */
export async function locationWithCode(
  db: DbExecutor,
  tenant: Tenant,
  code: string,
  exceptId?: string,
): Promise<string | undefined> {
  let query = db
    .selectFrom('storage_location')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where((eb) => eb(eb.fn('upper', ['code']), '=', code));
  if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
  return (await query.executeTakeFirst())?.id;
}

export async function countLocations(db: DbExecutor, tenant: Tenant): Promise<number> {
  const row = await db
    .selectFrom('storage_location')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('account_id', '=', tenant.accountId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function insertLocation(
  trx: DbTransaction,
  tenant: Tenant,
  values: { code: string; label: string | null },
): Promise<StorageLocationRow> {
  return trx
    .insertInto('storage_location')
    .values({ account_id: tenant.accountId, code: values.code, label: values.label })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateLocation(
  trx: DbTransaction,
  tenant: Tenant,
  locationId: string,
  values: { code: string; label: string | null },
): Promise<StorageLocationRow> {
  return trx
    .updateTable('storage_location')
    .set({ code: values.code, label: values.label })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', locationId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Deletes the bin; its items' `storage_location_id` is cleared by the foreign key. */
export async function deleteLocation(
  trx: DbTransaction,
  tenant: Tenant,
  locationId: string,
): Promise<StorageLocationRow | undefined> {
  return trx
    .deleteFrom('storage_location')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', locationId)
    .returningAll()
    .executeTakeFirst();
}

/** How many items each bin holds that have not sold. */
export async function locationItemCounts(
  db: DbExecutor,
  tenant: Tenant,
  locationIds: readonly string[],
): Promise<Map<string, number>> {
  if (locationIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('inventory_item')
    .select(['storage_location_id', (eb) => eb.fn.countAll<string>().as('count')])
    .where('account_id', '=', tenant.accountId)
    .where('storage_location_id', 'in', locationIds)
    .where('status', 'not in', GONE_STATUSES)
    .groupBy('storage_location_id')
    .execute();
  return new Map(
    rows.flatMap((row) =>
      row.storage_location_id === null ? [] : [[row.storage_location_id, Number(row.count)]],
    ),
  );
}

export interface LocationItemRow {
  id: string;
  sku: string;
  title: string | null;
  status: string;
}

/** The bin's items that have not sold, newest first, at most `MAX_LISTED_ITEMS`. */
export async function locationItemRows(
  db: DbExecutor,
  tenant: Tenant,
  locationId: string,
): Promise<LocationItemRow[]> {
  return db
    .selectFrom('inventory_item')
    .select(['id', 'sku', 'title', 'status'])
    .where('account_id', '=', tenant.accountId)
    .where('storage_location_id', '=', locationId)
    .where('status', 'not in', GONE_STATUSES)
    .orderBy('id', 'desc')
    .limit(MAX_LISTED_ITEMS)
    .execute();
}

export interface MovedItem {
  id: string;
  from: string | null;
}

/**
 * Row-locks these items (in id order, as every item write does) and returns the ones of this
 * account with the bin each is in now.
 */
export async function lockItemsForMove(
  trx: DbTransaction,
  tenant: Tenant,
  itemIds: readonly string[],
): Promise<Map<string, MovedItem>> {
  const locked = new Map<string, MovedItem>();
  for (const itemId of [...new Set(itemIds)].sort()) {
    const row = await trx
      .selectFrom('inventory_item')
      .select(['id', 'storage_location_id'])
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', itemId)
      .forUpdate()
      .executeTakeFirst();
    if (row) locked.set(row.id, { id: row.id, from: row.storage_location_id });
  }
  return locked;
}

/** Puts the items in the bin (or in none). */
export async function setItemsLocation(
  trx: DbTransaction,
  tenant: Tenant,
  itemIds: readonly string[],
  locationId: string | null,
): Promise<void> {
  if (itemIds.length === 0) return;
  await trx
    .updateTable('inventory_item')
    .set({ storage_location_id: locationId })
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', itemIds)
    .execute();
}

/** The codes of these bins, by id. */
export async function locationCodes(
  db: DbExecutor,
  tenant: Tenant,
  locationIds: readonly string[],
): Promise<Map<string, string>> {
  if (locationIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('storage_location')
    .select(['id', 'code'])
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', locationIds)
    .execute();
  return new Map(rows.map((row) => [row.id, row.code]));
}
