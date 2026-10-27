/**
 * The Today screen's card rules (docs/features/today.md): which facts become which cards, how
 * urgent each one is, its one primary action, and the order the cards show in. Pure: the plain
 * queries in summary.ts load the facts, so every rule is tested without a database.
 *
 * A card exists only while its work is not done, so a card disappears by itself once the seller
 * (or Listora) finishes it: a shipped item, a completed delist, a working connection, a listing
 * that changed, a reviewed draft.
 */
import { DONE_STATES, type DelistResultState, type DelistRunView } from '@listora/auto-delist';
import type { Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { StatusDisplay } from '@listora/operations';
import { saleCheckProblemWords, type SaleCheckProblem } from '@listora/automation';
import type { CurrencyCode } from '@listora/shared';

/** In the order the screen groups cards of equal urgency. */
export const TODAY_CARD_KINDS = [
  'delist',
  'ship',
  'reconnect',
  'sale_checks',
  'review_drafts',
  'stale_listing',
] as const;
export type TodayCardKind = (typeof TODAY_CARD_KINDS)[number];

/** Most urgent first. */
export const TODAY_URGENCIES = ['urgent', 'high', 'normal'] as const;
export type TodayUrgency = (typeof TODAY_URGENCIES)[number];

/** The screen a card's primary action opens. */
export const TODAY_DESTINATIONS = ['item', 'sale', 'marketplaces', 'drafts'] as const;
export type TodayDestination = (typeof TODAY_DESTINATIONS)[number];

export const TODAY_RULES = {
  /** A ship-by date this close (or past) makes shipping urgent. */
  shipUrgentWithinMs: 24 * 60 * 60_000,
  /** ... and this close makes it high. */
  shipSoonWithinMs: 72 * 60 * 60_000,
  /** A sale without a ship-by date is high once it is this old. */
  shipUndatedHighAfterMs: 2 * 24 * 60 * 60_000,
  /** A listing live this long ... */
  staleListedDays: 30,
  /** ... with no listing change (create, revise, price, relist) for this long is stale. */
  staleQuietDays: 14,
  /** A price drop suggests this much off, rounded down to whole dollars, never below the floor. */
  priceDropPercent: 10,
  /** Stale listings shown at most, oldest first: suggestions, not a to-do list. */
  maxStaleCards: 5,
} as const;

const DAY_MS = 24 * 60 * 60_000;

/** The item a card is about, as the seller knows it. */
export interface TodayItemRef {
  id: string;
  sku: string;
  title: string | null;
}

export interface TodayAction {
  label: string;
  destination: TodayDestination;
  itemId: string | null;
  saleId: string | null;
  connectionId: string | null;
}

interface CardBase {
  /** Stable while the card's work is the same, so the app can animate one leaving. */
  id: string;
  urgency: TodayUrgency;
  title: string;
  detail: string | null;
  action: TodayAction;
}

export interface ShipCard extends CardBase {
  kind: 'ship';
  item: TodayItemRef;
  saleId: string;
  marketplace: Marketplace;
  soldAt: Date;
  shipBy: Date | null;
  location: { code: string; label: string | null } | null;
}

export interface DelistCard extends CardBase {
  kind: 'delist';
  item: TodayItemRef;
  saleId: string;
  delistRunId: string;
  soldOn: Marketplace;
  /** The run's honest summary, exactly as the item screen shows it. */
  status: StatusDisplay;
  /** Where the item is not delisted (or confirmed) yet. */
  remaining: Marketplace[];
}

export interface ReconnectCard extends CardBase {
  kind: 'reconnect';
  connectionId: string;
  marketplace: Marketplace;
  displayName: string | null;
  status: 'reauth_required' | 'revoked';
}

export interface SaleChecksCard extends CardBase {
  kind: 'sale_checks';
  connectionId: string;
  marketplace: Marketplace;
  /** `failing`: the last checks failed; `overdue`: the check that was due has not run. */
  health: SaleCheckProblem['health'];
  /** When the problem started. */
  since: Date;
  lastSucceededAt: Date | null;
}

export type StaleSuggestion =
  /** Lower the price to `priceCents`, which is never below the item's floor. */
  | { kind: 'price_drop'; priceCents: number }
  /** No price drop is possible (at the floor, or no floor is known): relist instead. */
  | { kind: 'relist' };

export interface StaleListingCard extends CardBase {
  kind: 'stale_listing';
  item: TodayItemRef;
  /** When its oldest live listing went live. */
  listedAt: Date;
  daysListed: number;
  currency: CurrencyCode;
  priceCents: number;
  floorCents: number | null;
  suggestion: StaleSuggestion;
  marketplaces: Marketplace[];
}

export interface ReviewDraftsCard extends CardBase {
  kind: 'review_drafts';
  count: number;
  oldestCreatedAt: Date;
}

export type TodayCard =
  ShipCard | DelistCard | ReconnectCard | SaleChecksCard | StaleListingCard | ReviewDraftsCard;

const LABEL_MAX_LENGTH = 60;

/** The item as the seller knows it: its title, or its SKU when it has none. */
export function itemLabel(item: Pick<TodayItemRef, 'title' | 'sku'>): string {
  const title = item.title?.trim() ?? '';
  if (title === '') return item.sku;
  return title.length <= LABEL_MAX_LENGTH ? title : `${title.slice(0, LABEL_MAX_LENGTH - 3)}...`;
}

/** `$40` for whole dollars, otherwise `$40.50`. */
export function formatMoney(cents: number, currency: CurrencyCode = 'USD'): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

// Ship ----------------------------------------------------------------------------------------

/** An item sold in a sale that is not canceled or returned, and that is not shipped yet. */
export interface ShipFact {
  saleId: string;
  saleItemId: string;
  marketplace: Marketplace;
  soldAt: Date;
  shipBy: Date | null;
  item: TodayItemRef;
  location: { code: string; label: string | null } | null;
}

export function shipCard(fact: ShipFact, now: Date): ShipCard {
  return {
    kind: 'ship',
    id: `ship:${fact.saleItemId}`,
    urgency: shipUrgency(fact, now),
    title: `Ship ${itemLabel(fact.item)}`,
    detail: `Sold on ${MARKETPLACE_NAMES[fact.marketplace]}`,
    action: {
      label: 'Open sale',
      destination: 'sale',
      itemId: fact.item.id,
      saleId: fact.saleId,
      connectionId: null,
    },
    item: fact.item,
    saleId: fact.saleId,
    marketplace: fact.marketplace,
    soldAt: fact.soldAt,
    shipBy: fact.shipBy,
    location: fact.location,
  };
}

export function shipUrgency(fact: Pick<ShipFact, 'shipBy' | 'soldAt'>, now: Date): TodayUrgency {
  if (fact.shipBy === null) {
    return now.getTime() - fact.soldAt.getTime() >= TODAY_RULES.shipUndatedHighAfterMs
      ? 'high'
      : 'normal';
  }
  const left = fact.shipBy.getTime() - now.getTime();
  if (left <= TODAY_RULES.shipUrgentWithinMs) return 'urgent';
  if (left <= TODAY_RULES.shipSoonWithinMs) return 'high';
  return 'normal';
}

// Delist --------------------------------------------------------------------------------------

/**
 * A card for a delist run that is not done everywhere, from its computed truth (never the stored
 * status); none for a completed run or one whose sale was canceled or returned.
 */
export function delistCard(run: DelistRunView, item: TodayItemRef): DelistCard | null {
  if (run.status === 'completed') return null;
  if (run.saleStatus === 'canceled' || run.saleStatus === 'returned') return null;
  const needsSeller = run.status === 'attention_needed';
  return {
    kind: 'delist',
    id: `delist:${run.id}`,
    urgency: needsSeller ? 'urgent' : 'high',
    title: `${itemLabel(item)} sold on ${MARKETPLACE_NAMES[run.soldOn]}`,
    detail: run.display.label,
    action: {
      label: needsSeller ? 'Finish delisting' : 'View delisting',
      destination: 'item',
      itemId: item.id,
      saleId: null,
      connectionId: null,
    },
    item,
    saleId: run.saleId,
    delistRunId: run.id,
    soldOn: run.soldOn,
    status: run.display,
    remaining: run.results.filter((result) => !isDone(result.state)).map((r) => r.marketplace),
  };
}

function isDone(state: DelistResultState): boolean {
  return (DONE_STATES as readonly DelistResultState[]).includes(state);
}

// Reconnect -----------------------------------------------------------------------------------

export interface ConnectionFact {
  id: string;
  marketplace: Marketplace;
  displayName: string | null;
  status: 'reauth_required' | 'revoked';
}

export function reconnectCard(fact: ConnectionFact): ReconnectCard {
  const name = MARKETPLACE_NAMES[fact.marketplace];
  return {
    kind: 'reconnect',
    id: `reconnect:${fact.id}`,
    urgency: 'high',
    title: `Reconnect ${name}`,
    detail:
      fact.status === 'revoked'
        ? `Listora's access to ${name} was removed. Reconnect so Listora can keep your listings there in sync.`
        : `${name} stopped accepting Listora's access. Reconnect so Listora can keep your listings there in sync.`,
    action: {
      label: 'Reconnect',
      destination: 'marketplaces',
      itemId: null,
      saleId: null,
      connectionId: fact.id,
    },
    connectionId: fact.id,
    marketplace: fact.marketplace,
    displayName: fact.displayName,
    status: fact.status,
  };
}

// Sale checks ---------------------------------------------------------------------------------

/**
 * A marketplace whose sale checks fail or stopped running (docs/features/activity.md): its
 * sales are not being seen, so a sale there is not delisted elsewhere until a check works. The
 * words are the notification's.
 */
export function saleChecksCard(problem: SaleCheckProblem, now: Date): SaleChecksCard {
  const words = saleCheckProblemWords(problem, now);
  return {
    kind: 'sale_checks',
    id: `sale_checks:${problem.connectionId}`,
    urgency: 'high',
    title: words.title,
    detail: words.detail,
    action: {
      label: 'See marketplaces',
      destination: 'marketplaces',
      itemId: null,
      saleId: null,
      connectionId: problem.connectionId,
    },
    connectionId: problem.connectionId,
    marketplace: problem.marketplace,
    health: problem.health,
    since: problem.unhealthySince,
    lastSucceededAt: problem.lastSucceededAt,
  };
}

// Stale listings ------------------------------------------------------------------------------

/** A listed item with at least one live listing. */
export interface ListedFact {
  item: TodayItemRef;
  currency: CurrencyCode;
  /** The item's list price, else its lowest live listing price; null when neither is known. */
  priceCents: number | null;
  floorCents: number | null;
  /** When its oldest live listing went live. */
  listedAt: Date;
  /** The newest listing change (create, revise, price, relist) on any of its listings. */
  lastChangeAt: Date | null;
  marketplaces: Marketplace[];
}

export function isStale(fact: Pick<ListedFact, 'listedAt' | 'lastChangeAt'>, now: Date): boolean {
  const listedFor = now.getTime() - fact.listedAt.getTime();
  if (listedFor < TODAY_RULES.staleListedDays * DAY_MS) return false;
  if (fact.lastChangeAt === null) return true;
  return now.getTime() - fact.lastChangeAt.getTime() >= TODAY_RULES.staleQuietDays * DAY_MS;
}

/**
 * A price drop of `priceDropPercent`, rounded down to whole dollars and raised to the floor; a
 * relist when that is no drop at all (the price is at or below its floor) or no floor is known,
 * since Listora never suggests a price it cannot check against the floor.
 */
export function staleSuggestion(priceCents: number, floorCents: number | null): StaleSuggestion {
  if (floorCents === null) return { kind: 'relist' };
  const dropped = Math.floor((priceCents * (100 - TODAY_RULES.priceDropPercent)) / 100 / 100) * 100;
  const suggested = Math.max(dropped, floorCents);
  return suggested < priceCents
    ? { kind: 'price_drop', priceCents: suggested }
    : { kind: 'relist' };
}

export function staleListingCard(fact: ListedFact, now: Date): StaleListingCard | null {
  if (fact.priceCents === null || !isStale(fact, now)) return null;
  const daysListed = Math.floor((now.getTime() - fact.listedAt.getTime()) / DAY_MS);
  const suggestion = staleSuggestion(fact.priceCents, fact.floorCents);
  const quiet = `Listed ${String(daysListed)} days with no changes.`;
  let detail: string;
  let label: string;
  switch (suggestion.kind) {
    case 'price_drop':
      detail = `${quiet} Try ${formatMoney(suggestion.priceCents, fact.currency)}${
        fact.floorCents === null
          ? ''
          : `, still above your ${formatMoney(fact.floorCents, fact.currency)} floor`
      }.`;
      label = `Lower to ${formatMoney(suggestion.priceCents, fact.currency)}`;
      break;
    case 'relist':
      detail =
        fact.floorCents === null
          ? `${quiet} Relisting can bring it back to the top of search.`
          : `${quiet} It's at its floor price, so relisting can bring it back to the top of search.`;
      label = 'Review listing';
      break;
  }
  return {
    kind: 'stale_listing',
    id: `stale:${fact.item.id}`,
    urgency: 'normal',
    title: itemLabel(fact.item),
    detail,
    action: { label, destination: 'item', itemId: fact.item.id, saleId: null, connectionId: null },
    item: fact.item,
    listedAt: fact.listedAt,
    daysListed,
    currency: fact.currency,
    priceCents: fact.priceCents,
    floorCents: fact.floorCents,
    suggestion,
    marketplaces: fact.marketplaces,
  };
}

// Drafts --------------------------------------------------------------------------------------

export interface DraftsFact {
  count: number;
  oldestCreatedAt: Date | null;
}

/** One card for every draft item, which opens the drafts to finish them. */
export function reviewDraftsCard(fact: DraftsFact): ReviewDraftsCard | null {
  if (fact.count === 0 || fact.oldestCreatedAt === null) return null;
  return {
    kind: 'review_drafts',
    id: 'review_drafts',
    urgency: 'normal',
    title: fact.count === 1 ? '1 draft to review' : `${String(fact.count)} drafts to review`,
    detail:
      fact.count === 1
        ? "Check its details and price, and it's ready to list everywhere."
        : "Check their details and prices, and they're ready to list everywhere.",
    action: {
      label: 'Review drafts',
      destination: 'drafts',
      itemId: null,
      saleId: null,
      connectionId: null,
    },
    count: fact.count,
    oldestCreatedAt: fact.oldestCreatedAt,
  };
}

// Order ---------------------------------------------------------------------------------------

/**
 * Most urgent first; within one urgency by kind (`TODAY_CARD_KINDS`), and within one kind in the
 * order given (the queries sort each kind: soonest ship-by, oldest delist, longest listed).
 */
export function orderCards(cards: readonly TodayCard[]): TodayCard[] {
  const rank = <T extends string>(values: readonly T[], value: T): number => values.indexOf(value);
  return cards.toSorted(
    (a, b) =>
      rank(TODAY_URGENCIES, a.urgency) - rank(TODAY_URGENCIES, b.urgency) ||
      rank(TODAY_CARD_KINDS, a.kind) - rank(TODAY_CARD_KINDS, b.kind),
  );
}
