/**
 * Offers (docs/features/offers.md) from marketplace data Listora has only seen empty: the
 * captain's Poshmark, Mercari, and Depop accounts had no offer when their pages were read
 * (2026-10-27). So an offer's record is read by field names that say what a value is
 * (`offer_id`, the buyer's `username`, `expires_at`), and nothing else: a value is never taken
 * by its position or its look. A record that names no offer id or no amount is a shape Listora
 * doesn't know, and the page module throws `PageChangedError` for it; an offer is never guessed.
 */
import type { OfferTurn, RemoteOffer } from '@listora/marketplaces';

import { fieldValues, texts } from './label-fields.ts';

/** How one marketplace names an offer's fields, besides the common names below. */
export interface OfferFieldNames {
  /** The listing it is for (`post_id`, the product's `slug`). */
  listing: readonly string[];
  /** Reads a money value the way the marketplace writes it, in cents, or `null`. */
  money: (value: unknown) => number | null;
  /** The marketplace's word for an offer waiting on the seller, by its status field. */
  turn: (record: Readonly<Record<string, unknown>>) => OfferTurn | null;
  /** The offer's page on the marketplace, from its record. */
  url: (record: Readonly<Record<string, unknown>>, id: string) => string | null;
}

const ID = ['offer_id', 'offerId'];
const AMOUNT = ['offer_amount', 'offerAmount', 'offer_price', 'offerPrice'];
const LIST_PRICE = ['listing_price', 'listingPrice', 'list_price', 'listPrice', 'original_price'];
const SHIPPING = ['shipping_price', 'shippingPrice', 'buyer_shipping', 'shipping_fee'];
const TITLE = ['listing_title', 'listingTitle', 'title', 'name'];
const BUYER = ['buyer', 'offerer', 'from_user', 'sender'];
const USERNAME = ['username', 'user_name', 'userName', 'display_handle', 'handle'];
const MADE = ['created_at', 'createdAt', 'offered_at', 'offeredAt'];
const EXPIRES = ['expires_at', 'expiresAt', 'expiration_time', 'expirationTime', 'expiry'];
const COUNT = ['listing_count', 'listingCount', 'item_count', 'itemCount'];

/**
 * The offer a record names, or `null` when it names no offer id or amount (a shape Listora
 * doesn't know: the caller throws `PageChangedError`).
 */
export function offerOf(
  record: Readonly<Record<string, unknown>>,
  names: OfferFieldNames,
): RemoteOffer | null {
  const id = texts([...direct(record, ID), record['id']])[0];
  const amountCents = firstMoney(direct(record, AMOUNT), names);
  const turn = names.turn(record);
  if (id === undefined || amountCents === null || amountCents <= 0 || turn === null) return null;
  const buyer = BUYER.map((key) => record[key]).find((value) => value !== undefined);
  return {
    externalOfferId: id.slice(0, 255),
    externalListingId: texts(fieldValues(record, names.listing))[0] ?? null,
    listingTitle: texts(direct(record, TITLE))[0]?.slice(0, 200) ?? null,
    amountCents,
    listPriceCents: positive(firstMoney(direct(record, LIST_PRICE), names)),
    buyerName: texts(fieldValues(buyer, USERNAME))[0]?.slice(0, 100) ?? null,
    turn,
    madeAt: time(direct(record, MADE)),
    expiresAt: time(direct(record, EXPIRES)),
    url: names.url(record, id),
    listingCount: count(direct(record, COUNT)),
    shippingCents: firstMoney(direct(record, SHIPPING), names),
  };
}

/** The values of `keys` on the record itself (not nested records: those are other things). */
function direct(record: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown[] {
  return keys.map((key) => record[key]).filter((value) => value !== undefined && value !== null);
}

function firstMoney(values: readonly unknown[], names: OfferFieldNames): number | null {
  for (const value of values) {
    const cents = names.money(value);
    if (cents !== null && Number.isSafeInteger(cents) && cents >= 0) return cents;
  }
  return null;
}

function positive(cents: number | null): number | null {
  return cents !== null && cents > 0 ? cents : null;
}

function count(values: readonly unknown[]): number | null {
  const found = values.find((value) => typeof value === 'number' && Number.isSafeInteger(value));
  return typeof found === 'number' && found > 1 ? Math.min(found, 500) : null;
}

/** An ISO time from a time string or a Unix time in seconds or milliseconds. */
function time(values: readonly unknown[]): string | null {
  for (const value of values) {
    const date =
      typeof value === 'string'
        ? new Date(value)
        : typeof value === 'number'
          ? new Date(value < 1e12 ? value * 1000 : value)
          : null;
    if (date !== null && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/** A price written as dollars: `"12.50"`, `12.5`, or `{ amount: "12.50" }` / `{ val: "12.50" }`. */
export function dollarsToCents(value: unknown): number | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return dollarsToCents(record['amount'] ?? record['val'] ?? record['value']);
  }
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  if (text === null) return null;
  const match = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
