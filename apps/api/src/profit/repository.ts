/**
 * The profit dashboard's queries (docs/features/profit.md). Each takes the request's `Tenant`
 * and filters on its account. A period is a range of days in the seller's time zone, turned
 * into instants by Postgres (`<day>::timestamp at time zone <zone>`), so the range scan uses
 * `sale_sold_at_idx` on (account_id, sold_at).
 */
import type { DbExecutor, ItemStatus } from '@listora/db';
import type { ProfitFeeRow, ProfitItemRow, ProfitPeriodDays } from '@listora/sales';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import { sql, type RawBuilder } from 'kysely';

import type { Tenant } from '../tenancy.ts';

export interface ProfitPeriodQuery extends ProfitPeriodDays {
  /** An IANA time zone the caller checked. */
  timeZone: string;
}

/** Items that are for sale or being prepared: what dead stock counts. */
const ACTIVE_ITEM_STATUSES = ['draft', 'ready', 'listed'] as const satisfies readonly ItemStatus[];

export function periodStart(period: ProfitPeriodQuery): RawBuilder<Date> {
  return sql<Date>`(${period.from}::date)::timestamp at time zone ${period.timeZone}`;
}

export function periodEnd(period: ProfitPeriodQuery): RawBuilder<Date> {
  return sql<Date>`(${period.to}::date + 1)::timestamp at time zone ${period.timeZone}`;
}

/**
 * One row per item sold in the period on a sale that stands, in sale then item order. The days
 * to sell run from the item's first listing before the sale or, never listed through Listora,
 * from when it was added.
 */
export async function soldItemRows(
  db: DbExecutor,
  tenant: Tenant,
  period: ProfitPeriodQuery,
): Promise<ProfitItemRow[]> {
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
    .select((eb) => [
      'sale.id as saleId',
      'sale.marketplace',
      'sale.shipping_charged_cents as shippingChargedCents',
      'sale.shipping_cost_cents as shippingCostCents',
      'sale_item.id as saleItemId',
      'sale_item.sale_price_cents as salePriceCents',
      'item.cost_cents as costCents',
      'item.brand',
      'item.category',
      sql<string>`to_char(sale.sold_at at time zone ${period.timeZone}, 'YYYY-MM-DD')`.as('soldOn'),
      sql<number>`greatest(0, extract(epoch from sale.sold_at - coalesce(${eb
        .selectFrom('marketplace_listing as listing')
        .select((inner) => inner.fn.min('listing.listed_at').as('first'))
        .whereRef('listing.account_id', '=', 'sale_item.account_id')
        .whereRef('listing.item_id', '=', 'sale_item.item_id')
        .whereRef(
          'listing.listed_at',
          '<=',
          'sale.sold_at',
        )}, item.created_at)) / 86400)::float8`.as('daysToSell'),
    ])
    .where('sale.account_id', '=', tenant.accountId)
    .where('sale.status', 'in', STANDING_SALE_STATUSES)
    .where('sale.sold_at', '>=', periodStart(period))
    .where('sale.sold_at', '<', periodEnd(period))
    .orderBy('sale.id')
    .orderBy('sale_item.id')
    .execute();
  return rows;
}

/** The period's fee lines summed per sale, item (null for the order), and label or not. */
export async function feeRows(
  db: DbExecutor,
  tenant: Tenant,
  period: ProfitPeriodQuery,
): Promise<ProfitFeeRow[]> {
  return db
    .selectFrom('fee_line as fee')
    .innerJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'fee.account_id').onRef('sale.id', '=', 'fee.sale_id'),
    )
    .select([
      'fee.sale_id as saleId',
      'fee.sale_item_id as saleItemId',
      sql<boolean>`fee.kind = 'shipping_label'`.as('shippingLabel'),
      sql<number>`sum(fee.amount_cents)::bigint`.as('amountCents'),
      sql<boolean>`bool_or(fee.source = 'estimated')`.as('estimated'),
    ])
    .where('fee.account_id', '=', tenant.accountId)
    .where('sale.status', 'in', STANDING_SALE_STATUSES)
    .where('sale.sold_at', '>=', periodStart(period))
    .where('sale.sold_at', '<', periodEnd(period))
    .groupBy(['fee.sale_id', 'fee.sale_item_id', sql`fee.kind = 'shipping_label'`])
    .execute();
}

/** Items listed now that were added by the period's end (sell-through's unsold side). */
export async function listedItemCount(
  db: DbExecutor,
  tenant: Tenant,
  period: ProfitPeriodQuery,
): Promise<number> {
  const row = await db
    .selectFrom('inventory_item')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('account_id', '=', tenant.accountId)
    .where('status', '=', 'listed')
    .where('created_at', '<', periodEnd(period))
    .executeTakeFirstOrThrow();
  return row.count;
}

export interface DeadStockTotals {
  itemCount: number;
  costCents: number;
  missingCostCount: number;
}

export interface DeadStockItemRow {
  id: string;
  sku: string;
  title: string | null;
  status: ItemStatus;
  costCents: number | null;
  ageDays: number;
}

export interface DeadStockRows {
  over60Days: DeadStockTotals;
  over90Days: DeadStockTotals;
  /** Up to `limit` items over 60 days, oldest first. */
  oldest: DeadStockItemRow[];
}

/**
 * Active items by their age on `today` (a day in `timeZone`): whole days since the purchase
 * date or, without one, since the item was added.
 */
export async function deadStockRows(
  db: DbExecutor,
  tenant: Tenant,
  options: { today: string; timeZone: string; limit: number },
): Promise<DeadStockRows> {
  const aged = db
    .selectFrom('inventory_item')
    .select([
      'id',
      'sku',
      'title',
      'status',
      'cost_cents as costCents',
      sql<number>`${options.today}::date - coalesce(purchase_date, (created_at at time zone ${options.timeZone})::date)`.as(
        'ageDays',
      ),
    ])
    .where('account_id', '=', tenant.accountId)
    .where('status', 'in', ACTIVE_ITEM_STATUSES);

  const [totals, oldest] = await Promise.all([
    db
      .selectFrom(aged.as('aged'))
      .select([
        sql<number>`count(*) filter (where "ageDays" > 60)`.as('over60Count'),
        sql<number>`coalesce(sum("costCents") filter (where "ageDays" > 60), 0)::bigint`.as(
          'over60Cost',
        ),
        sql<number>`count(*) filter (where "ageDays" > 60 and "costCents" is null)`.as(
          'over60WithoutCost',
        ),
        sql<number>`count(*) filter (where "ageDays" > 90)`.as('over90Count'),
        sql<number>`coalesce(sum("costCents") filter (where "ageDays" > 90), 0)::bigint`.as(
          'over90Cost',
        ),
        sql<number>`count(*) filter (where "ageDays" > 90 and "costCents" is null)`.as(
          'over90WithoutCost',
        ),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom(aged.as('aged'))
      .selectAll()
      .where('ageDays', '>', 60)
      .orderBy('ageDays', 'desc')
      .orderBy('sku')
      .limit(options.limit)
      .execute(),
  ]);
  return {
    over60Days: {
      itemCount: totals.over60Count,
      costCents: totals.over60Cost,
      missingCostCount: totals.over60WithoutCost,
    },
    over90Days: {
      itemCount: totals.over90Count,
      costCents: totals.over90Cost,
      missingCostCount: totals.over90WithoutCost,
    },
    oldest,
  };
}
