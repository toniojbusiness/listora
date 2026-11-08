/**
 * Vinted's offers on the fake Vinted site (Vinted plan M7), in a real headless Chromium: the
 * shared offers suite (fake-offers/offers-suite.ts) on Vinted's conversations, then what differs
 * on Vinted: offers live in conversations, a conversation about an item the member bought or
 * about no sale holds none of the seller's, a bundle's offer covers several listings, Vinted's
 * 40% floor refuses a counteroffer below it, Listora never sends a message in a conversation, and
 * an answer on a session signed in as another member changes nothing. No traffic goes to Vinted,
 * and never a real buyer's offer: the pages are invented until the mapping (M2) records them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterContext, OfferAnswerRequest } from '@listora/marketplaces';

import type { FakeOffer } from '../fake-offers/fake-offers.ts';
import { offerSuite } from '../fake-offers/offers-suite.ts';
import { SELLER_MISMATCH } from '../adapter/script-call.ts';
import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from './adapter.ts';
import { FakeVintedSite } from './fake/fake-vinted-site.ts';
import { vintedOfferId } from './pages/offers.ts';

const SELLER = 'vinted-test.shop';
const connection = { id: 'connection-vinted', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('Vinted offers (headless Chromium, fake Vinted)', () => {
  let site: FakeVintedSite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createVintedAutomationAdapter>;
  /** The login the next session is signed in as. */
  let login = SELLER;
  let nextItem = 7_500_000_000;

  beforeAll(async () => {
    site = await FakeVintedSite.start(0);
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: 5_000,
    });
    const profile = { ...automationProfile('vinted'), pacing: QUICK_PACING };
    sessions = new FakeSiteSessions({ issueSession: () => site.issueSession(login) }, runner, {
      ...profile,
      origins: [site.url],
      apiOrigins: [site.url],
      cookieDomains: ['127.0.0.1'],
    });
    adapter = createVintedAutomationAdapter({
      siteUrl: site.url,
      profile,
      sessions,
      photos: stubPhotos,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    site.clearFaults();
    sessions.challenges.length = 0;
    login = SELLER;
    site.offerStatusOverride = null;
    site.chats = 0;
    // Listora never sends a message of its own in a Vinted conversation, whatever it answered.
    expect(site.messages).toEqual([]);
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  const listingId = (): string => {
    nextItem += 1;
    return String(nextItem);
  };
  const offerId = (offer: FakeOffer): string => {
    const ids = site.conversationOf(offer.id);
    return vintedOfferId(ids.id, ids.transactionId);
  };
  const ref = (offer: FakeOffer) => ({
    externalOfferId: offerId(offer),
    externalListingId: offer.listingId,
    url: null,
  });
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

  it('reads no offers from an empty inbox, or from conversations about no sale', async () => {
    site.offers.clear();
    await expect(adapter.listOffers(ctx())).resolves.toEqual([]);
    site.chats = 2;
    await expect(adapter.listOffers(ctx())).resolves.toEqual([]);
  });

  it('asks to link Vinted again when its pages are drawn for a visitor, not a timeout', async () => {
    // The captain's phone, 2026-11-08: "Stopped at read your conversations: the step took too
    // long", on a session Vinted had signed out.
    site.injectFault({ action: 'health', fault: { type: 'signed_out' } });
    await expect(adapter.listOffers(ctx())).rejects.toMatchObject({ code: 'session_rejected' });
    expect(sessions.challenges).toEqual(['session_rejected']);
  });

  offerSuite('the offers suite', () => ({
    adapter,
    desk: site.offers,
    ctx,
    listingId: () => listingId(),
    offerUrl: (id) => `${site.url}/inbox/${site.conversationOf(id).id}`,
    offerId,
    // Vinted's offers name the listing's price, and no expiry Listora has read.
    details: (offer) => ({
      listingTitle: offer.listingTitle,
      listPriceCents: offer.listPriceCents,
      expiresAt: null,
    }),
    botCheckOnOffers: () => {
      site.injectFault({ action: 'offers', fault: { type: 'datadome_api' } });
    },
    // Vinted's DataDome stops a run as a CAPTCHA (docs/features/vinted.md).
    botCheckCode: 'captcha',
    redesignOfferPage: () => {
      site.injectFault({ action: 'conversation_page', fault: { type: 'redesigned' } });
    },
    name: 'Vinted',
  }));

  it("never reads an offer in a conversation about an item the member bought, or one waiting on the buyer, as the seller's", async () => {
    site.offers.clear();
    const bought = site.offers.add({ listingId: listingId(), amountCents: 1500 });
    site.boughtByMember.add(bought.id);
    site.offers.add({ listingId: listingId(), amountCents: 1600, sentBySeller: true });
    const waiting = site.offers.add({ listingId: listingId(), amountCents: 1700 });
    const read = await adapter.listOffers(ctx());
    expect(read.map((offer) => offer.externalOfferId)).toEqual([offerId(waiting)]);
    site.boughtByMember.clear();
    site.offers.clear();
  });

  it("reads a bundle's offer as covering its listings, with no one listing", async () => {
    site.offers.clear();
    const offer = site.offers.add({
      listingId: listingId(),
      amountCents: 3000,
      listPriceCents: 4200,
    });
    site.bundles.set(offer.id, [offer.listingId, listingId(), listingId()]);
    const read = await adapter.listOffers(ctx());
    expect(read).toEqual([
      expect.objectContaining({ externalListingId: null, listingCount: 3, amountCents: 3000 }),
    ]);
    site.bundles.clear();
    site.offers.clear();
  });

  it("stops at an offer status Listora doesn't know rather than guess whose turn it is", async () => {
    site.offers.clear();
    site.offers.add({ listingId: listingId(), amountCents: 1500 });
    site.offerStatusOverride = 'on_hold';
    await expect(adapter.listOffers(ctx())).rejects.toMatchObject({ code: 'element_missing' });
    site.offers.clear();
  });

  it("passes on Vinted's refusal of a counteroffer below its 40% floor", async () => {
    // The server refuses such a counter before it reaches the phone (offers/answer.ts); this is
    // Vinted's own refusal, read from its conversation page.
    const offer = site.offers.add({
      listingId: listingId(),
      amountCents: 3000,
      listPriceCents: 5000,
    });
    site.offers.update(offer.id, { amountCents: 2000 });
    const outcome = await adapter.answerOffer(
      { ...answer(offer, 'counter', 2500), expectedAmountCents: 2000 },
      ctx(),
    );
    expect(outcome).toEqual({
      type: 'refused',
      code: 'refused',
      message: "Vinted: Offers can't be lower than $30.00.",
    });
    expect(site.offers.answers.splice(0)).toEqual([]);
  });

  it('changes nothing when the session is signed in as another member than the linked one', async () => {
    const offer = site.offers.add({ listingId: listingId(), amountCents: 2000 });
    login = 'someone-else';
    const outcome = await adapter.answerOffer(answer(offer, 'accept'), {
      ...ctx(),
      connection: { ...connection, sellerId: SELLER },
    });
    expect(outcome).toMatchObject({ type: 'refused', code: SELLER_MISMATCH });
    expect(site.offers.answers.splice(0)).toEqual([]);
    expect(site.offers.get(offer.id)?.status).toBe('pending');
  });

  it("answers on the linked member's session, after reading who is signed in", async () => {
    const offer = site.offers.add({ listingId: listingId(), amountCents: 2000 });
    const outcome = await adapter.answerOffer(answer(offer, 'decline'), {
      ...ctx(),
      connection: { ...connection, sellerId: SELLER },
    });
    expect(outcome).toEqual({ type: 'sent' });
    expect(site.offers.answers.splice(0)).toMatchObject([{ offerId: offer.id, action: 'decline' }]);
    await expect(adapter.readOffer(ref(offer), ctx())).resolves.toMatchObject({
      found: true,
      status: 'declined',
    });
  });

  it('reads an offer whose conversation is gone, or that is another sale now, as no longer there', async () => {
    const offer = site.offers.add({ listingId: listingId(), amountCents: 2000 });
    const ids = site.conversationOf(offer.id);
    await expect(
      adapter.readOffer({ ...ref(offer), externalOfferId: vintedOfferId(ids.id, '1') }, ctx()),
    ).resolves.toEqual({ found: false });
    await expect(
      adapter.readOffer({ ...ref(offer), externalOfferId: 'not-an-id' }, ctx()),
    ).resolves.toEqual({ found: false });
    site.offers.remove(offer.id);
    await expect(adapter.readOffer(ref(offer), ctx())).resolves.toEqual({ found: false });
  });

  it('reads the offers and answers only with GETs and the answer itself', async () => {
    site.offers.clear();
    const offer = site.offers.add({ listingId: listingId(), amountCents: 2000 });
    const from = site.requests.length;
    await adapter.listOffers(ctx());
    expect(site.requests.slice(from).every((request) => request.method === 'GET')).toBe(true);
    const before = site.requests.length;
    await adapter.answerOffer(answer(offer, 'accept'), ctx());
    expect(
      site.requests
        .slice(before)
        .filter((request) => request.method !== 'GET')
        .map((request) => request.path),
    ).toEqual([`/inbox/${site.conversationOf(offer.id).id}/offer`]);
    site.offers.answers.splice(0);
    site.offers.clear();
  });
});
