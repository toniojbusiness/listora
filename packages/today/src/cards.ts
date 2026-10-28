/**
 * The Today screen's card rules (docs/features/today.md): which facts become which cards, how
 * urgent each one is, its one primary action, and the order the cards show in. Pure: the plain
 * queries in summary.ts load the facts, so every rule is tested without a database.
 *
 * A card exists only while its work is not done, so a card disappears by itself once the seller
 * (or Listora) finishes it: a shipped item, a completed delist, a working connection, a reviewed
 * draft. Every card is something the seller can do: Listora's own
 * background problems (sale checks that fail or stall) go to the owner's alerts and the support
 * views, never to Today.
 */
import { DONE_STATES, type DelistResultState, type DelistRunView } from '@listora/auto-delist';
import type { Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { StatusDisplay } from '@listora/operations';
import type { CurrencyCode } from '@listora/shared';

/** In the order the screen groups cards of equal urgency. */
export const TODAY_CARD_KINDS = ['delist', 'ship', 'reconnect', 'review_drafts'] as const;
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
} as const;

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

export interface ReviewDraftsCard extends CardBase {
  kind: 'review_drafts';
  count: number;
  oldestCreatedAt: Date;
}

export type TodayCard = ShipCard | DelistCard | ReconnectCard | ReviewDraftsCard;

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
 * order given (the queries sort each kind: soonest ship-by, oldest delist).
 */
export function orderCards(cards: readonly TodayCard[]): TodayCard[] {
  const rank = <T extends string>(values: readonly T[], value: T): number => values.indexOf(value);
  return cards.toSorted(
    (a, b) =>
      rank(TODAY_URGENCIES, a.urgency) - rank(TODAY_URGENCIES, b.urgency) ||
      rank(TODAY_CARD_KINDS, a.kind) - rank(TODAY_CARD_KINDS, b.kind),
  );
}
