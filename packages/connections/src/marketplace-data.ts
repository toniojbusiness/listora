/**
 * Removing a marketplace's data from an account when the owner unlinks it
 * (docs/features/privacy.md, Unlinking a marketplace), so nothing about that marketplace shows
 * anywhere in Listora until it is linked again, and a relink imports fresh, as a first link does:
 *
 * - its listings, and their links on items; the operations on them are settled without asking
 *   the marketplace and kept for the owner only, on `deleted_listing` rows marked `unlinked`;
 * - the items only its import brought in (listing imports and the sales history's sold items)
 *   that are on no other marketplace, sold on none, and in no haul, kept as `deleted_item`
 *   history the same way; their photos' stored objects go with the deletion's job;
 * - its sales, with their fees, delist runs, Pack check labels and packages (the package photos'
 *   objects with the job); a delist one of them started on another marketplace stays (the item
 *   did sell) without its run;
 * - its tasks (assisted steps, reconnects, sale emails' questions, double sales), its
 *   marketplace events and sale emails, and the item history that names it.
 *
 * Items the owner made in Listora, and items listed or sold elsewhere, stay, without that
 * marketplace's listing: one no longer listed anywhere is `ready` again, one whose sale's delist
 * runs went with the sale is `sold`. Its offers, sale checks, imports, and read health go with
 * the connection itself (`deleteConnectionData`). Another marketplace's data is never touched,
 * nor the account's Read only settings.
 */
import {
  syncItemListedStatus,
  keepUnlinkedOperations,
  settleUnlinkedOperations,
} from '@listora/operations';
import type { DbTransaction, Marketplace } from '@listora/db';
import { sql } from 'kysely';

/** What `deleteMarketplaceData` removed. */
export interface DeletedMarketplaceData {
  /** Listings on the marketplace, now history only. */
  listings: number;
  /** Their operations that were still unfinished (canceled, or failed as unconfirmed). */
  settledOperations: number;
  /** Items only the marketplace's import brought in. */
  items: number;
  sales: number;
  tasks: number;
  /** Marketplace events and sale emails. */
  inboundEvents: number;
  /** The stored objects the deleted rows named (item photos, package photos). */
  objectKeys: string[];
}

/**
 * Removes the marketplace's data from the account, on the caller's transaction, which holds the
 * marketplace connection's row lock (the order every writer of a connection's rows keeps,
 * docs/features/privacy.md#unlinking-while-work-runs). Changes nothing on the marketplace.
 */
export async function deleteMarketplaceData(
  trx: DbTransaction,
  target: { accountId: string; marketplace: Marketplace },
): Promise<DeletedMarketplaceData> {
  const { accountId, marketplace } = target;
  const settledOperations = await settleUnlinkedOperations(trx, target);

  const importedItems = await trx
    .selectFrom('inventory_item as item')
    .select(['item.id'])
    .where('item.account_id', '=', accountId)
    .where('item.haul_id', 'is', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('audit_log as audit')
          .select('audit.id')
          .where('audit.account_id', '=', accountId)
          .whereRef('audit.item_id', '=', 'item.id')
          .where('audit.action', '=', 'item.imported')
          .where(sql<string>`audit.changes ->> 'marketplace'`, '=', marketplace),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('marketplace_listing as other')
            .select('other.id')
            .where('other.account_id', '=', accountId)
            .whereRef('other.item_id', '=', 'item.id')
            .where('other.marketplace', '<>', marketplace),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('sale_item as sold')
            .select('sold.id')
            .where('sold.account_id', '=', accountId)
            .whereRef('sold.item_id', '=', 'item.id')
            .where('sold.marketplace', '<>', marketplace),
        ),
      ),
    )
    .orderBy('item.id')
    .forUpdate()
    .execute();
  const itemIds = importedItems.map((row) => row.id);
  const removed = new Set(itemIds);

  // The items that stay but lose a listing or a sale, whose status then follows what is left.
  const touched = await trx
    .selectFrom('marketplace_listing')
    .select('item_id')
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace)
    .union(
      trx
        .selectFrom('sale_item')
        .select('item_id')
        .where('account_id', '=', accountId)
        .where('marketplace', '=', marketplace),
    )
    .execute();
  const staying = [...new Set(touched.map((row) => row.item_id))]
    .filter((id) => !removed.has(id))
    .sort();

  const sales = await trx
    .selectFrom('sale')
    .select('id')
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace)
    .execute();
  const saleIds = sales.map((row) => row.id);
  const packagePhotos =
    saleIds.length === 0
      ? []
      : await trx
          .selectFrom('sale_pack')
          .select('photo_key')
          .where('account_id', '=', accountId)
          .where('sale_id', 'in', saleIds)
          .where('photo_key', 'is not', null)
          .execute();
  if (saleIds.length > 0) {
    // With their items, fees, delist runs (a delist they started elsewhere loses only its run),
    // labels, packages, and tasks.
    await trx
      .deleteFrom('sale')
      .where('account_id', '=', accountId)
      .where('id', 'in', saleIds)
      .execute();
  }

  // Tasks about the marketplace that name it rather than one of its rows (a reconnect, a sale
  // email's question, a double sale with an earlier sale there); the rest go with their rows.
  const tasks = await trx
    .deleteFrom('user_task')
    .where('account_id', '=', accountId)
    .where((eb) =>
      eb.or([
        eb(sql<string>`payload ->> 'marketplace'`, '=', marketplace),
        eb(sql<string>`payload ->> 'earlierMarketplace'`, '=', marketplace),
      ]),
    )
    .executeTakeFirst();

  const events = await trx
    .deleteFrom('inbound_event')
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace)
    .executeTakeFirst();

  // The history of items that stay, where it names the marketplace or one of its sales. The
  // append-only table lets this one delete through (migration 20261030002319).
  await sql`select set_config('listora.unlink_delete', 'audit_log', true)`.execute(trx);
  await trx
    .deleteFrom('audit_log')
    .where('account_id', '=', accountId)
    .where('item_id', 'is not', null)
    .where((eb) =>
      eb.or([
        eb(sql<string>`changes ->> 'marketplace'`, '=', marketplace),
        eb(sql<string>`changes ->> 'earlierMarketplace'`, '=', marketplace),
        ...(saleIds.length === 0 ? [] : [eb(sql<string>`changes ->> 'saleId'`, 'in', saleIds)]),
      ]),
    )
    .execute();
  await sql`select set_config('listora.unlink_delete', '', true)`.execute(trx);

  // What Listora did on the marketplace stays for the owner: what the listings (and the items
  // that go) were, with their operations moved onto those records.
  if (itemIds.length > 0) {
    await trx
      .insertInto('deleted_item')
      .columns(['id', 'account_id', 'sku', 'title', 'reason'])
      .expression(
        trx
          .selectFrom('inventory_item')
          .select(['id', 'account_id', 'sku', 'title', sql<'unlinked'>`'unlinked'`.as('reason')])
          .where('account_id', '=', accountId)
          .where('id', 'in', itemIds),
      )
      .execute();
  }
  await trx
    .insertInto('deleted_listing')
    .columns([
      'id',
      'account_id',
      'item_id',
      'marketplace',
      'status',
      'external_listing_id',
      'reason',
    ])
    .expression(
      trx
        .selectFrom('marketplace_listing')
        .select([
          'id',
          'account_id',
          'item_id',
          'marketplace',
          'status',
          'external_listing_id',
          sql<'unlinked'>`'unlinked'`.as('reason'),
        ])
        .where('account_id', '=', accountId)
        .where('marketplace', '=', marketplace),
    )
    .execute();
  await keepUnlinkedOperations(trx, target);
  const listings = await trx
    .deleteFrom('marketplace_listing')
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace)
    .executeTakeFirst();

  const photos =
    itemIds.length === 0
      ? []
      : await trx
          .selectFrom('photo')
          .select(['storage_key', 'derivatives'])
          .where('account_id', '=', accountId)
          .where('item_id', 'in', itemIds)
          .execute();
  if (itemIds.length > 0) {
    // With their photos, analyses, tasks, and history.
    await trx
      .deleteFrom('inventory_item')
      .where('account_id', '=', accountId)
      .where('id', 'in', itemIds)
      .execute();
  }

  for (const itemId of staying) await syncItemListedStatus(trx, accountId, itemId);
  if (staying.length > 0) {
    // A sold item whose delist runs went with the sale is done delisting.
    await trx
      .updateTable('inventory_item as item')
      .set({ status: 'sold' })
      .where('item.account_id', '=', accountId)
      .where('item.id', 'in', staying)
      .where('item.status', '=', 'sold_pending_delist')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('delist_run as run')
              .select('run.id')
              .where('run.account_id', '=', accountId)
              .whereRef('run.item_id', '=', 'item.id')
              .where('run.status', '<>', 'completed'),
          ),
        ),
      )
      .execute();
  }

  return {
    listings: Number(listings.numDeletedRows),
    settledOperations,
    items: itemIds.length,
    sales: saleIds.length,
    tasks: Number(tasks.numDeletedRows),
    inboundEvents: Number(events.numDeletedRows),
    objectKeys: [
      ...photos.flatMap((photo) => [photo.storage_key, ...derivativeKeys(photo.derivatives)]),
      ...packagePhotos.flatMap((pack) => (pack.photo_key === null ? [] : [pack.photo_key])),
    ],
  };
}

/** The storage keys of a photo's derived images (`{ <kind>: { key, ... } }`). */
function derivativeKeys(derivatives: Record<string, unknown>): string[] {
  return Object.values(derivatives).flatMap((derivative) => {
    if (typeof derivative !== 'object' || derivative === null) return [];
    const key = (derivative as Record<string, unknown>)['key'];
    return typeof key === 'string' ? [key] : [];
  });
}
