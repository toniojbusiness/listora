/**
 * The Today summary for one account: a handful of plain, indexed queries over the tables that
 * already hold the truth, turned into cards by the rules in cards.ts. No AI and no marketplace
 * call, so the app can ask for it every time it opens.
 */
import { loadDelistRuns } from '@listora/auto-delist';
import { saleMoney } from '@listora/sales';
import type { DbExecutor, Marketplace } from '@listora/db';
import type { CurrencyCode } from '@listora/shared';
import { sql } from 'kysely';

import {
  delistCard,
  orderCards,
  reconnectCard,
  reviewDraftsCard,
  shipCard,
  staleListingCard,
  TODAY_RULES,
  type ConnectionFact,
  type DraftsFact,
  type ListedFact,
  type ShipFact,
  type TodayCard,
  type TodayItemRef,
} from './cards.ts';
import { moneySummary, type MoneySummary, type SaleMoneyFact } from './money.ts';

/** Cards of one kind read at most; a seller with more sees the most urgent ones. */
export const MAX_CARDS_PER_KIND = 50;

const DAY_MS = 24 * 60 * 60_000;

export interface TodaySummary {
  generatedAt: Date;
  /** Most urgent first (`orderCards`). */
  cards: TodayCard[];
  money: MoneySummary;
}

export async function loadToday(
  executor: DbExecutor,
  accountId: string,
  now: Date,
): Promise<TodaySummary> {
  const [ship, delist, connections, listed, drafts, sales] = await Promise.all([
    shipFacts(executor, accountId),
    delistCards(executor, accountId),
    connectionFacts(executor, accountId),
    staleCandidates(executor, accountId, now),
    draftsFact(executor, accountId),
    saleMoneyFacts(executor, accountId, now),
  ]);
  const cards: TodayCard[] = [
    ...delist,
    ...ship.map((fact) => shipCard(fact, now)),
    ...connections.map(reconnectCard),
    ...[reviewDraftsCard(drafts)].filter((card) => card !== null),
    ...listed
      .map((fact) => staleListingCard(fact, now))
      .filter((card) => card !== null)
      .slice(0, TODAY_RULES.maxStaleCards),
  ];
  return { generatedAt: now, cards: orderCards(cards), money: moneySummary(sales, now) };
}

/** Items sold in a sale that still stands, not shipped yet: soonest ship-by first. */
async function shipFacts(executor: DbExecutor, accountId: string): Promise<ShipFact[]> {
  const rows = await executor
    .selectFrom('sale_item')
    .innerJoin('sale', (join) =>
      join
        .onRef('sale.account_id', '=', 'sale_item.account_id')
        .onRef('sale.id', '=', 'sale_item.sale_id'),
    )
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
    .select([
      'sale.id as sale_id',
      'sale_item.id as sale_item_id',
      'sale.marketplace',
      'sale.sold_at',
      'sale.ship_by',
      'item.id as item_id',
      'item.sku',
      'item.title',
      'location.code as location_code',
      'location.label as location_label',
    ])
    .where('sale_item.account_id', '=', accountId)
    .where('sale.status', 'in', ['detected', 'confirmed'])
    // A sale from before the marketplace was connected (its sales history) is not one to ship.
    .where('sale.detection_source', '<>', 'history')
    .where('item.status', 'in', ['sold_pending_delist', 'sold'])
    .orderBy(sql`sale.ship_by asc nulls last`)
    .orderBy('sale.sold_at')
    .orderBy('sale_item.id')
    .limit(MAX_CARDS_PER_KIND)
    .execute();
  return rows.map((row) => ({
    saleId: row.sale_id,
    saleItemId: row.sale_item_id,
    marketplace: row.marketplace,
    soldAt: row.sold_at,
    shipBy: row.ship_by,
    item: { id: row.item_id, sku: row.sku, title: row.title },
    location:
      row.location_code === null ? null : { code: row.location_code, label: row.location_label },
  }));
}

/**
 * Delist runs not completed yet, oldest first, from their computed per-marketplace truth (the
 * stored status only narrows the read; a run whose results are all done has no card).
 */
async function delistCards(executor: DbExecutor, accountId: string): Promise<TodayCard[]> {
  const open = await executor
    .selectFrom('delist_run')
    .select('id')
    .where('account_id', '=', accountId)
    .where('status', '<>', 'completed')
    .orderBy('created_at')
    .orderBy('id')
    .limit(MAX_CARDS_PER_KIND)
    .execute();
  const runs = await loadDelistRuns(executor, accountId, { runIds: open.map((run) => run.id) });
  if (runs.length === 0) return [];
  const items = await itemRefs(
    executor,
    accountId,
    runs.map((run) => run.itemId),
  );
  return runs.flatMap((run) => {
    const item = items.get(run.itemId);
    const card = item === undefined ? null : delistCard(run, item);
    return card === null ? [] : [card];
  });
}

async function connectionFacts(executor: DbExecutor, accountId: string): Promise<ConnectionFact[]> {
  const rows = await executor
    .selectFrom('marketplace_connection')
    .select(['id', 'marketplace', 'display_name', 'status'])
    .where('account_id', '=', accountId)
    .where('status', 'in', ['reauth_required', 'revoked'])
    .orderBy('marketplace')
    .orderBy('id')
    .limit(MAX_CARDS_PER_KIND)
    .execute();
  return rows.flatMap((row) =>
    row.status === 'reauth_required' || row.status === 'revoked'
      ? [
          {
            id: row.id,
            marketplace: row.marketplace,
            displayName: row.display_name,
            status: row.status,
          },
        ]
      : [],
  );
}

/**
 * Listed items whose oldest live listing went live at least `staleListedDays` ago and that had
 * no listing change for `staleQuietDays`, longest listed first. The rules in cards.ts decide
 * again from the same facts, so these thresholds only keep the read small.
 *
 * The subqueries name the account as a parameter, not as `item.account_id`. Correlated through
 * the outer row, Postgres either hashed the `not exists` over every account's recent operations
 * and listings (sequential scans of both tables) or ran it once per listed item; with the
 * account bound it hashes only this seller's recent changes, two to three times faster
 * (docs/features/performance.md).
 */
async function staleCandidates(
  executor: DbExecutor,
  accountId: string,
  now: Date,
): Promise<ListedFact[]> {
  const listedBefore = new Date(now.getTime() - TODAY_RULES.staleListedDays * DAY_MS);
  const quietSince = new Date(now.getTime() - TODAY_RULES.staleQuietDays * DAY_MS);
  const { rows } = await sql<{
    id: string;
    sku: string;
    title: string | null;
    currency: CurrencyCode;
    list_price_cents: number | null;
    floor_price_cents: number | null;
    min_listing_price_cents: number | null;
    listed_at: Date;
    last_change_at: Date | null;
    marketplaces: Marketplace[];
  }>`
    select item.id, item.sku, item.title, item.currency, item.list_price_cents,
      item.floor_price_cents, min(listing.price_cents) as min_listing_price_cents,
      min(listing.listed_at) as listed_at,
      array_agg(distinct listing.marketplace::text order by listing.marketplace::text) as marketplaces,
      (
        select max(op.created_at)
        from marketplace_operation op
        join marketplace_listing changed
          on changed.account_id = op.account_id and changed.id = op.listing_id
        where op.account_id = ${accountId} and changed.account_id = ${accountId}
          and changed.item_id = item.id and op.kind in ('create', 'revise', 'price', 'relist')
      ) as last_change_at
    from inventory_item item
    join marketplace_listing listing
      on listing.account_id = item.account_id and listing.item_id = item.id
    where item.account_id = ${accountId}
      and item.status = 'listed'
      and listing.status = 'active'
      and listing.listed_at is not null
    group by item.id
    having min(listing.listed_at) <= ${listedBefore}
      and not exists (
        select 1
        from marketplace_operation op
        join marketplace_listing changed
          on changed.account_id = op.account_id and changed.id = op.listing_id
        where op.account_id = ${accountId} and changed.account_id = ${accountId}
          and changed.item_id = item.id and op.kind in ('create', 'revise', 'price', 'relist')
          and op.created_at > ${quietSince}
      )
    order by min(listing.listed_at), item.id
    limit ${MAX_CARDS_PER_KIND}
  `.execute(executor);
  return rows.map((row) => ({
    item: { id: row.id, sku: row.sku, title: row.title },
    currency: row.currency,
    priceCents: row.list_price_cents ?? row.min_listing_price_cents,
    floorCents: row.floor_price_cents,
    listedAt: row.listed_at,
    lastChangeAt: row.last_change_at,
    marketplaces: row.marketplaces,
  }));
}

async function draftsFact(executor: DbExecutor, accountId: string): Promise<DraftsFact> {
  const row = await executor
    .selectFrom('inventory_item')
    .select((eb) => [eb.fn.countAll<string>().as('count'), eb.fn.min('created_at').as('oldest')])
    .where('account_id', '=', accountId)
    .where('status', '=', 'draft')
    .executeTakeFirstOrThrow();
  return { count: Number(row.count), oldestCreatedAt: row.oldest };
}

/**
 * Every sale of the last two weeks that was not canceled or returned, with its money computed
 * exactly as the Sales tab computes it (`saleMoney` in @listora/sales), so the two never differ.
 */
async function saleMoneyFacts(
  executor: DbExecutor,
  accountId: string,
  now: Date,
): Promise<SaleMoneyFact[]> {
  const since = new Date(now.getTime() - 14 * DAY_MS);
  const sales = await executor
    .selectFrom('sale')
    .select(['id', 'sold_at', 'shipping_charged_cents', 'shipping_cost_cents'])
    .where('account_id', '=', accountId)
    .where('status', 'not in', ['canceled', 'returned'])
    .where('sold_at', '>=', since)
    .where('sold_at', '<', now)
    .execute();
  if (sales.length === 0) return [];
  const saleIds = sales.map((sale) => sale.id);
  const [items, fees] = await Promise.all([
    executor
      .selectFrom('sale_item')
      .innerJoin('inventory_item as item', (join) =>
        join
          .onRef('item.account_id', '=', 'sale_item.account_id')
          .onRef('item.id', '=', 'sale_item.item_id'),
      )
      .select([
        'sale_item.id',
        'sale_item.sale_id',
        'sale_item.item_id',
        'sale_item.sale_price_cents',
        'item.cost_cents',
      ])
      .where('sale_item.account_id', '=', accountId)
      .where('sale_item.sale_id', 'in', saleIds)
      .execute(),
    executor
      .selectFrom('fee_line')
      .select(['sale_id', 'sale_item_id', 'amount_cents', 'source'])
      .where('account_id', '=', accountId)
      .where('sale_id', 'in', saleIds)
      .execute(),
  ]);
  const itemsOf = Map.groupBy(items, (item) => item.sale_id);
  const feesOf = Map.groupBy(fees, (fee) => fee.sale_id);
  return sales.flatMap((sale) => {
    const lines = itemsOf.get(sale.id) ?? [];
    if (lines.length === 0) return [];
    const money = saleMoney({
      shippingChargedCents: sale.shipping_charged_cents,
      shippingCostCents: sale.shipping_cost_cents,
      items: lines.map((line) => ({
        saleItemId: line.id,
        itemId: line.item_id,
        salePriceCents: line.sale_price_cents,
        costCents: line.cost_cents,
      })),
      fees: (feesOf.get(sale.id) ?? []).map((fee) => ({
        saleItemId: fee.sale_item_id,
        amountCents: fee.amount_cents,
        source: fee.source,
      })),
    });
    return [
      {
        saleId: sale.id,
        soldAt: sale.sold_at,
        itemsSold: lines.length,
        priceCents: money.salePriceCents,
        profitCents: money.profitCents,
      },
    ];
  });
}

async function itemRefs(
  executor: DbExecutor,
  accountId: string,
  ids: readonly string[],
): Promise<Map<string, TodayItemRef>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .selectFrom('inventory_item')
    .select(['id', 'sku', 'title'])
    .where('account_id', '=', accountId)
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}
