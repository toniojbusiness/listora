/**
 * Offers (docs/features/offers.md): what an adapter reads of the offers buyers made on the
 * seller's listings, and how it answers one. Reading only reads. An answer (accept, decline,
 * counter) is sent only for the seller's own confirmed tap, and counts as done only when a
 * read of the offer afterwards shows it.
 *
 * Every member is JSON-safe (times are ISO strings), since the phone runs the scripts that read
 * and answer offers and its answers cross the API.
 */
import type { Marketplace } from '@listora/db';

/** Whose turn an offer is, as the marketplace shows it. */
export type OfferTurn = 'seller' | 'buyer';

/** One offer on one of the seller's listings, as the marketplace showed it. */
export interface RemoteOffer {
  /** The marketplace's id for the offer (or its conversation, where offers live in one). */
  externalOfferId: string;
  /** The listing it is for, when the marketplace says. */
  externalListingId: string | null;
  listingTitle: string | null;
  /** The offer's latest price, in cents (USD): the buyer's while it waits on the seller. */
  amountCents: number;
  /** The listing's price when the offer was made, when shown. */
  listPriceCents: number | null;
  /** The buyer's public username on the marketplace, as the offer shows it. */
  buyerName: string | null;
  /** `seller`: the offer waits on the seller; `buyer`: the seller answered and it waits on them. */
  turn: OfferTurn;
  /** ISO times, when the marketplace shows them. */
  madeAt: string | null;
  expiresAt: string | null;
  /** The page where the seller answers it on the marketplace. */
  url: string | null;
  /** How many listings it covers (a Poshmark bundle), when more than one. */
  listingCount: number | null;
  /** What the buyer pays for shipping under the offer, in cents, when the offer says. */
  shippingCents: number | null;
}

/** The answers Listora can send to an offer. */
export type OfferAnswer = 'accept' | 'decline' | 'counter';

/** Which offer an answer or a read is about. */
export interface OfferRef {
  externalOfferId: string;
  externalListingId: string | null;
  url: string | null;
}

/** The seller's answer to send: one send per tap (`responseId`). */
export interface OfferAnswerRequest {
  /** Listora's `offer_response.id`, for the adapter's records. */
  responseId: string;
  offer: OfferRef;
  answer: OfferAnswer;
  /** The offer's amount the seller saw when they confirmed: an answer to another amount stops. */
  expectedAmountCents: number;
  /** The seller's price, for a counter. */
  counterCents: number | null;
}

/** What a read of one offer found. */
export type RemoteOfferState =
  /** The marketplace no longer shows it (expired, withdrawn, or sold). */
  | { found: false }
  | {
      found: true;
      offer: RemoteOffer;
      /** `pending`: it waits on the seller; the others are how it was answered. */
      status: 'pending' | 'accepted' | 'declined' | 'countered';
    };

/**
 * How an answer's send ended. `sent` is only the marketplace taking it; the answer is done only
 * when a read of the offer shows it.
 */
export type OfferAnswerOutcome =
  | { type: 'sent' }
  /** The marketplace refused it (the offer moved on, a counter out of range). */
  | { type: 'refused'; code: string; message: string }
  /** It failed before anything was sent: safe to send again. */
  | { type: 'not_sent'; code: string; message: string; retryAfterMs?: number }
  /** It may have reached the marketplace: only a read of the offer can tell. */
  | { type: 'unknown'; code: string; message: string }
  /** A check automation must not pass, or a page Listora no longer reads: the seller answers. */
  | { type: 'needs_seller'; code: string; message: string };

/** What each marketplace allows of an answer, and what accepting does there. */
export interface OfferRules {
  counter: boolean;
  /**
   * `sale`: accepting sells the listing at once (the buyer paid when they offered);
   * `buyer_checkout`: the buyer then buys at that price within the marketplace's window.
   */
  accept: 'sale' | 'buyer_checkout';
  /** In the seller's words, what accepting does there. */
  acceptNote: string;
}

/**
 * The marketplaces whose offers Listora reads and answers, and their rules. Not Mercari yet: its
 * website showed the captain's session no page of the offers buyers make (2026-10-27), and its
 * sellers answer offers in its app (docs/features/offers.md, open items).
 */
/** The marketplaces whose offers Listora reads and answers. */
export type OfferMarketplace = Extract<Marketplace, 'poshmark' | 'depop'>;

export const OFFER_RULES: Readonly<Record<OfferMarketplace, OfferRules>> = {
  poshmark: {
    counter: true,
    accept: 'sale',
    acceptNote: 'Accepting sells it now: the buyer already paid when they made the offer.',
  },
  depop: {
    counter: true,
    accept: 'buyer_checkout',
    acceptNote: 'Accepting lets the buyer buy it at this price; it sells once they check out.',
  },
};

export function isOfferMarketplace(marketplace: Marketplace): marketplace is OfferMarketplace {
  return Object.hasOwn(OFFER_RULES, marketplace);
}

/** Whether a read of the offer shows the answer took effect. */
export function answerShown(
  request: Pick<OfferAnswerRequest, 'answer' | 'counterCents'>,
  state: RemoteOfferState,
): boolean {
  if (!state.found) return false;
  switch (request.answer) {
    case 'accept':
      return state.status === 'accepted';
    case 'decline':
      return state.status === 'declined';
    case 'counter':
      return state.status === 'countered' && state.offer.amountCents === request.counterCents;
  }
}
