/**
 * Sale queries for the sales feed and the item's "Sold" banner. Like every repository, each
 * function takes the request's `Tenant` and filters on its account.
 */
import type { DelistRunStatus as ContractDelistRunStatus, SaleSort } from '@listora/api-contract';
import type { DbExecutor, DelistRunStatus, Marketplace, SaleStatus } from '@listora/db';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import type { Selectable } from 'kysely';

import type { FeeLineTable, SaleItemTable, SaleTable, UserTaskTable } from '@listora/db';

import { sortedRows, type SortCursor, type SortValue } from '../sorting.ts';
import type { Tenant } from '../tenancy.ts';
import { saleSortTerms } from './sort.ts';

export type SaleRow = Selectable<SaleTable>;
export type SaleItemRow = Selectable<SaleItemTable>;
/** A sale item with what the sale's views show of its inventory item. */
export type SaleItemDetailRow = SaleItemRow & {
  sku: string;
  title: string | null;
  cost_cents: number | null;
  /** The bin the item is kept in, when it is in one. */
  location_id: string | null;
  location_code: string | null;
  location_label: string | null;
};
export type FeeLineRow = Selectable<FeeLineTable>;
export type DoubleSaleTaskRow = Selectable<UserTaskTable>;

/** The contract's run status for the stored one. */
export const CONTRACT_DELIST_RUN_STATUS = {
  in_progress: 'in_progress',
  completed: 'completed',
  attention_needed: 'needs_attention',
} as const satisfies Record<DelistRunStatus, ContractDelistRunStatus>;

const STORED_DELIST_RUN_STATUS = {
  in_progress: 'in_progress',
  completed: 'completed',
  needs_attention: 'attention_needed',
} as const satisfies Record<ContractDelistRunStatus, DelistRunStatus>;

export interface SaleListFilter {
  itemId: string | undefined;
  statuses: readonly SaleStatus[] | undefined;
  /** Sales with a delist run whose stored status (the SLA job's, at most a minute old) is one of these. */
  delistStatuses: readonly ContractDelistRunStatus[] | undefined;
  sort: SaleSort;
  /** Return only sales after this page's last one, in `sort` (keyset pagination). */
  after: SortCursor | undefined;
  limit: number;
}

/** A listed sale with its terms in the feed's order, for the next page's cursor. */
export type SortedSaleRow = SaleRow & { sort_key: SortValue[] };

/**
 * In `sort` (`saleSortTerms`), which ends with the newest sold, then the newest recorded (sale
 * ids are UUIDv7, in the order Listora recorded them), so a sales history recorded at once still
 * lists by when each sold. Returns up to `limit + 1` rows so the caller can tell whether another
 * page exists.
 */
export async function listSaleRows(
  db: DbExecutor,
  tenant: Tenant,
  filter: SaleListFilter,
): Promise<SortedSaleRow[]> {
  let query = db.selectFrom('sale').selectAll().where('account_id', '=', tenant.accountId);
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    query = query.where('status', 'in', filter.statuses);
  }
  if (filter.itemId !== undefined) {
    const itemId = filter.itemId;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('sale_item')
          .select('sale_item.id')
          .where('sale_item.account_id', '=', tenant.accountId)
          .whereRef('sale_item.sale_id', '=', 'sale.id')
          .where('sale_item.item_id', '=', itemId),
      ),
    );
  }
  if (filter.delistStatuses !== undefined && filter.delistStatuses.length > 0) {
    const stored = filter.delistStatuses.map((status) => STORED_DELIST_RUN_STATUS[status]);
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('delist_run')
          .select('delist_run.id')
          .where('delist_run.account_id', '=', tenant.accountId)
          .whereRef('delist_run.sale_id', '=', 'sale.id')
          .where('delist_run.status', 'in', stored),
      ),
    );
  }
  return sortedRows(query, saleSortTerms(filter.sort), filter.after)
    .limit(filter.limit + 1)
    .execute();
}

export async function findSale(
  db: DbExecutor,
  tenant: Tenant,
  saleId: string,
): Promise<SaleRow | undefined> {
  return db
    .selectFrom('sale')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', saleId)
    .executeTakeFirst();
}

/** The sales' items with their SKU, title, cost, and bin, in the order they were recorded, by sale id. */
export async function saleItemRows(
  db: DbExecutor,
  tenant: Tenant,
  saleIds: readonly string[],
): Promise<Map<string, SaleItemDetailRow[]>> {
  const bySale = new Map<string, SaleItemDetailRow[]>();
  if (saleIds.length === 0) return bySale;
  const rows = await db
    .selectFrom('sale_item')
    .innerJoin('inventory_item as item', (join) =>
      join
        .onRef('item.account_id', '=', 'sale_item.account_id')
        .onRef('item.id', '=', 'sale_item.item_id'),
    )
    .leftJoin('storage_location as location', (join) =>
      join
        .onRef('location.account_id', '=', 'item.account_id')
        .onRef('location.id', '=', 'item.storage_location_id'),
    )
    .selectAll('sale_item')
    .select([
      'item.sku',
      'item.title',
      'item.cost_cents',
      'location.id as location_id',
      'location.code as location_code',
      'location.label as location_label',
    ])
    .where('sale_item.account_id', '=', tenant.accountId)
    .where('sale_item.sale_id', 'in', saleIds)
    .orderBy('sale_item.id')
    .execute();
  for (const row of rows) bySale.set(row.sale_id, [...(bySale.get(row.sale_id) ?? []), row]);
  return bySale;
}

/** Double-sale incidents (`resolve_double_sale` tasks), oldest first. */
export async function doubleSaleRows(
  db: DbExecutor,
  tenant: Tenant,
  scope: { saleIds: readonly string[] } | { itemId: string; openOnly: true },
): Promise<DoubleSaleTaskRow[]> {
  let query = db
    .selectFrom('user_task')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('kind', '=', 'resolve_double_sale');
  if ('saleIds' in scope) {
    if (scope.saleIds.length === 0) return [];
    query = query.where('sale_id', 'in', scope.saleIds);
  } else {
    query = query.where('item_id', '=', scope.itemId).where('status', '=', 'open');
  }
  return query.orderBy('created_at').orderBy('id').execute();
}

/** The sales' fee lines, oldest first, keyed by sale id. */
export async function feeLineRows(
  db: DbExecutor,
  tenant: Tenant,
  saleIds: readonly string[],
): Promise<Map<string, FeeLineRow[]>> {
  const bySale = new Map<string, FeeLineRow[]>();
  if (saleIds.length === 0) return bySale;
  const rows = await db
    .selectFrom('fee_line')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('sale_id', 'in', saleIds)
    .orderBy('id')
    .execute();
  for (const row of rows) bySale.set(row.sale_id, [...(bySale.get(row.sale_id) ?? []), row]);
  return bySale;
}

/** The item's newest sale that was canceled or returned and still waits for a relist decision. */
export async function pendingRelistSale(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<SaleRow | undefined> {
  return db
    .selectFrom('sale')
    .innerJoin('sale_item', (join) =>
      join
        .onRef('sale_item.account_id', '=', 'sale.account_id')
        .onRef('sale_item.sale_id', '=', 'sale.id'),
    )
    .selectAll('sale')
    .where('sale.account_id', '=', tenant.accountId)
    .where('sale_item.item_id', '=', itemId)
    .where('sale_item.relist_decision', '=', 'pending')
    .orderBy('sale.id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/** One marketplace's standing sales, all time: orders, items, and revenue. */
export interface MarketplaceSalesRow {
  marketplace: Marketplace;
  salesCount: number;
  itemsSold: number;
  /** The sale prices plus the shipping buyers paid, in cents. */
  revenueCents: number;
  firstSoldAt: Date;
}

/**
 * Every marketplace's standing sales (detected, confirmed, or shipped), all time: one row per
 * marketplace with a sale, in no particular order.
 */
export async function marketplaceSalesRows(
  db: DbExecutor,
  tenant: Tenant,
): Promise<MarketplaceSalesRow[]> {
  const [orders, items] = await Promise.all([
    db
      .selectFrom('sale')
      .select((eb) => [
        'marketplace',
        eb.fn.countAll<string>().as('sales'),
        eb.fn.min('sold_at').as('first_sold_at'),
        eb.fn.sum<string>('shipping_charged_cents').as('shipping'),
      ])
      .where('account_id', '=', tenant.accountId)
      .where('status', 'in', STANDING_SALE_STATUSES)
      .groupBy('marketplace')
      .execute(),
    db
      .selectFrom('sale_item')
      .innerJoin('sale', (join) =>
        join
          .onRef('sale.account_id', '=', 'sale_item.account_id')
          .onRef('sale.id', '=', 'sale_item.sale_id'),
      )
      .select((eb) => [
        'sale.marketplace',
        eb.fn.countAll<string>().as('items'),
        eb.fn.sum<string>('sale_item.sale_price_cents').as('prices'),
      ])
      .where('sale_item.account_id', '=', tenant.accountId)
      .where('sale.status', 'in', STANDING_SALE_STATUSES)
      .groupBy('sale.marketplace')
      .execute(),
  ]);
  const sold = new Map(items.map((row) => [row.marketplace, row]));
  return orders.map((row) => ({
    marketplace: row.marketplace,
    salesCount: Number(row.sales),
    itemsSold: Number(sold.get(row.marketplace)?.items ?? 0),
    revenueCents: Number(sold.get(row.marketplace)?.prices ?? 0) + Number(row.shipping),
    firstSoldAt: row.first_sold_at,
  }));
}

/** The marketplaces the account has a connection to that is not revoked. */
export async function connectedMarketplaces(
  db: DbExecutor,
  tenant: Tenant,
): Promise<Marketplace[]> {
  const rows = await db
    .selectFrom('marketplace_connection')
    .select('marketplace')
    .distinct()
    .where('account_id', '=', tenant.accountId)
    .where('status', '<>', 'revoked')
    .execute();
  return rows.map((row) => row.marketplace);
}
