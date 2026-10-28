/**
 * The delist fan-out after a sale (docs/features/auto-delist.md). It runs in the transaction
 * that records the sale (`recordSale` in `@listora/sales`, the one entry point for every sale
 * source), so a recorded sale always has its delists and a rolled-back one has none. For each
 * item the order sold:
 *
 * 1. **Item lock.** The sold items are locked (`for no key update`, in id order), so two sales of
 *    one item that arrive at once are taken one after the other: the second finds the first.
 *    The lock does not conflict with the key-share lock each sale's `sale_item` row already
 *    holds on the item, so two such sales never deadlock.
 * 2. **Double sale.** An item that already sold in an order that still stands gets a double-sale
 *    incident instead of a second fan-out (double-sale.ts).
 * 3. **Run.** Otherwise the item gets its `delist_run` and the status `sold_pending_delist`.
 * 4. **Moot work.** On each of the item's listings, operations the sale made moot are canceled
 *    (`cancelMootOperations`): edits waiting to run or retry, and publishes that never reached
 *    the marketplace, so a sold item is never published again.
 * 5. **Delists.** Every listing on another marketplace that may be live gets a high-priority
 *    delist operation (`origin = 'auto_delist'`): `mark_sold` where the marketplace marks a sale
 *    elsewhere through its API (Depop), otherwise `end`. The engine runs each in the listing's
 *    mode: API listings are ended and read back; assisted ones become an urgent user task. A
 *    listing that cannot be live (ended or sold, or a draft never sent, with nothing in flight)
 *    needs no delist, and neither does one on a read-only connection
 *    (docs/features/read-only.md): Listora never changes that account, so it gets no task either.
 *    A sale on a read-only account delists nothing anywhere: its items are never listed elsewhere.
 * 6. **Push.** One time-sensitive notification says what Listora delists and what the seller
 *    has to. A run with nothing to delist is completed at once and the item is `sold`.
 *
 * Every step is idempotent: running the fan-out for the same sale again changes nothing.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type DbExecutor,
  type DbTransaction,
  type ItemStatus,
  type Marketplace,
  type SaleDetectionSource,
} from '@listora/db';
import { operationMode, type AdapterLookup, type OperationMode } from '@listora/marketplaces';
import {
  cancelMootOperations,
  enqueueOperation,
  isReadOnlyMarketplace,
  listingIsReadOnly,
  UNFINISHED_STATUSES,
} from '@listora/operations';
import { enqueuePush } from '@listora/push';

import { findEarlierSale, openDoubleSale } from './double-sale.ts';
import { itemLabel, soldNotification } from './messages.ts';

export interface AutoDelistDependencies {
  /** The adapters the worker runs with: which kind of delist each listing gets, and its mode. */
  adapters: AdapterLookup;
}

export interface SoldItem {
  itemId: string;
  /** The listing the item sold through, on the sale's marketplace, when known. */
  listingId: string | null;
}

export interface SaleToDelist {
  accountId: string;
  saleId: string;
  /** The marketplace the order is on. */
  marketplace: Marketplace;
  detectionSource: SaleDetectionSource;
  items: readonly SoldItem[];
}

export type ItemDelistStart =
  | { type: 'delist_started'; itemId: string; delistRunId: string; delists: number }
  /** The fan-out ran for this sale and item before. */
  | { type: 'already_started'; itemId: string; delistRunId: string }
  | { type: 'double_sale'; itemId: string; earlierSaleId: string; taskId: string };

/** In the caller's transaction (or its own): see the module comment. */
export async function startAutoDelist(
  executor: DbExecutor,
  sale: SaleToDelist,
  deps: AutoDelistDependencies,
): Promise<ItemDelistStart[]> {
  return inTransaction(executor, async (trx) => {
    const itemIds = [...new Set(sale.items.map((item) => item.itemId))];
    if (itemIds.length === 0) return [];
    const items = await trx
      .selectFrom('inventory_item')
      .select(['id', 'sku', 'title', 'status'])
      .where('account_id', '=', sale.accountId)
      .where('id', 'in', itemIds)
      .orderBy('id')
      .forNoKeyUpdate()
      .execute();
    const byId = new Map(items.map((item) => [item.id, item]));

    const starts: ItemDelistStart[] = [];
    for (const sold of sale.items) {
      const item = byId.get(sold.itemId);
      if (item === undefined) throw new Error(`sale ${sale.saleId} sold an unknown item`);
      starts.push(await startItem(trx, sale, sold, item, deps));
    }
    return starts;
  });
}

interface LockedItem {
  id: string;
  sku: string;
  title: string | null;
  status: ItemStatus;
}

async function startItem(
  trx: DbTransaction,
  sale: SaleToDelist,
  sold: SoldItem,
  item: LockedItem,
  deps: AutoDelistDependencies,
): Promise<ItemDelistStart> {
  const { accountId } = sale;
  const existing = await trx
    .selectFrom('delist_run')
    .select('id')
    .where('account_id', '=', accountId)
    .where('sale_id', '=', sale.saleId)
    .where('item_id', '=', item.id)
    .executeTakeFirst();
  if (existing !== undefined) {
    return { type: 'already_started', itemId: item.id, delistRunId: existing.id };
  }

  const label = itemLabel(item);
  const earlier = await findEarlierSale(trx, {
    accountId,
    itemId: item.id,
    saleId: sale.saleId,
  });
  if (earlier !== undefined) {
    const { taskId } = await openDoubleSale(trx, {
      accountId,
      saleId: sale.saleId,
      marketplace: sale.marketplace,
      itemId: item.id,
      listingId: sold.listingId,
      earlier,
      label,
    });
    return { type: 'double_sale', itemId: item.id, earlierSaleId: earlier.saleId, taskId };
  }

  const run = await trx
    .insertInto('delist_run')
    .values({ account_id: accountId, sale_id: sale.saleId, item_id: item.id })
    .returning('id')
    .executeTakeFirstOrThrow();

  const prepared = await prepareTargets(trx, {
    accountId,
    itemId: item.id,
    saleId: sale.saleId,
    soldOn: sale.marketplace,
    adapters: deps.adapters,
  });
  // A sale on a read-only account (docs/features/read-only.md) changes nothing on the account's
  // other marketplaces either: an item from that account is never listed on them.
  const targets = (await isReadOnlyMarketplace(trx, { accountId, marketplace: sale.marketplace }))
    ? []
    : prepared;
  for (const target of targets) {
    await enqueueOperation(trx, {
      accountId,
      listingId: target.listingId,
      kind: target.kind,
      desired: { status: target.kind === 'mark_sold' ? 'sold' : 'ended' },
      idempotencyKey: `auto_delist:${run.id}:${target.listingId}`,
      origin: 'auto_delist',
      delistRunId: run.id,
    });
  }

  // Nothing else may be live: the run is done now, and the item is simply sold.
  const nextStatus = targets.length === 0 ? 'sold' : 'sold_pending_delist';
  if (targets.length === 0) {
    await trx
      .updateTable('delist_run')
      .set({ status: 'completed', completed_at: sql<Date>`now()` })
      .where('account_id', '=', accountId)
      .where('id', '=', run.id)
      .execute();
  }
  await trx
    .updateTable('inventory_item')
    .set({ status: nextStatus, pre_archive_status: null })
    .where('account_id', '=', accountId)
    .where('id', '=', item.id)
    .execute();
  await trx
    .insertInto('audit_log')
    .values({
      account_id: accountId,
      item_id: item.id,
      actor_kind: sale.detectionSource === 'manual' ? 'user' : 'marketplace',
      action: 'item.sold',
      changes: jsonb({
        saleId: sale.saleId,
        marketplace: sale.marketplace,
        delistRunId: run.id,
        status: { from: item.status, to: nextStatus },
        delists: targets.map((target) => ({
          listingId: target.listingId,
          marketplace: target.marketplace,
          kind: target.kind,
        })),
      }),
    })
    .execute();

  if (targets.length > 0) {
    const automated = (target: DelistTarget): boolean =>
      target.mode === 'api' || target.mode === 'automation';
    const byListora = targets.filter((target) => automated(target) && !target.onPhone);
    const onPhone = targets.filter((target) => target.onPhone);
    const bySeller = targets.filter((target) => !automated(target));
    await enqueuePush(
      trx,
      soldNotification(
        {
          accountId,
          itemId: item.id,
          saleId: sale.saleId,
          delistRunId: run.id,
          label,
          soldOn: sale.marketplace,
        },
        {
          listora: byListora.map((target) => target.marketplace),
          phone: onPhone.map((target) => target.marketplace),
          seller: bySeller.map((target) => target.marketplace),
        },
      ),
      { key: `item_sold:${run.id}` },
    );
  }
  return { type: 'delist_started', itemId: item.id, delistRunId: run.id, delists: targets.length };
}

interface DelistTarget {
  listingId: string;
  marketplace: Marketplace;
  kind: 'end' | 'mark_sold';
  /** How the engine will run it today: `api` and `automation` are Listora's, the rest the seller's. */
  mode: OperationMode;
  /** An automated delist that runs on the seller's iPhone (docs/features/phone-execution.md). */
  onPhone: boolean;
}

/**
 * Cancels the moot operations on every listing of the item, then returns the listings on other
 * marketplaces that may be live, with the delist each gets.
 */
async function prepareTargets(
  trx: DbTransaction,
  input: {
    accountId: string;
    itemId: string;
    saleId: string;
    soldOn: Marketplace;
    adapters: AdapterLookup;
  },
): Promise<DelistTarget[]> {
  const listings = await trx
    .selectFrom('marketplace_listing as listing')
    .leftJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'listing.account_id')
        .onRef('connection.id', '=', 'listing.connection_id'),
    )
    .select([
      'listing.id',
      'listing.marketplace',
      'listing.status',
      'listing.external_listing_id',
      'listing.pending_external_listing_id',
      'connection.id as connection_id',
      'connection.mode as connection_mode',
      'connection.status as connection_status',
      'connection.runs_on as connection_runs_on',
      listingIsReadOnly('listing').as('read_only'),
    ])
    .where('listing.account_id', '=', input.accountId)
    .where('listing.item_id', '=', input.itemId)
    .orderBy('listing.marketplace')
    .orderBy('listing.id')
    .execute();

  const targets: DelistTarget[] = [];
  for (const listing of listings) {
    await cancelMootOperations(trx, {
      accountId: input.accountId,
      listingId: listing.id,
      reason: 'the item sold',
      detail: { saleId: input.saleId },
    });
    if (listing.marketplace === input.soldOn) continue;
    // Listora never changes an account the seller made read only (docs/features/read-only.md),
    // so it gets no delist, no task, and no word in the notification; the seller delists there.
    if (listing.read_only) continue;

    const unfinished = await trx
      .selectFrom('marketplace_operation')
      .select('id')
      .where('account_id', '=', input.accountId)
      .where('listing_id', '=', listing.id)
      .where('status', 'in', UNFINISHED_STATUSES)
      .limit(1)
      .executeTakeFirst();
    if (!mayBeLive(listing, unfinished !== undefined)) continue;

    const adapter = input.adapters(listing.marketplace);
    const connection =
      listing.connection_id === null ||
      listing.connection_mode === null ||
      listing.connection_status === null
        ? null
        : {
            id: listing.connection_id,
            mode: listing.connection_mode,
            status: listing.connection_status,
          };
    const capabilities = adapter?.capabilities(connection);
    // A sale elsewhere is marked sold where the marketplace's API has that (Depop); every
    // other listing is ended.
    const kind =
      capabilities !== undefined && operationMode(capabilities, 'mark_sold') === 'api'
        ? 'mark_sold'
        : 'end';
    const mode = capabilities === undefined ? 'unsupported' : operationMode(capabilities, kind);
    targets.push({
      listingId: listing.id,
      marketplace: listing.marketplace,
      kind,
      mode,
      onPhone: mode === 'automation' && listing.connection_runs_on === 'phone',
    });
  }
  return targets;
}

/**
 * Whether a listing may be on sale. Only two kinds of listing certainly are not: an ended or
 * sold one without a newer listing id that may have gone live (a relist whose read-back failed
 * leaves one), and a draft that was never sent anywhere; in both cases with nothing in flight
 * that could still put it on the marketplace.
 */
function mayBeLive(
  listing: {
    status: string;
    external_listing_id: string | null;
    pending_external_listing_id: string | null;
  },
  hasUnfinishedOperation: boolean,
): boolean {
  if (hasUnfinishedOperation) return true;
  if (listing.status === 'ended' || listing.status === 'sold') {
    return listing.pending_external_listing_id !== null;
  }
  if (listing.status === 'draft') {
    return listing.external_listing_id !== null || listing.pending_external_listing_id !== null;
  }
  return true;
}
