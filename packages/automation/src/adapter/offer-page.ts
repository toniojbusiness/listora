/**
 * Answering an offer on its own page, and reading that page back (docs/features/offers.md). The
 * same steps on every marketplace, with each one's own selectors (`OfferPageSelectors`):
 *
 * 1. `open the offer` (changes nothing): the offer's page, its amount, and the answer's button.
 *    An offer the page no longer shows, or one at another amount than the seller confirmed, is
 *    refused without anything sent: the buyer moved on, and the seller looks again.
 * 2. For a counter, `enter your counteroffer` (changes nothing): the price in the offer's field.
 * 3. The one step that changes something: the answer's button (and the marketplace's own
 *    confirmation), then the page's answer: a message the marketplace shows refusing it, or the
 *    offer's new state.
 *
 * Only that last step mutates, so a run that stops before it changed nothing and may be sent
 * again, and one that stops in it is only read back. The marketplaces' real offer pages have not
 * been seen with an offer on them (the captain's accounts had none, 2026-10-27), so the selectors
 * are the fake sites' until a session shows one: a page without them stops the run as a page
 * Listora doesn't know (`element_missing`), and the seller answers in the marketplace's app.
 */
import type {
  OfferAnswerRequest,
  OfferRef,
  RemoteOfferState,
  RemoteOffer,
} from '@listora/marketplaces';

import { PageChangedError } from '../runner/errors.ts';
import type { PageDriver, StepRunner } from '../runner/types.ts';
import { dollarsToCents } from './offer-fields.ts';
import type { OfferAnswerResult } from './script-call.ts';

export interface OfferPageSelectors {
  /** The offer's current price. */
  amount: string;
  /** Where the page says whose turn it is or how it was answered. */
  status: string;
  /** What the page shows for an offer it no longer has. */
  gone: string;
  accept: string;
  decline: string;
  counter: string;
  counterInput: string;
  /** The marketplace's own confirmation of the answer (a dialog's button). */
  confirm: string;
  /** A message the marketplace shows refusing the answer. */
  error: string;
  /** Optional details the page shows. */
  buyer?: string;
  title?: string;
  listPrice?: string;
  expires?: string;
}

/**
 * The offer page's selectors as the fake sites draw it (fake-offers/), which each marketplace's
 * page module uses until a real offer page is read with an offer on it.
 */
export const DEFAULT_OFFER_PAGE: OfferPageSelectors = {
  amount: '[data-testid="offer-amount"]',
  status: '[data-testid="offer-status"]',
  gone: '[data-testid="offer-gone"]',
  accept: '[data-testid="offer-accept"]',
  decline: '[data-testid="offer-decline"]',
  counter: '[data-testid="offer-counter"]',
  counterInput: '[data-testid="offer-counter-price"]',
  confirm: '[data-testid="offer-confirm"]',
  error: '[data-testid="offer-error"]',
  buyer: '[data-testid="offer-buyer"]',
  title: '[data-testid="offer-title"]',
  listPrice: '[data-testid="offer-list-price"]',
  expires: '[data-testid="offer-expires"]',
};

/** What one marketplace's offer pages are. */
export interface OfferPages {
  name: string;
  selectors: OfferPageSelectors;
  /** The offer's page, from its reference (its URL, or its id). */
  url: (ref: OfferRef) => string;
}

const STATUS_WORDS: readonly [RegExp, Extract<RemoteOfferState, { found: true }>['status']][] = [
  [/\baccepted\b/i, 'accepted'],
  [/\bdeclined\b/i, 'declined'],
  [/\bcounter(ed|offer sent)\b/i, 'countered'],
  [/\b(pending|waiting on you|respond|awaiting your response)\b/i, 'pending'],
];

/** The offer as its page shows it now. Only reads. */
export async function readOfferPage(
  page: PageDriver,
  pages: OfferPages,
  ref: OfferRef,
): Promise<RemoteOfferState> {
  await page.goto(pages.url(ref));
  const { selectors } = pages;
  if (await page.exists(selectors.gone)) return { found: false };
  const statusText = await page.text(selectors.status);
  const status = STATUS_WORDS.find(([words]) => words.test(statusText ?? ''))?.[1];
  const amountCents = dollarsToCents(await page.text(selectors.amount));
  if (status === undefined || amountCents === null) {
    throw new PageChangedError(`${pages.name}'s offer page shows no offer Listora can read`);
  }
  const optional = async (selector: string | undefined): Promise<string | null> =>
    selector === undefined ? null : nonEmpty((await page.text(selector))?.trim());
  const expires = await optional(selectors.expires);
  const offer: RemoteOffer = {
    externalOfferId: ref.externalOfferId,
    externalListingId: ref.externalListingId,
    listingTitle: (await optional(selectors.title))?.slice(0, 200) ?? null,
    amountCents,
    listPriceCents: dollarsToCents(await optional(selectors.listPrice)),
    buyerName: (await optional(selectors.buyer))?.slice(0, 100) ?? null,
    turn: status === 'pending' ? 'seller' : 'buyer',
    madeAt: null,
    expiresAt:
      expires === null || Number.isNaN(Date.parse(expires))
        ? null
        : new Date(expires).toISOString(),
    url: pages.url(ref),
    listingCount: null,
    shippingCents: null,
  };
  return { found: true, offer, status };
}

const ACTION_STEP = {
  accept: 'accept the offer',
  decline: 'decline the offer',
  counter: 'send the counteroffer',
} as const;

/** Sends the seller's answer on the offer's page (the steps above). */
export async function answerOnOfferPage(
  step: StepRunner,
  pages: OfferPages,
  request: OfferAnswerRequest,
): Promise<OfferAnswerResult> {
  const { selectors } = pages;
  const button = selectors[request.answer];
  const opened = await step('open the offer', { mutates: false }, async (page) => {
    const shown = await readOfferPage(page, pages, request.offer);
    if (!shown.found || shown.status !== 'pending') return shown;
    if (!(await page.exists(button))) {
      throw new PageChangedError(`${pages.name}'s offer page has no button for that answer`);
    }
    return shown;
  });
  if (!opened.found || opened.status !== 'pending') {
    return {
      type: 'refused',
      code: 'offer_closed',
      message: `This offer no longer waits for you on ${pages.name}.`,
    };
  }
  if (opened.offer.amountCents !== request.expectedAmountCents) {
    return {
      type: 'refused',
      code: 'amount_changed',
      message: `The buyer changed this offer on ${pages.name}. Look at the new amount before you answer.`,
    };
  }
  if (request.answer === 'counter') {
    const counterCents = request.counterCents;
    if (counterCents === null) throw new Error('a counteroffer needs a price');
    await step('enter your counteroffer', { mutates: false }, async (page) => {
      await page.click(selectors.counter);
      await page.fill(selectors.counterInput, priceText(counterCents));
    });
  }
  return step(ACTION_STEP[request.answer], { mutates: true }, async (page) => {
    if (request.answer !== 'counter') await page.click(button);
    await page.click(selectors.confirm);
    await page.waitFor(`${selectors.status}, ${selectors.error}, ${selectors.gone}`);
    if (await page.exists(selectors.error)) {
      const message = (await page.text(selectors.error))?.trim() ?? '';
      return {
        type: 'refused',
        code: 'refused',
        message: message === '' ? `${pages.name} didn't take your answer.` : message.slice(0, 500),
      };
    }
    return { type: 'applied' };
  });
}

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text === '' ? null : text;
}

/** "35.00": how a price field takes a price. */
function priceText(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}
