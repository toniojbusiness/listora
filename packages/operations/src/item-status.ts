/**
 * An item's status follows its listings (the contract's `KnownItemStatus`): a `draft` or `ready`
 * item becomes `listed` once one of its listings is confirmed active, by a read-back or the
 * user, and a `listed` item is `ready` again once none is active and none shows it sold.
 * Statuses a sale decides (`sold_pending_delist`, `sold`, `shipped`) and `archived` are never
 * changed here: a listing that sold leaves the item to the sale intake.
 */
import type { DbTransaction } from '@listora/db';

export async function syncItemListedStatus(
  trx: DbTransaction,
  accountId: string,
  itemId: string,
): Promise<void> {
  const listings = await trx
    .selectFrom('marketplace_listing')
    .select('status')
    .where('account_id', '=', accountId)
    .where('item_id', '=', itemId)
    .where('status', 'in', ['active', 'sold'])
    .execute();
  const active = listings.find((listing) => listing.status === 'active');
  if (active === undefined && listings.length > 0) return;
  await trx
    .updateTable('inventory_item')
    .set({ status: active === undefined ? 'ready' : 'listed' })
    .where('account_id', '=', accountId)
    .where('id', '=', itemId)
    .where('status', 'in', active === undefined ? ['listed'] : ['draft', 'ready'])
    .execute();
}
