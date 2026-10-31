import type { FieldError } from '@listora/api-contract';
import type { DbTransaction } from '@listora/db';

import { notFound, validationFailed } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';
import {
  insertHaul,
  joinHaul,
  lockHauls,
  lockItemsById,
  settleHaul,
  type HaulRow,
  type HaulValues,
} from './repository.ts';

/**
 * A new haul with these items in it, in order, each costing its share: `createHaul`'s, and a
 * sourcing run's checkout (docs/features/thrift-scan.md). A haul of more items than its count
 * has at least that many. The caller holds a transaction.
 */
export async function createHaulWithItems(
  trx: DbTransaction,
  tenant: Tenant,
  values: HaulValues,
  itemIds: readonly string[],
  field: string,
  now: Date,
): Promise<HaulRow> {
  const haul = await insertHaul(trx, tenant, {
    ...values,
    item_count: Math.max(values.item_count, itemIds.length),
  });
  return addItems(trx, tenant, haul, itemIds, field, now);
}

/**
 * Puts the items in the haul, in order, then settles it and every haul they left. The hauls'
 * locks are taken first (in id order), then the items', the order every haul change uses. An id
 * that is not an item of this account is a field error naming its place in `field`.
 */
export async function addItems(
  trx: DbTransaction,
  tenant: Tenant,
  haul: HaulRow,
  itemIds: readonly string[],
  field: string,
  now: Date,
): Promise<HaulRow> {
  // Where the items are now, to lock the hauls they leave with this one.
  const current =
    itemIds.length === 0
      ? []
      : await trx
          .selectFrom('inventory_item')
          .select('haul_id')
          .where('account_id', '=', tenant.accountId)
          .where('id', 'in', itemIds)
          .execute();
  const locked = await lockHauls(trx, tenant, [
    haul.id,
    ...current.flatMap((row) => (row.haul_id === null ? [] : [row.haul_id])),
  ]);
  if (!locked.has(haul.id)) throw notFound('Haul');
  const items = await lockItemsById(trx, tenant, itemIds);
  const unknown: FieldError[] = itemIds.flatMap((id, index) =>
    items.has(id) ? [] : [{ field: `${field}[${String(index)}]`, message: 'is not an item' }],
  );
  if (unknown.length > 0) throw validationFailed(unknown);
  // An item that moved to another haul between the read and its lock: lock that one too.
  const unlocked = [...items.values()].flatMap((item) =>
    item.haul_id === null || locked.has(item.haul_id) ? [] : [item.haul_id],
  );
  for (const [id, row] of await lockHauls(trx, tenant, unlocked)) locked.set(id, row);

  const ordered = itemIds.map((id) => items.get(id)).filter((item) => item !== undefined);
  const moved = await joinHaul(trx, tenant, haul.id, ordered, now);
  const settled = await settleHaul(trx, tenant, haul.id, moved);
  // The hauls the items left: their remaining items get their new shares.
  const previous = new Set([...moved.values()].filter((id) => id !== null));
  for (const previousId of [...previous].sort()) await settleHaul(trx, tenant, previousId);
  return settled;
}
