import type { Insertable, Selectable } from 'kysely';

import { inTransaction, type DbExecutor } from './database.ts';
import type { InventoryItemTable } from './schema.ts';
import { allocateSku } from './sku.ts';

export type InventoryItem = Selectable<InventoryItemTable>;
/** Item fields a caller provides; the account comes from the tenant and the SKU is allocated. */
export type NewInventoryItem = Omit<Insertable<InventoryItemTable>, 'account_id' | 'sku'>;

/**
 * Creates an item with the account's next SKU in one transaction (the caller's, when
 * `executor` is a transaction). If the insert fails, the SKU number is not used up.
 */
export async function createInventoryItem(
  executor: DbExecutor,
  accountId: string,
  item: NewInventoryItem = {},
): Promise<InventoryItem> {
  return inTransaction(executor, async (trx) => {
    const sku = await allocateSku(trx, accountId);
    return trx
      .insertInto('inventory_item')
      .values({ ...item, account_id: accountId, sku })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
