/**
 * The orders of `listSales` (the contract's `SaleSort`, docs/features/sorting.md): each one's
 * terms over `sale`, ending with the newest sold, then the newest recorded, so ties keep one
 * order.
 */
import type { SaleSort } from '@listora/api-contract';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import { assertNever } from '@listora/shared';
import { sql } from 'kysely';

import { epochMicroseconds, type SortTerm } from '../sorting.ts';

export const DEFAULT_SALE_SORT = 'sold_newest' satisfies SaleSort;

const SOLD_AT = epochMicroseconds(sql`sale.sold_at`);

/** Sale ids are UUIDv7, in the order Listora recorded them. */
const NEWEST: SortTerm[] = [
  { value: SOLD_AT, direction: 'desc', type: 'bigint' },
  { value: sql`sale.id`, direction: 'desc', type: 'uuid' },
];

/** The order's sale price, as `Sale.salePrice` adds it up. */
const SALE_PRICE = sql`(
  select coalesce(sum(item.sale_price_cents), 0) from sale_item as item
  where item.account_id = sale.account_id and item.sale_id = sale.id
)::bigint`;

/**
 * Whether the sale has a profit, as `saleMoney` in @listora/sales gives one: it still stands, its
 * fees are known (estimated or reported), and so is the cost of every item in it.
 */
const HAS_PROFIT = sql`(
  sale.status in (${sql.join(STANDING_SALE_STATUSES)})
  and exists (
    select 1 from fee_line as fee where fee.account_id = sale.account_id and fee.sale_id = sale.id
  )
  and not exists (
    select 1 from sale_item as item
    join inventory_item on inventory_item.account_id = item.account_id
      and inventory_item.id = item.item_id
    where item.account_id = sale.account_id and item.sale_id = sale.id
      and inventory_item.cost_cents is null
  )
)`;

/** The order's profit (`saleMoney`'s): what it brought in, less fees, shipping, and cost. */
const PROFIT = sql`(
  ${SALE_PRICE} + sale.shipping_charged_cents - coalesce(sale.shipping_cost_cents, 0)
  - (
    select coalesce(sum(fee.amount_cents), 0) from fee_line as fee
    where fee.account_id = sale.account_id and fee.sale_id = sale.id
  )
  - (
    select coalesce(sum(inventory_item.cost_cents), 0) from sale_item as item
    join inventory_item on inventory_item.account_id = item.account_id
      and inventory_item.id = item.item_id
    where item.account_id = sale.account_id and item.sale_id = sale.id
  )
)::bigint`;

/** The terms of `sort`, in order. */
export function saleSortTerms(sort: SaleSort): SortTerm[] {
  switch (sort) {
    case 'sold_newest':
      return NEWEST;
    case 'sold_oldest':
      return [
        { value: SOLD_AT, direction: 'asc', type: 'bigint' },
        { value: sql`sale.id`, direction: 'desc', type: 'uuid' },
      ];
    case 'price_high':
    case 'price_low':
      return [
        { value: SALE_PRICE, direction: sort === 'price_high' ? 'desc' : 'asc', type: 'bigint' },
        ...NEWEST,
      ];
    case 'profit_high':
      return [
        { value: sql`(not ${HAS_PROFIT})`, direction: 'asc', type: 'boolean' },
        {
          value: sql`(case when ${HAS_PROFIT} then ${PROFIT} else 0 end)`,
          direction: 'desc',
          type: 'bigint',
        },
        ...NEWEST,
      ];
    default:
      return assertNever(sort);
  }
}
