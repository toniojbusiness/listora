/**
 * Double sales: an item that had already sold (in an order that was not canceled or returned)
 * sells again. Listora cannot undo a sale, so it opens an incident for the seller: an urgent
 * `resolve_double_sale` task on the later sale with that marketplace's steps to cancel the
 * order (`orderCancelGuide`), and a push. The later sale starts no delist of its own: the
 * earlier sale's run already delists everything else.
 */
import { jsonb, type DbTransaction, type Marketplace } from '@listora/db';
import { orderCancelGuide, orderCancelTitle } from '@listora/marketplaces';
import { enqueuePush } from '@listora/push';

import { doubleSaleNotification } from './messages.ts';

export interface EarlierSale {
  saleId: string;
  marketplace: Marketplace;
}

/** The item's earliest other sale that still stands (not canceled or returned), if any. */
export async function findEarlierSale(
  trx: DbTransaction,
  input: { accountId: string; itemId: string; saleId: string },
): Promise<EarlierSale | undefined> {
  const row = await trx
    .selectFrom('sale_item')
    .innerJoin('sale', (join) =>
      join
        .onRef('sale.account_id', '=', 'sale_item.account_id')
        .onRef('sale.id', '=', 'sale_item.sale_id'),
    )
    .select(['sale.id', 'sale.marketplace'])
    .where('sale_item.account_id', '=', input.accountId)
    .where('sale_item.item_id', '=', input.itemId)
    .where('sale.id', '<>', input.saleId)
    .where('sale.status', 'not in', ['canceled', 'returned'])
    .orderBy('sale.created_at')
    .orderBy('sale.id')
    .executeTakeFirst();
  return row === undefined ? undefined : { saleId: row.id, marketplace: row.marketplace };
}

/**
 * Opens the double-sale incident for one item of the later sale, once: recording the sale
 * again finds the open task and changes nothing. Returns the task's id.
 */
export async function openDoubleSale(
  trx: DbTransaction,
  input: {
    accountId: string;
    saleId: string;
    marketplace: Marketplace;
    itemId: string;
    /** The item's listing on the later sale's marketplace, when known. */
    listingId: string | null;
    earlier: EarlierSale;
    label: string;
  },
): Promise<{ taskId: string; opened: boolean }> {
  const guide = orderCancelGuide(input.marketplace);
  const inserted = await trx
    .insertInto('user_task')
    .values({
      account_id: input.accountId,
      kind: 'resolve_double_sale',
      item_id: input.itemId,
      listing_id: input.listingId,
      sale_id: input.saleId,
      urgency: 'urgent',
      deep_link: guide.url,
      payload: jsonb({
        title: orderCancelTitle(input.marketplace),
        marketplace: input.marketplace,
        earlierSaleId: input.earlier.saleId,
        earlierMarketplace: input.earlier.marketplace,
        steps: [...guide.steps],
      }),
    })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'sale_id', 'item_id'])
        .where('kind', '=', 'resolve_double_sale')
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (inserted === undefined) {
    const existing = await trx
      .selectFrom('user_task')
      .select('id')
      .where('account_id', '=', input.accountId)
      .where('sale_id', '=', input.saleId)
      .where('item_id', '=', input.itemId)
      .where('kind', '=', 'resolve_double_sale')
      .executeTakeFirstOrThrow();
    return { taskId: existing.id, opened: false };
  }

  await trx
    .insertInto('audit_log')
    .values({
      account_id: input.accountId,
      item_id: input.itemId,
      actor_kind: 'marketplace',
      action: 'item.double_sale',
      changes: jsonb({
        saleId: input.saleId,
        marketplace: input.marketplace,
        earlierSaleId: input.earlier.saleId,
        earlierMarketplace: input.earlier.marketplace,
      }),
    })
    .execute();
  await enqueuePush(
    trx,
    doubleSaleNotification({
      accountId: input.accountId,
      itemId: input.itemId,
      saleId: input.saleId,
      label: input.label,
      soldOn: input.marketplace,
      earlierSoldOn: input.earlier.marketplace,
      taskId: inserted.id,
    }),
    { key: `double_sale:${inserted.id}` },
  );
  return { taskId: inserted.id, opened: true };
}
