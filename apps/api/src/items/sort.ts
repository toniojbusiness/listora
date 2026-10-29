/**
 * The orders of `listItems` (the contract's `ItemSort`, docs/features/sorting.md): each one's
 * terms over `inventory_item`, ending with the newest added first so ties keep one order.
 */
import type { ItemSort } from '@listora/api-contract';
import { assertNever } from '@listora/shared';
import { sql, type RawBuilder } from 'kysely';

import { epochMicroseconds, type SortTerm } from '../sorting.ts';

export const DEFAULT_ITEM_SORT = 'added_newest' satisfies ItemSort;

/** Item ids are UUIDv7, so id order is the order they were added. */
const NEWEST_ADDED: SortTerm = { value: sql`inventory_item.id`, direction: 'desc', type: 'uuid' };

/** When the item was first listed on any marketplace; null if it never was. */
const FIRST_LISTED_AT = sql`(
  select min(listing.listed_at) from marketplace_listing as listing
  where listing.account_id = inventory_item.account_id and listing.item_id = inventory_item.id
)`;

/** Still for sale: what the profit dashboard counts as stock (docs/features/profit.md). */
const FOR_SALE = sql`inventory_item.status in ('draft', 'ready', 'listed')`;

/** A nullable value's terms: rows without one last, then the value in `direction`. */
function nullsLast(
  value: RawBuilder<unknown>,
  direction: SortTerm['direction'],
  type: 'bigint' | 'text',
  empty: number | string,
): SortTerm[] {
  return [
    { value: sql`(${value} is null)`, direction: 'asc', type: 'boolean' },
    { value: sql`coalesce(${value}, ${sql.lit(empty)})`, direction, type },
  ];
}

/** The terms of `sort`, in order. */
export function itemSortTerms(sort: ItemSort): SortTerm[] {
  switch (sort) {
    case 'added_newest':
      return [NEWEST_ADDED];
    case 'listed_newest':
    case 'listed_oldest':
      return [
        ...nullsLast(
          epochMicroseconds(FIRST_LISTED_AT),
          sort === 'listed_newest' ? 'desc' : 'asc',
          'bigint',
          0,
        ),
        NEWEST_ADDED,
      ];
    case 'price_high':
    case 'price_low':
      return [
        ...nullsLast(
          sql`inventory_item.list_price_cents`,
          sort === 'price_high' ? 'desc' : 'asc',
          'bigint',
          0,
        ),
        NEWEST_ADDED,
      ];
    case 'stale_first':
      // Aged like the dashboard's dead stock: from the purchase date, else from when it was added.
      return [
        { value: sql`(not (${FOR_SALE}))`, direction: 'asc', type: 'boolean' },
        {
          value: epochMicroseconds(
            sql`coalesce(inventory_item.purchase_date::timestamp at time zone 'UTC', inventory_item.created_at)`,
          ),
          direction: 'asc',
          type: 'bigint',
        },
        NEWEST_ADDED,
      ];
    case 'profit_high':
      return [
        ...nullsLast(
          sql`(inventory_item.list_price_cents - inventory_item.cost_cents)`,
          'desc',
          'bigint',
          0,
        ),
        NEWEST_ADDED,
      ];
    case 'name_az':
      return [
        ...nullsLast(sql`lower(nullif(btrim(inventory_item.title), ''))`, 'asc', 'text', ''),
        NEWEST_ADDED,
      ];
    default:
      return assertNever(sort);
  }
}
