import type { DbExecutor, InventoryItem } from '@listora/db';

import type { Tenant } from '../tenancy.ts';

/** The items with these ids, by id. */
export async function itemRowsById(
  db: DbExecutor,
  tenant: Tenant,
  itemIds: readonly string[],
): Promise<Map<string, InventoryItem>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('inventory_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', itemIds)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}
