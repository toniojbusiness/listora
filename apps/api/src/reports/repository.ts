/**
 * The Reports screen's queries (docs/features/reports.md). Each takes the request's `Tenant`
 * and filters on its account. The year report reads the profit dashboard's own queries
 * (`soldItemRows`, `feeRows`), so both split the same rows; the exports add what a spreadsheet
 * row needs (the SKU, the order number, the haul behind a cost).
 */
import type { DbExecutor, ItemStatus } from '@listora/db';
import type { ProfitItemRow } from '@listora/sales';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import { sql } from 'kysely';

import { periodEnd, periodStart, type ProfitPeriodQuery } from '../profit/repository.ts';
import type { Tenant } from '../tenancy.ts';

/** The haul an item's cost is a share of. */
export interface HaulBasis {
  totalCents: number;
  itemCount: number;
}

/** One sold item of a sale that stands, with what its CSV row shows. */
export interface SalesExportRow extends ProfitItemRow {
  orderNumber: string | null;
  sku: string;
  title: string | null;
  haul: HaulBasis | null;
}

/**
 * One row per item sold in the period on a sale that stands, oldest sale first (then sale and
 * item order, so a bundle's items stay together).
 */
export async function salesExportRows(
  db: DbExecutor,
  tenant: Tenant,
  period: ProfitPeriodQuery,
): Promise<SalesExportRow[]> {
  const rows = await db
    .selectFrom('sale')
    .innerJoin('sale_item', (join) =>
      join
        .onRef('sale_item.account_id', '=', 'sale.account_id')
        .onRef('sale_item.sale_id', '=', 'sale.id'),
    )
    .innerJoin('inventory_item as item', (join) =>
      join
        .onRef('item.account_id', '=', 'sale_item.account_id')
        .onRef('item.id', '=', 'sale_item.item_id'),
    )
    .leftJoin('haul', (join) =>
      join.onRef('haul.account_id', '=', 'item.account_id').onRef('haul.id', '=', 'item.haul_id'),
    )
    .select([
      'sale.id as saleId',
      'sale.marketplace',
      'sale.external_order_id as orderNumber',
      'sale.shipping_charged_cents as shippingChargedCents',
      'sale.shipping_cost_cents as shippingCostCents',
      'sale_item.id as saleItemId',
      'sale_item.sale_price_cents as salePriceCents',
      'item.sku',
      'item.title',
      'item.cost_cents as costCents',
      'item.brand',
      'item.category',
      'haul.total_cents as haulTotalCents',
      'haul.item_count as haulItemCount',
      sql<string>`to_char(sale.sold_at at time zone ${period.timeZone}, 'YYYY-MM-DD')`.as('soldOn'),
    ])
    .where('sale.account_id', '=', tenant.accountId)
    .where('sale.status', 'in', STANDING_SALE_STATUSES)
    .where('sale.sold_at', '>=', periodStart(period))
    .where('sale.sold_at', '<', periodEnd(period))
    .orderBy('sale.sold_at')
    .orderBy('sale.id')
    .orderBy('sale_item.id')
    .execute();
  return rows.map(({ haulTotalCents, haulItemCount, ...row }) => ({
    ...row,
    daysToSell: 0,
    haul: haulBasis(haulTotalCents, haulItemCount),
  }));
}

/** One item the seller has now, with what its CSV row shows. */
export interface InventoryExportRow {
  sku: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  sizeLabel: string | null;
  condition: string | null;
  status: ItemStatus;
  quantity: number;
  /** The day it was added, in the seller's time zone. */
  addedOn: string;
  purchaseDate: string | null;
  purchaseSource: string | null;
  costCents: number | null;
  haul: HaulBasis | null;
  listPriceCents: number | null;
}

/** Every item of the account, by SKU. */
export async function inventoryExportRows(
  db: DbExecutor,
  tenant: Tenant,
  timeZone: string,
): Promise<InventoryExportRow[]> {
  const rows = await db
    .selectFrom('inventory_item as item')
    .leftJoin('haul', (join) =>
      join.onRef('haul.account_id', '=', 'item.account_id').onRef('haul.id', '=', 'item.haul_id'),
    )
    .select([
      'item.sku',
      'item.title',
      'item.brand',
      'item.category',
      'item.size_label as sizeLabel',
      'item.condition',
      'item.status',
      'item.quantity',
      sql<string>`to_char(item.created_at at time zone ${timeZone}, 'YYYY-MM-DD')`.as('addedOn'),
      sql<string | null>`to_char(item.purchase_date, 'YYYY-MM-DD')`.as('purchaseDate'),
      'item.purchase_source as purchaseSource',
      'item.cost_cents as costCents',
      'haul.total_cents as haulTotalCents',
      'haul.item_count as haulItemCount',
      'item.list_price_cents as listPriceCents',
    ])
    .where('item.account_id', '=', tenant.accountId)
    .orderBy('item.sku')
    .execute();
  return rows.map(({ haulTotalCents, haulItemCount, ...row }) => ({
    ...row,
    haul: haulBasis(haulTotalCents, haulItemCount),
  }));
}

function haulBasis(totalCents: number | null, itemCount: number | null): HaulBasis | null {
  return totalCents === null || itemCount === null ? null : { totalCents, itemCount };
}
