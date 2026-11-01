/**
 * Each live listing's planned drop, as the seller sees it before it runs, and the facts the
 * schedule decides from (docs/features/price-drops.md). One plain query over the live listings,
 * their item, their connection, and their price changes; the rules are rules.ts.
 */
import type { ConnectionMode, ConnectionStatus, DbExecutor, Marketplace } from '@listora/db';
import { marketplacesWith, type FeatureGate } from '@listora/marketplaces';
import type { CurrencyCode } from '@listora/shared';
import { sql } from 'kysely';

import { dropDueAt, nextDropPrice } from './rules.ts';
import { ruleFor, type DropRule } from './store.ts';

/**
 * The marketplaces whose live listings price drops lower: those where a price change passed live
 * (Depop, Poshmark, and Mercari, docs/features/verified-features.md). eBay's has not run live.
 */
export const PRICE_DROP_MARKETPLACES: readonly Marketplace[] = ['depop', 'poshmark', 'mercari'];

/**
 * The marketplaces whose listings price drops lower for the account: those of
 * `PRICE_DROP_MARKETPLACES` where price drops passed live, or all of them in Test mode.
 */
export function priceDropMarketplaces(gate: FeatureGate): Marketplace[] {
  return marketplacesWith('price_drops', PRICE_DROP_MARKETPLACES, gate);
}

const UNFINISHED = sql`('queued', 'running', 'retrying', 'verifying', 'needs_user_action')`;

/** A live listing of a listed item, with what its drops depend on. */
export interface DropFact {
  listingId: string;
  itemId: string;
  sku: string;
  title: string | null;
  brand: string | null;
  marketplace: Marketplace;
  connection: {
    id: string;
    mode: ConnectionMode;
    status: ConnectionStatus;
    readOnly: boolean;
  } | null;
  /** The listing's price now, as Listora last set it. */
  priceCents: number | null;
  currency: CurrencyCode;
  /** The item's own "don't sell below" price. */
  itemFloorCents: number | null;
  /** When it went live or its price last changed (a confirmed price change or relist). */
  unsoldSince: Date;
  /** Its newest price change failed: no drop runs until the seller retries or changes it. */
  lastPriceChangeFailed: boolean;
  /** A change to it is not finished yet, so a drop waits behind it. */
  busy: boolean;
}

/** A listing's next drop, as the seller sees it. */
export type PlannedDrop =
  /** It drops to `priceCents` at `at` (now or soon when it is due already). */
  | { state: 'scheduled'; at: Date; priceCents: number }
  /** It is at its lowest price: no drop lowers it further. */
  | { state: 'at_floor' }
  /** Its last price change failed; retry it on the item and drops go on. */
  | { state: 'last_failed' }
  /** Listora can't change its price there: no linked session that works, or read only. */
  | { state: 'unavailable' };

/** A live listing a rule applies to, and its next drop. */
export interface ListingDropPlan {
  fact: DropFact;
  rule: DropRule;
  plan: PlannedDrop;
}

/** Whether Listora may lower the listing's price under its connection now. */
export function canDrop(fact: Pick<DropFact, 'marketplace' | 'connection'>, gate: FeatureGate) {
  const { connection } = fact;
  return (
    priceDropMarketplaces(gate).includes(fact.marketplace) &&
    connection !== null &&
    // A read-only connection gets no write (docs/features/read-only.md).
    !connection.readOnly &&
    connection.mode === 'automation' &&
    (connection.status === 'connected' || connection.status === 'degraded')
  );
}

export function plannedDrop(
  fact: DropFact,
  rule: DropRule,
  gate: FeatureGate,
  now: Date,
): PlannedDrop {
  // Money is USD only for now (architecture.md), so a rule's floor and a price always compare.
  if (!canDrop(fact, gate) || fact.priceCents === null) return { state: 'unavailable' };
  if (fact.lastPriceChangeFailed) return { state: 'last_failed' };
  const priceCents = nextDropPrice(fact.priceCents, rule, fact.itemFloorCents);
  if (priceCents === null) return { state: 'at_floor' };
  const due = dropDueAt(fact.unsoldSince, rule.afterDays, rule.armedAt);
  return { state: 'scheduled', at: due > now ? due : now, priceCents };
}

/**
 * The live listings an enabled rule applies to, each with its next drop: scheduled ones soonest
 * first, then the rest. A listing whose rule is off has none (it is not planned), and neither
 * has one on a marketplace where price drops are hidden from the account, so a seller never
 * sees a drop that can't run there (verified-features.md).
 */
export function planDrops(
  facts: readonly DropFact[],
  rules: readonly DropRule[],
  gate: FeatureGate,
  now: Date,
): ListingDropPlan[] {
  const shown = priceDropMarketplaces(gate);
  const plans = facts.flatMap((fact) => {
    if (!shown.includes(fact.marketplace)) return [];
    const rule = ruleFor(rules, { id: fact.itemId, brand: fact.brand });
    if (!rule?.enabled) return [];
    return [{ fact, rule, plan: plannedDrop(fact, rule, gate, now) }];
  });
  const at = (plan: PlannedDrop) =>
    plan.state === 'scheduled' ? plan.at.getTime() : Number.POSITIVE_INFINITY;
  return plans.sort((a, b) => at(a.plan) - at(b.plan));
}

/**
 * The account's live listings of listed items on the price drop marketplaces, with their facts:
 * `itemId` narrows to one item's, `connectionId` to one connection's.
 */
export async function loadDropFacts(
  executor: DbExecutor,
  accountId: string,
  filter: { itemId?: string; connectionId?: string } = {},
): Promise<DropFact[]> {
  const { rows } = await sql<{
    id: string;
    item_id: string;
    sku: string;
    title: string | null;
    brand: string | null;
    marketplace: Marketplace;
    connection_id: string | null;
    mode: ConnectionMode | null;
    status: ConnectionStatus | null;
    read_only: boolean | null;
    price_cents: number | null;
    currency: CurrencyCode;
    floor_price_cents: number | null;
    listed_at: Date;
    last_change_at: Date | null;
    last_price_status: string | null;
    busy: boolean;
  }>`
    select listing.id, listing.item_id, item.sku, coalesce(listing.title, item.title) as title,
      item.brand, listing.marketplace, listing.connection_id, connection.mode, connection.status,
      connection.read_only, listing.price_cents, listing.currency, item.floor_price_cents,
      listing.listed_at,
      (
        select max(op.created_at) from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id
          and op.kind in ('price', 'relist') and op.status = 'succeeded'
      ) as last_change_at,
      (
        select op.status from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id and op.kind = 'price'
        order by op.created_at desc, op.id desc
        limit 1
      ) as last_price_status,
      exists (
        select 1 from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id
          and op.status in ${UNFINISHED}
      ) as busy
    from marketplace_listing listing
    join inventory_item item on item.account_id = listing.account_id and item.id = listing.item_id
    left join marketplace_connection connection
      on connection.account_id = listing.account_id and connection.id = listing.connection_id
    where listing.account_id = ${accountId}
      and listing.status = 'active'
      and listing.listed_at is not null
      and item.status = 'listed'
      and listing.marketplace = any(${[...PRICE_DROP_MARKETPLACES]}::text[])
      ${filter.itemId === undefined ? sql`` : sql`and listing.item_id = ${filter.itemId}`}
      ${filter.connectionId === undefined ? sql`` : sql`and listing.connection_id = ${filter.connectionId}`}
    order by listing.listed_at, listing.id
  `.execute(executor);
  return rows.map((row) => ({
    listingId: row.id,
    itemId: row.item_id,
    sku: row.sku,
    title: row.title,
    brand: row.brand,
    marketplace: row.marketplace,
    connection:
      row.connection_id === null || row.mode === null || row.status === null
        ? null
        : {
            id: row.connection_id,
            mode: row.mode,
            status: row.status,
            readOnly: row.read_only === true,
          },
    priceCents: row.price_cents,
    currency: row.currency,
    itemFloorCents: row.floor_price_cents,
    unsoldSince:
      row.last_change_at !== null && row.last_change_at > row.listed_at
        ? row.last_change_at
        : row.listed_at,
    lastPriceChangeFailed: row.last_price_status === 'failed',
    busy: row.busy,
  }));
}
