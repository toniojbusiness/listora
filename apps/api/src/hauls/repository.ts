import type { DbExecutor, DbTransaction, HaulTable, InventoryItem, JsonObject } from '@listora/db';
import { jsonb } from '@listora/db';
import type { Insertable, Selectable } from 'kysely';

import { writeAudit } from '../audit.ts';
import { changedDetails, detailsFromRow } from '../items/details.ts';
import type { Tenant } from '../tenancy.ts';
import { haulShare } from './shares.ts';

export type HaulRow = Selectable<HaulTable>;

/** What the seller enters for a haul. */
export type HaulValues = Pick<
  Insertable<HaulTable>,
  'total_cents' | 'currency' | 'item_count' | 'purchase_date' | 'purchase_source'
>;

export async function findHaul(
  db: DbExecutor,
  tenant: Tenant,
  haulId: string,
): Promise<HaulRow | undefined> {
  return db
    .selectFrom('haul')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', haulId)
    .executeTakeFirst();
}

/**
 * Row-locks these hauls until the transaction ends, in id order, so two requests that change
 * the same hauls (an item moving between them) always take the locks in the same order. Every
 * change to a haul's items takes its haul's lock before any item's.
 */
export async function lockHauls(
  trx: DbTransaction,
  tenant: Tenant,
  haulIds: readonly string[],
): Promise<Map<string, HaulRow>> {
  const locked = new Map<string, HaulRow>();
  for (const haulId of [...new Set(haulIds)].sort()) {
    const row = await trx
      .selectFrom('haul')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', haulId)
      .forUpdate()
      .executeTakeFirst();
    if (row) locked.set(row.id, row);
  }
  return locked;
}

/** A page of hauls, newest first, plus one more row when there is a next page. */
export async function listHaulRows(
  db: DbExecutor,
  tenant: Tenant,
  page: { beforeId: string | undefined; limit: number },
): Promise<HaulRow[]> {
  let query = db
    .selectFrom('haul')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .orderBy('id', 'desc')
    .limit(page.limit + 1);
  if (page.beforeId !== undefined) query = query.where('id', '<', page.beforeId);
  return query.execute();
}

/** How many items each haul has in it, by haul id (a haul with none is absent). */
export async function haulMemberCounts(
  db: DbExecutor,
  tenant: Tenant,
  haulIds: readonly string[],
): Promise<Map<string, number>> {
  if (haulIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('inventory_item')
    .select(['haul_id', db.fn.countAll<string>().as('count')])
    .where('account_id', '=', tenant.accountId)
    .where('haul_id', 'in', haulIds)
    .groupBy('haul_id')
    .execute();
  return new Map(rows.flatMap((row) => (row.haul_id ? [[row.haul_id, Number(row.count)]] : [])));
}

export async function insertHaul(
  trx: DbTransaction,
  tenant: Tenant,
  values: HaulValues,
): Promise<HaulRow> {
  return trx
    .insertInto('haul')
    .values({ account_id: tenant.accountId, ...values })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateHaul(
  trx: DbTransaction,
  tenant: Tenant,
  haulId: string,
  values: HaulValues,
): Promise<void> {
  await trx
    .updateTable('haul')
    .set(values)
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', haulId)
    .execute();
}

/** The items with these ids in this account, row-locked, by id. */
export async function lockItemsById(
  trx: DbTransaction,
  tenant: Tenant,
  itemIds: readonly string[],
): Promise<Map<string, InventoryItem>> {
  if (itemIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', itemIds)
    .orderBy('id')
    .forUpdate()
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Puts the items in the haul, in the given order after the items already in it (each joins a
 * millisecond after the one before, its place for the leftover cents). An item already in this
 * haul keeps its place. Returns where each item that joined was before: its previous haul, or
 * null.
 */
export async function joinHaul(
  trx: DbTransaction,
  tenant: Tenant,
  haulId: string,
  items: readonly InventoryItem[],
  now: Date,
): Promise<Map<string, string | null>> {
  const moved = new Map<string, string | null>();
  let place = 0;
  for (const item of items) {
    if (item.haul_id === haulId) continue;
    await trx
      .updateTable('inventory_item')
      .set({ haul_id: haulId, haul_joined_at: new Date(now.getTime() + place) })
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', item.id)
      .execute();
    moved.set(item.id, item.haul_id);
    place += 1;
  }
  return moved;
}

/** Takes the item out of its haul; it keeps the cost it has. */
export async function leaveHaul(trx: DbTransaction, tenant: Tenant, itemId: string): Promise<void> {
  await trx
    .updateTable('inventory_item')
    .set({ haul_id: null, haul_joined_at: null })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .execute();
}

/**
 * Gives every item in the haul its share, and the haul's date and place when it has them. The
 * haul's count grows to the number of items in it when more joined. An item whose cost, date,
 * and place are already right is not written, so its version stays. Each item written gets a
 * history entry; so does each item in `moved` (it joined this haul), even when its cost did not
 * change. The caller holds the haul's lock. Returns the haul as it is now.
 */
export async function settleHaul(
  trx: DbTransaction,
  tenant: Tenant,
  haulId: string,
  moved: ReadonlyMap<string, string | null> = new Map(),
): Promise<HaulRow> {
  let haul = await findHaul(trx, tenant, haulId);
  if (!haul) throw new Error(`haul ${haulId} vanished while locked`);
  const members = await trx
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('haul_id', '=', haulId)
    .orderBy('haul_joined_at')
    .orderBy('id')
    .execute();
  if (members.length > haul.item_count) {
    haul = await trx
      .updateTable('haul')
      .set({ item_count: members.length })
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', haulId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  for (const [place, row] of members.entries()) {
    const next = {
      cost_cents: haulShare(haul.total_cents, haul.item_count, place),
      currency: haul.currency,
      purchase_date: haul.purchase_date ?? row.purchase_date,
      purchase_source: haul.purchase_source ?? row.purchase_source,
    };
    const joined = moved.has(row.id);
    const membership: JsonObject = joined
      ? { haulId: { ...fromHaul(moved.get(row.id) ?? null), to: haulId } }
      : {};
    const changes = changedDetails(detailsFromRow(row), detailsFromRow({ ...row, ...next }));
    if (Object.keys(changes).length === 0) {
      if (joined) {
        await writeAudit(trx, tenant, {
          itemId: row.id,
          action: 'item.updated',
          changes: membership,
        });
      }
      continue;
    }
    // The seller entered the haul, so its share is the seller's own number.
    const provenance = { ...row.field_provenance };
    for (const key of Object.keys(changes)) provenance[key] = 'user';
    const updated = await trx
      .updateTable('inventory_item')
      .set({ ...next, field_provenance: jsonb(provenance) })
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', row.id)
      .returning('version')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, tenant, {
      itemId: row.id,
      action: 'item.updated',
      changes: { fromVersion: row.version, toVersion: updated.version, ...membership, ...changes },
    });
  }
  return haul;
}

function fromHaul(haulId: string | null): JsonObject {
  return haulId === null ? {} : { from: haulId };
}
