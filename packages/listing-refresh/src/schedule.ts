/**
 * Each live listing's refresh as the item screen shows it (its next and its last), and the facts
 * the schedule decides from. One plain query over the listings, their connection, their item's
 * cadence, and their operations; the rules are cadence.ts.
 */
import type {
  ConnectionMode,
  ConnectionStatus,
  DbExecutor,
  Marketplace,
  RefreshCadence,
} from '@listora/db';
import { marketplacesWith, type FeatureGate } from '@listora/marketplaces';
import { sql } from 'kysely';

import {
  effectiveCadence,
  intervalHours,
  nextRefreshAt,
  type Cadence,
  type QuietWindow,
} from './cadence.ts';
import { itemCadence } from './settings.ts';

/**
 * The marketplaces whose listings Listora refreshes, each under a browser session it can use:
 * Poshmark shares to followers, Mercari saves the edit page unchanged, and Depop relists (see
 * `REPOST_MARKETPLACES`). eBay has no refresh that keeps a listing's watchers (its relist is a
 * new listing), and an assisted marketplace would make the seller do it
 * (docs/features/listing-refresh.md). The adapters' own `refresh` capability agrees (the
 * worker's test checks it), and the schedule asks it too.
 */
export const REFRESH_MARKETPLACES: readonly Marketplace[] = ['poshmark', 'mercari', 'depop'];

/**
 * The marketplaces whose refresh is a repost (`refreshBy: 'repost'`; the worker's test checks
 * the adapters agree): Depop shows only a new listing as new, so a fresh copy is posted and the
 * old one deleted, which resets its likes and saves. Their listings are refreshed only when the
 * account turned relisting on (`relistToRefresh`), only listings Listora wrote (it posts their
 * content again), and never one with an offer waiting.
 */
export const REPOST_MARKETPLACES: readonly Marketplace[] = ['depop'];

/**
 * The marketplaces whose listings Listora refreshes for the account: those of
 * `REFRESH_MARKETPLACES` whose refresh passed live (docs/features/verified-features.md), or all
 * of them in the account's Test mode (docs/features/test-mode.md). The others show no refresh
 * and get none queued.
 */
export function refreshMarketplaces(gate: FeatureGate): Marketplace[] {
  return marketplacesWith('listing_refresh', REFRESH_MARKETPLACES, gate);
}

/** The operation kinds whose confirmed change leaves a listing fresh. */
const CHANGE_KINDS = sql`('create', 'revise', 'price', 'relist')`;
/** The operation kinds whose content a repost posts again: what Listora wrote of the listing. */
const CONTENT_KINDS = sql`('create', 'revise', 'relist', 'refresh')`;
const UNFINISHED = sql`('queued', 'running', 'retrying', 'verifying', 'needs_user_action')`;

/** A live listing of a listed item, with what its refresh depends on. */
export interface RefreshFact {
  listingId: string;
  itemId: string;
  marketplace: Marketplace;
  connection: {
    id: string;
    mode: ConnectionMode;
    status: ConnectionStatus;
    readOnly: boolean;
  } | null;
  /** When it was last fresh: live, a confirmed change, or a refresh (whatever came of it). */
  freshAt: Date;
  /** When a refresh was last confirmed. */
  lastRefreshedAt: Date | null;
  /** The item's own cadence; `null` when it follows the account's. */
  itemCadence: Cadence | null;
  /** An operation on it is not finished yet, so a refresh would only wait behind it. */
  busy: boolean;
  /** Its account is in Test mode (docs/features/test-mode.md). */
  testMode: boolean;
  /** Its marketplace refreshes by a repost (`REPOST_MARKETPLACES`). */
  reposts: boolean;
  /**
   * Listora wrote it: a confirmed operation carries its content, which a repost posts again
   * (an imported or linked listing has none).
   */
  written: boolean;
  /** A buyer's offer on it waits for an answer, which a repost would lose. */
  offerWaiting: boolean;
}

/** A listing's refresh, as it shows on the item screen. */
export type ListingRefresh =
  /** Listora refreshes it at `nextAt`. */
  | { state: 'scheduled'; nextAt: Date; lastAt: Date | null }
  /**
   * Refreshing is off for it: its item's cadence or the account's, or a relisting marketplace's
   * listing while the account has relisting off.
   */
  | { state: 'off'; lastAt: Date | null }
  /** Listora can't refresh it here: the marketplace has no refresh, or no usable session. */
  | { state: 'unavailable'; lastAt: Date | null };

/**
 * Whether Listora can refresh the listing under its connection now. A repost needs the
 * listing's content, so only a listing Listora wrote can be relisted.
 */
export function canRefresh(
  fact: Pick<RefreshFact, 'marketplace' | 'connection' | 'testMode' | 'reposts' | 'written'>,
): boolean {
  const { connection } = fact;
  return (
    refreshMarketplaces({ testMode: fact.testMode }).includes(fact.marketplace) &&
    (!fact.reposts || fact.written) &&
    connection !== null &&
    // A read-only connection (a real shop that must not change, read-only.md) gets no refresh.
    !connection.readOnly &&
    connection.mode === 'automation' &&
    (connection.status === 'connected' || connection.status === 'degraded')
  );
}

export function listingRefresh(
  fact: RefreshFact,
  account: Cadence & { relistToRefresh: boolean },
  window: QuietWindow | null,
  now: Date,
): ListingRefresh {
  const lastAt = fact.lastRefreshedAt;
  if (!canRefresh(fact)) return { state: 'unavailable', lastAt };
  if (fact.reposts && !account.relistToRefresh) return { state: 'off', lastAt };
  const hours = intervalHours(effectiveCadence(fact.itemCadence, account));
  if (hours === null) return { state: 'off', lastAt };
  return { state: 'scheduled', nextAt: nextRefreshAt(fact.freshAt, hours, window, now), lastAt };
}

/**
 * The account's live listings of listed items with their refresh facts: `listingIds` narrows to
 * those listings, `connectionId` to the listings under that connection.
 */
export async function loadRefreshFacts(
  executor: DbExecutor,
  accountId: string,
  filter: { listingIds?: readonly string[]; connectionId?: string },
): Promise<RefreshFact[]> {
  if (filter.listingIds?.length === 0) return [];
  const { rows } = await sql<{
    id: string;
    item_id: string;
    marketplace: Marketplace;
    listed_at: Date;
    connection_id: string | null;
    mode: ConnectionMode | null;
    status: ConnectionStatus | null;
    read_only: boolean | null;
    refresh_cadence: RefreshCadence | null;
    refresh_custom_hours: number | null;
    last_fresh_at: Date | null;
    last_refreshed_at: Date | null;
    busy: boolean;
    test_mode: boolean;
    written: boolean;
    offer_waiting: boolean;
  }>`
    select listing.id, listing.item_id, listing.marketplace, listing.listed_at,
      listing.connection_id, connection.mode, connection.status, connection.read_only,
      item.refresh_cadence, item.refresh_custom_hours,
      (
        select max(op.created_at) from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id
          and ((op.kind in ${CHANGE_KINDS} and op.status = 'succeeded')
            or (op.kind = 'refresh' and op.status <> 'canceled'))
      ) as last_fresh_at,
      (
        select max(op.updated_at) from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id
          and op.kind = 'refresh' and op.status = 'succeeded'
      ) as last_refreshed_at,
      exists (
        select 1 from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id
          and op.status in ${UNFINISHED}
      ) as busy,
      exists (
        select 1 from marketplace_operation op
        where op.account_id = ${accountId} and op.listing_id = listing.id
          and op.kind in ${CONTENT_KINDS} and op.status = 'succeeded' and op.content is not null
      ) and listing.title is not null and listing.price_cents is not null as written,
      exists (
        select 1 from marketplace_offer offer
        where offer.account_id = ${accountId} and offer.listing_id = listing.id
          and offer.status = 'pending'
      ) as offer_waiting,
      account.test_mode
    from marketplace_listing listing
    join account on account.id = listing.account_id
    join inventory_item item on item.account_id = listing.account_id and item.id = listing.item_id
    left join marketplace_connection connection
      on connection.account_id = listing.account_id and connection.id = listing.connection_id
    where listing.account_id = ${accountId}
      and listing.status = 'active'
      and listing.listed_at is not null
      and item.status = 'listed'
      ${filter.listingIds === undefined ? sql`` : sql`and listing.id = any(${[...filter.listingIds]}::uuid[])`}
      ${filter.connectionId === undefined ? sql`` : sql`and listing.connection_id = ${filter.connectionId}`}
    order by listing.listed_at, listing.id
  `.execute(executor);
  return rows.map((row) => ({
    listingId: row.id,
    itemId: row.item_id,
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
    freshAt:
      row.last_fresh_at !== null && row.last_fresh_at > row.listed_at
        ? row.last_fresh_at
        : row.listed_at,
    lastRefreshedAt: row.last_refreshed_at,
    itemCadence: itemCadence(row),
    busy: row.busy,
    testMode: row.test_mode,
    reposts: REPOST_MARKETPLACES.includes(row.marketplace),
    written: row.written,
    offerWaiting: row.offer_waiting,
  }));
}
