/**
 * The household's own sales for sourcing (docs/features/thrift-scan.md): the sold items that
 * count, and the items still in inventory. Every function takes the request's `Tenant` and
 * filters on its account.
 */
import { knownMarketplaceValues, type KnownMarketplace } from '@listora/api-contract';
import type { DbExecutor } from '@listora/db';
import { marketplacesWith, type FeatureGate } from '@listora/marketplaces';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import { OWN_HISTORY_WINDOW_DAYS, type OwnSale, type UnsoldItem } from '@listora/sourcing';

import type { Tenant } from '../tenancy.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The marketplaces whose sales are real for the account: those whose sales history is on for
 * it (it passed live, or the account is in Test mode), so a sale an unproven read recorded is
 * never shown as the seller's sales.
 */
export function ownSalesMarketplaces(gate: FeatureGate): KnownMarketplace[] {
  return marketplacesWith('sales_history', knownMarketplaceValues, gate);
}

/**
 * Every item the account sold that counts as its own history: in a sale that stands (not
 * canceled or returned), sold in the last `OWN_HISTORY_WINDOW_DAYS`, on one of `marketplaces`,
 * of an item with a brand. A bundle's items each count, at what the buyer paid for each.
 */
export async function ownSales(
  db: DbExecutor,
  tenant: Tenant,
  marketplaces: readonly KnownMarketplace[],
  now: Date,
): Promise<OwnSale[]> {
  if (marketplaces.length === 0) return [];
  const rows = await db
    .selectFrom('sale')
    .innerJoin('sale_item', (join) =>
      join
        .onRef('sale_item.account_id', '=', 'sale.account_id')
        .onRef('sale_item.sale_id', '=', 'sale.id'),
    )
    .innerJoin('inventory_item', (join) =>
      join
        .onRef('inventory_item.account_id', '=', 'sale_item.account_id')
        .onRef('inventory_item.id', '=', 'sale_item.item_id'),
    )
    .where('sale.account_id', '=', tenant.accountId)
    .where('sale.status', 'in', STANDING_SALE_STATUSES)
    .where('sale.sold_at', '>=', new Date(now.getTime() - OWN_HISTORY_WINDOW_DAYS * DAY_MS))
    .where('sale.marketplace', 'in', marketplaces)
    .where('inventory_item.brand', 'is not', null)
    .select([
      'sale_item.id',
      'sale_item.item_id',
      'sale.marketplace',
      'inventory_item.brand',
      'inventory_item.category',
      'inventory_item.size_label',
      'sale_item.sale_price_cents',
      'sale.sold_at',
      // The item's first listing through Listora before the sale: one whose create succeeded.
      // An imported listing's `listed_at` is when Listora read it, so it never counts.
      (eb) =>
        eb
          .selectFrom('marketplace_listing as listing')
          .select((inner) => inner.fn.min('listing.listed_at').as('first'))
          .whereRef('listing.account_id', '=', 'sale_item.account_id')
          .whereRef('listing.item_id', '=', 'sale_item.item_id')
          .whereRef('listing.listed_at', '<=', 'sale.sold_at')
          .where((inner) =>
            inner.exists(
              inner
                .selectFrom('marketplace_operation as operation')
                .select('operation.id')
                .whereRef('operation.account_id', '=', 'listing.account_id')
                .whereRef('operation.listing_id', '=', 'listing.id')
                .where('operation.kind', '=', 'create')
                .where('operation.status', '=', 'succeeded'),
            ),
          )
          .as('listed_at'),
    ])
    .orderBy('sale.sold_at')
    .orderBy('sale_item.id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    marketplace: row.marketplace,
    brand: row.brand,
    category: row.category,
    sizeLabel: row.size_label,
    salePriceCents: row.sale_price_cents,
    soldAt: row.sold_at,
    listedAt: row.listed_at,
  }));
}

/**
 * The account's items with a brand in inventory and not sold: ready, or listed somewhere, each
 * with when it was added.
 */
export async function unsoldItems(db: DbExecutor, tenant: Tenant): Promise<UnsoldItem[]> {
  const rows = await db
    .selectFrom('inventory_item')
    .select(['brand', 'category', 'size_label', 'created_at'])
    .where('account_id', '=', tenant.accountId)
    .where('status', 'in', ['ready', 'listed'])
    .where('brand', 'is not', null)
    .execute();
  return rows.map((row) => ({
    brand: row.brand,
    category: row.category,
    sizeLabel: row.size_label,
    addedAt: row.created_at,
  }));
}
