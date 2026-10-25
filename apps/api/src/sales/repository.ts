/**
 * Sale queries for the sales feed and the item's "Sold" banner. Like every repository, each
 * function takes the request's `Tenant` and filters on its account.
 */
import type { DelistRunStatus as ContractDelistRunStatus } from '@listora/api-contract';
import type { DbExecutor, DelistRunStatus, SaleStatus } from '@listora/db';
import type { Selectable } from 'kysely';

import type { SaleItemTable, SaleTable, UserTaskTable } from '@listora/db';

import type { Tenant } from '../tenancy.ts';

export type SaleRow = Selectable<SaleTable>;
export type SaleItemRow = Selectable<SaleItemTable>;
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
  /** Return only sales recorded before this one (keyset pagination). */
  beforeId: string | undefined;
  limit: number;
}

/**
 * Newest first. Sale ids are UUIDv7, so id order is the order Listora recorded them in. Returns
 * up to `limit + 1` rows so the caller can tell whether another page exists.
 */
export async function listSaleRows(
  db: DbExecutor,
  tenant: Tenant,
  filter: SaleListFilter,
): Promise<SaleRow[]> {
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
  if (filter.beforeId !== undefined) query = query.where('id', '<', filter.beforeId);
  return query
    .orderBy('id', 'desc')
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

/** The sales' items, in the order they were recorded, keyed by sale id. */
export async function saleItemRows(
  db: DbExecutor,
  tenant: Tenant,
  saleIds: readonly string[],
): Promise<Map<string, SaleItemRow[]>> {
  const bySale = new Map<string, SaleItemRow[]>();
  if (saleIds.length === 0) return bySale;
  const rows = await db
    .selectFrom('sale_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('sale_id', 'in', saleIds)
    .orderBy('id')
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

/** The item's line in a sale. */
export async function findSaleItem(
  db: DbExecutor,
  tenant: Tenant,
  saleId: string,
  itemId: string,
): Promise<SaleItemRow | undefined> {
  return db
    .selectFrom('sale_item')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('sale_id', '=', saleId)
    .where('item_id', '=', itemId)
    .executeTakeFirst();
}
