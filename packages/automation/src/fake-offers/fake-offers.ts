/**
 * Offers on the fake marketplaces (docs/features/offers.md): the buyers' offers a fake site holds
 * for its seller, the offer page every fake shows (amount, status, Accept, Decline, Counter, the
 * confirmation), and the answers it took, with faults. Each fake serves the list of offers in its
 * own marketplace's data (Poshmark's embedded state, Depop's web API, Mercari's page data) and
 * this page at its own path.
 *
 * Accept, decline, and counter are only ever tested here and on recorded pages, never on a real
 * buyer's offer. Development and tests only.
 */
import { escape } from '../fake-site/http.ts';

export type FakeOfferStatus = 'pending' | 'accepted' | 'declined' | 'countered';

export interface FakeOffer {
  id: string;
  listingId: string;
  listingTitle: string;
  /** The offer's current price: the buyer's while pending, the seller's once countered. */
  amountCents: number;
  listPriceCents: number;
  buyer: string;
  status: FakeOfferStatus;
  createdAt: string;
  expiresAt: string;
  shippingCents: number | null;
  /**
   * An offer the seller sent (Depop's offers to likers, `SENT_PRIVATE_OFFER`): it waits on the
   * buyer and never on the seller.
   */
  sentBySeller?: boolean;
}

/** What the next answer meets. */
export type FakeOfferFault =
  /** The marketplace refuses it with a message on the page. */
  | { type: 'refuse'; message: string }
  /** The answer is taken, but the page after it fails (the seller's side can't tell). */
  | { type: 'lost_answer' }
  /** The page fails before anything is taken. */
  | { type: 'server_error' };

export interface FakeOfferAnswer {
  offerId: string;
  action: 'accept' | 'decline' | 'counter';
  counterCents: number | null;
  at: number;
}

export class FakeOfferDesk {
  readonly #offers = new Map<string, FakeOffer>();
  readonly #faults: FakeOfferFault[] = [];
  /** Every answer the fake took, in order: what tests check was sent, and how often. */
  readonly answers: FakeOfferAnswer[] = [];
  #next = 1;

  /** A buyer makes an offer on one of the seller's listings. */
  add(offer: Partial<FakeOffer> & Pick<FakeOffer, 'listingId' | 'amountCents'>): FakeOffer {
    const now = Date.now();
    const made: FakeOffer = {
      id: offer.id ?? `offer${String(this.#next++).padStart(4, '0')}`,
      listingTitle: 'A listing',
      listPriceCents: offer.amountCents + 1000,
      buyer: 'buyer1',
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 24 * 3_600_000).toISOString(),
      shippingCents: null,
      ...offer,
    };
    this.#offers.set(made.id, made);
    return made;
  }

  get(id: string): FakeOffer | undefined {
    return this.#offers.get(id);
  }

  /** The buyer changes their offer, or answers the seller's counter with another price. */
  update(id: string, change: Partial<Omit<FakeOffer, 'id'>>): void {
    const offer = this.#offers.get(id);
    if (offer !== undefined) this.#offers.set(id, { ...offer, ...change });
  }

  /** The offer goes away (it expired, or the buyer withdrew it). */
  remove(id: string): void {
    this.#offers.delete(id);
  }

  /** Every offer the fake holds, answered or not. */
  all(): FakeOffer[] {
    return [...this.#offers.values()];
  }

  /** Offers the seller's list shows: pending ones and ones waiting on the buyer. */
  list(): FakeOffer[] {
    return [...this.#offers.values()].filter(
      (offer) => offer.status === 'pending' || offer.status === 'countered',
    );
  }

  /** Forgets every offer, answer, and fault (between tests on one fake). */
  clear(): void {
    this.#offers.clear();
    this.#faults.length = 0;
    this.answers.length = 0;
  }

  injectFault(fault: FakeOfferFault): void {
    this.#faults.push(fault);
  }

  /** The seller's answer from the offer page's form. */
  answer(
    id: string,
    action: string,
    counter: string | null,
  ): { status: 303; offerId: string } | { status: 422 | 404 | 500; message: string } {
    const offer = this.#offers.get(id);
    if (offer === undefined) return { status: 404, message: 'This offer is no longer available.' };
    const fault = this.#faults.shift();
    if (fault?.type === 'server_error') return { status: 500, message: 'Something went wrong.' };
    if (fault?.type === 'refuse') return { status: 422, message: fault.message };
    if (offer.status !== 'pending' || offer.sentBySeller === true) {
      return { status: 422, message: 'This offer has already been answered.' };
    }
    let counterCents: number | null = null;
    if (action === 'counter') {
      counterCents = priceCents(counter);
      if (counterCents === null || counterCents <= offer.amountCents) {
        return { status: 422, message: 'Your counteroffer must be more than the offer.' };
      }
      if (counterCents >= offer.listPriceCents) {
        return { status: 422, message: 'Your counteroffer must be less than your price.' };
      }
    } else if (action !== 'accept' && action !== 'decline') {
      return { status: 422, message: 'Choose an answer.' };
    }
    const answer = action;
    this.answers.push({ offerId: id, action: answer, counterCents, at: Date.now() });
    this.#offers.set(id, {
      ...offer,
      status: answer === 'accept' ? 'accepted' : answer === 'decline' ? 'declined' : 'countered',
      ...(counterCents === null ? {} : { amountCents: counterCents }),
    });
    if (fault?.type === 'lost_answer') return { status: 500, message: 'Something went wrong.' };
    return { status: 303, offerId: id };
  }
}

const STATUS_WORDS: Record<FakeOfferStatus, string> = {
  pending: 'Pending - waiting on you',
  accepted: 'Accepted',
  declined: 'Declined',
  countered: 'Countered - waiting on the buyer',
};

/**
 * The body of an offer's page at `path` (`/offers/<id>`): the offer, its answer buttons, and,
 * with `confirm`, the confirmation of that answer (and the counteroffer's price field). Plain
 * forms, no scripts. `error` is a refusal the page shows.
 */
export function fakeOfferPageBody(
  offer: FakeOffer | undefined,
  path: string,
  confirm: string | null,
  error: string | null = null,
): string {
  if (offer === undefined) {
    return '<main><p data-testid="offer-gone">This offer is no longer available.</p></main>';
  }
  const answers =
    offer.status === 'pending' && offer.sentBySeller !== true
      ? `<nav>
<a data-testid="offer-accept" href="${path}?confirm=accept">Accept</a>
<a data-testid="offer-decline" href="${path}?confirm=decline">Decline</a>
<a data-testid="offer-counter" href="${path}?confirm=counter">Counter</a>
</nav>`
      : '';
  const confirmation =
    offer.status === 'pending' &&
    (confirm === 'accept' || confirm === 'decline' || confirm === 'counter')
      ? `<form method="post" action="${path}/answer" data-testid="offer-confirmation">
<input type="hidden" name="action" value="${confirm}">
${confirm === 'counter' ? '<label>Your price <input name="counter" data-testid="offer-counter-price" inputmode="decimal"></label>' : ''}
<button type="submit" data-testid="offer-confirm">${confirm === 'accept' ? 'Accept offer' : confirm === 'decline' ? 'Decline offer' : 'Send counteroffer'}</button>
</form>`
      : '';
  return `<main data-testid="offer">
<h1 data-testid="offer-title">${escape(offer.listingTitle)}</h1>
<p>From <span data-testid="offer-buyer">${escape(offer.buyer)}</span></p>
<p>Offer <span data-testid="offer-amount">$${dollars(offer.amountCents)}</span>
of <span data-testid="offer-list-price">$${dollars(offer.listPriceCents)}</span></p>
<p data-testid="offer-status">${STATUS_WORDS[offer.status]}</p>
<p>Expires <time data-testid="offer-expires">${escape(offer.expiresAt)}</time></p>
${error === null ? '' : `<p role="alert" data-testid="offer-error">${escape(error)}</p>`}
${answers}
${confirmation}
</main>`;
}

function dollars(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

function priceCents(text: string | null): number | null {
  const match = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec((text ?? '').trim());
  return match === null ? null : Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
