/**
 * A new rule's defaults from the seller's own days to sell (docs/features/price-drops.md): how
 * long their sales of the last year took, from the item's first listing before the sale (or,
 * never listed through Listora, from when it was added), as the profit dashboard counts them
 * (docs/features/profit.md). Only sales that stand count.
 */
import type { DbExecutor } from '@listora/db';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import { brandKey } from '@listora/sourcing';
import { sql } from 'kysely';

import { dropDefaults, type DropDefaults } from './rules.ts';

/** Sales from this many days back count. */
export const DAYS_TO_SELL_WINDOW_DAYS = 365;

/** The defaults for a new rule, for a brand when `brand` names one. */
export async function loadDropDefaults(
  db: DbExecutor,
  accountId: string,
  brand?: string | null,
): Promise<DropDefaults> {
  const { rows } = await sql<{ brand: string | null; days: number }>`
    select item.brand,
      greatest(0, extract(epoch from sale.sold_at - coalesce((
        select min(listing.listed_at) from marketplace_listing listing
        where listing.account_id = sale_item.account_id and listing.item_id = sale_item.item_id
          and listing.listed_at <= sale.sold_at
      ), item.created_at)) / 86400)::float8 as days
    from sale
    join sale_item on sale_item.account_id = sale.account_id and sale_item.sale_id = sale.id
    join inventory_item item on item.account_id = sale_item.account_id and item.id = sale_item.item_id
    where sale.account_id = ${accountId}
      and sale.status = any(${[...STANDING_SALE_STATUSES]}::text[])
      and sale.sold_at > now() - make_interval(days => ${DAYS_TO_SELL_WINDOW_DAYS})
  `.execute(db);
  const all = rows.map((row) => row.days);
  const key = brandKey(brand);
  if (brand === undefined || brand === null || key === undefined) return dropDefaults(all);
  const ofBrand = rows.filter((row) => brandKey(row.brand) === key).map((row) => row.days);
  return dropDefaults(all, { name: brand.trim(), days: ofBrand });
}
