/**
 * The offers suite every marketplace's offers run on its fake site (docs/features/offers.md), in
 * a real headless Chromium: reading the buyers' offers as that marketplace's pages carry them,
 * one offer's page, and the seller's answers (accept, decline, counter) sent once, with the
 * page's own refusals, an offer that moved or went away, a send whose answer was lost, a check
 * that stops the read, and a page Listora no longer reads. Accept, decline, and counter are only
 * ever tested here and on recorded pages, never on a real buyer's offer. Tests only.
 */
import { describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  MarketplaceAdapter,
  OfferAnswerRequest,
  RemoteOffer,
} from '@listora/marketplaces';

import type { FakeOffer, FakeOfferDesk } from './fake-offers.ts';

export interface OfferSuiteSetup {
  adapter: MarketplaceAdapter;
  desk: FakeOfferDesk;
  ctx: () => AdapterContext;
  /** A listing id (Poshmark's 24 hex, Depop's slug, Mercari's `m` number) for the n-th offer. */
  listingId: (n: number) => string;
  /** The offer's page, as the list names it. */
  offerUrl: (offerId: string) => string;
  /** Listora's id of the fake's offer (Depop's names its product too). */
  offerId: (offer: FakeOffer) => string;
  /** What else the marketplace's list says of the offer (its listing's title and price). */
  details: (offer: FakeOffer) => Partial<RemoteOffer>;
  /** The next read of the offers meets a bot check. */
  botCheckOnOffers: () => void;
  /** The next offer page is one Listora no longer reads. */
  redesignOfferPage: () => void;
  /** What the adapter puts before a marketplace's own message. */
  name: string;
}

export function offerSuite(title: string, setup: () => OfferSuiteSetup): void {
  describe(title, () => {
    let n = 0;
    const add = (offer: Partial<Parameters<FakeOfferDesk['add']>[0]> = {}) => {
      n += 1;
      return setup().desk.add({ listingId: setup().listingId(n), amountCents: 2000, ...offer });
    };
    const answer = (
      offer: FakeOffer,
      kind: OfferAnswerRequest['answer'],
      counterCents: number | null = null,
    ): OfferAnswerRequest => ({
      responseId: `response-${offer.id}`,
      answer: kind,
      expectedAmountCents: offer.amountCents,
      counterCents,
      offer: ref(offer),
    });
    const ref = (offer: FakeOffer) => ({
      externalOfferId: setup().offerId(offer),
      externalListingId: offer.listingId,
      url: null,
    });
    const sent = () => setup().desk.answers.splice(0);

    it("reads the buyers' offers with their listing, amount, buyer, and expiry, answering none", async () => {
      const { adapter, ctx } = setup();
      const offer = add({
        listingTitle: 'Black tee',
        amountCents: 3000,
        listPriceCents: 4000,
        buyer: 'closetfan',
      });
      const read = await adapter.listOffers?.(ctx());
      expect(read).toContainEqual(
        expect.objectContaining({
          externalOfferId: setup().offerId(offer),
          externalListingId: offer.listingId,
          amountCents: 3000,
          buyerName: 'closetfan',
          turn: 'seller',
          expiresAt: offer.expiresAt,
          url: setup().offerUrl(offer.id),
          ...setup().details(offer),
        }),
      );
      expect(sent()).toEqual([]);
    });

    it('accepts an offer once, and its page then reads accepted', async () => {
      const { adapter, ctx } = setup();
      const offer = add();
      await expect(adapter.answerOffer?.(answer(offer, 'accept'), ctx())).resolves.toEqual({
        type: 'sent',
      });
      expect(sent()).toMatchObject([{ offerId: offer.id, action: 'accept' }]);
      await expect(adapter.readOffer?.(ref(offer), ctx())).resolves.toMatchObject({
        found: true,
        status: 'accepted',
      });
    });

    it("declines, and counters at the seller's price", async () => {
      const { adapter, ctx } = setup();
      const declined = add();
      await expect(adapter.answerOffer?.(answer(declined, 'decline'), ctx())).resolves.toEqual({
        type: 'sent',
      });
      const countered = add({ listPriceCents: 3000 });
      await expect(
        adapter.answerOffer?.(answer(countered, 'counter', 2600), ctx()),
      ).resolves.toEqual({ type: 'sent' });
      expect(sent().map(({ action, counterCents }) => [action, counterCents])).toEqual([
        ['decline', null],
        ['counter', 2600],
      ]);
      await expect(adapter.readOffer?.(ref(countered), ctx())).resolves.toMatchObject({
        found: true,
        status: 'countered',
        offer: { amountCents: 2600 },
      });
    });

    it("passes on the marketplace's refusal, and sends nothing for an offer that moved or went away", async () => {
      const { adapter, ctx, desk, name } = setup();
      const refused = add();
      desk.injectFault({ type: 'refuse', message: 'This offer has expired.' });
      await expect(adapter.answerOffer?.(answer(refused, 'accept'), ctx())).resolves.toEqual({
        type: 'refused',
        code: 'refused',
        message: `${name}: This offer has expired.`,
      });
      const moved = add();
      desk.update(moved.id, { amountCents: 2200 });
      await expect(adapter.answerOffer?.(answer(moved, 'accept'), ctx())).resolves.toMatchObject({
        type: 'refused',
        code: 'amount_changed',
      });
      const gone = add();
      desk.remove(gone.id);
      await expect(adapter.answerOffer?.(answer(gone, 'decline'), ctx())).resolves.toMatchObject({
        type: 'refused',
        code: 'offer_closed',
      });
      await expect(adapter.readOffer?.(ref(gone), ctx())).resolves.toEqual({ found: false });
      expect(sent()).toEqual([]);
    });

    it('reports an answer whose page failed after it was taken as unknown, never as sent', async () => {
      const { adapter, ctx, desk } = setup();
      const offer = add();
      desk.injectFault({ type: 'lost_answer' });
      const outcome = await adapter.answerOffer?.(answer(offer, 'accept'), ctx());
      expect(outcome?.type).toBe('unknown');
      expect(desk.get(offer.id)?.status).toBe('accepted');
      expect(sent()).toHaveLength(1);
    });

    it('stops at a bot check on the offers and never passes it', async () => {
      const { adapter, ctx, botCheckOnOffers } = setup();
      botCheckOnOffers();
      await expect(adapter.listOffers?.(ctx())).rejects.toMatchObject({ code: 'bot_check' });
    });

    it('hands an answer to the seller when the offer page is one Listora no longer reads', async () => {
      const { adapter, ctx, redesignOfferPage } = setup();
      const offer = add();
      redesignOfferPage();
      await expect(adapter.answerOffer?.(answer(offer, 'accept'), ctx())).resolves.toMatchObject({
        type: 'needs_seller',
        code: 'element_missing',
      });
      expect(sent()).toEqual([]);
    });
  });
}
