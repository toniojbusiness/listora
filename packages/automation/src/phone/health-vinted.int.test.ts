/**
 * Vinted's session check through the phone runtime (Vinted plan M3): Vinted runs only on the
 * seller's iPhone, so its check is the bundled Vinted scripts in the phone's page backend, in
 * headless Chromium standing in for the app's web view, on the fake Vinted site. It reads the
 * member as the browser runner does, and stops at Vinted's checks for the seller to complete.
 * The import's listings read and the sales history's orders read (M4) run there the same way,
 * from Vinted's web API with the session's own cookies, and so do the offers' read and an answer
 * on its conversation page (M7). The listing scripts (M5) run there in conformance-vinted.
 */
import { afterAll, describe, expect, it } from 'vitest';

import type { AdapterContext } from '@listora/marketplaces';

import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from '../vinted/adapter.ts';
import { FakeVintedSite } from '../vinted/fake/fake-vinted-site.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const connection = { id: 'connection-vinted', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

const [site, unreachable] = await sites(() => FakeVintedSite.start());
const { track, teardown } = suiteSessions(site);
const issuer = { issueSession: () => site.issueSession('Phone.Member') };
const adapter = (siteUrl: string) =>
  createVintedAutomationAdapter({
    siteUrl,
    profile: { ...automationProfile('vinted'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(issuer, 'vinted', siteUrl, 3_000)),
    photos: stubPhotos,
    logger: silentLogger,
  });

describe('Vinted session check on the phone', () => {
  afterAll(teardown, 60_000);

  it('passes and reads the member signed in', async () => {
    expect(await adapter(site.url).healthCheck(ctx())).toEqual({
      status: 'ok',
      sellerId: 'phone.member',
    });
  });

  it('stops at DataDome, which the phone hands to the seller, and keeps the session', async () => {
    site.injectFault({ action: 'health', fault: { type: 'datadome' } });
    // The phone stops for the seller to complete the check themselves (the test host's seller
    // declines), so the check is tried again later; Listora never passes it.
    expect(await adapter(site.url).healthCheck(ctx())).toMatchObject({
      status: 'degraded',
      code: 'stopped_for_check',
    });
  });

  it('reads the listings for sale for an import, and the sold orders for the history', async () => {
    site.items = [
      {
        id: '8101',
        title: 'Invented denim jacket',
        description: 'An invented jacket.',
        priceCents: 4200,
        state: 'active',
        brand: 'Invented Co',
        size: 'M',
        condition: 'Good',
        catalogId: 1,
        colors: ['Black'],
        photos: ['vinted-phone-8101'],
      },
      {
        id: '8102',
        title: 'Invented sold tee',
        description: 'An invented tee.',
        priceCents: 1500,
        state: 'sold',
        brand: null,
        size: null,
        condition: null,
        catalogId: null,
        colors: [],
        photos: [],
      },
    ];
    site.orders = [
      {
        id: '9801',
        paidAt: new Date('2026-10-31T12:00:00.000Z'),
        state: 'completed',
        itemIds: ['8102'],
        priceCents: 1400,
        title: 'Invented sold tee',
      },
    ];
    const phone = adapter(site.url);
    const page = await phone.listListings(null, ctx());
    expect(page).toMatchObject({
      next: null,
      listings: [
        {
          externalListingId: '8101',
          status: 'active',
          priceCents: 4200,
          details: { condition: 'pre_owned_good', colors: ['black'] },
        },
      ],
    });
    const orders = await phone.listOrdersSince(null, ctx());
    expect(orders).toMatchObject([
      {
        externalOrderId: '9801',
        shipped: true,
        items: [{ externalListingId: '8102', priceCents: 1400 }],
      },
    ]);
    // A check (with a since) also reads the canceled orders, so a recorded sale of one no
    // longer stands (M6): the phone hands it over as canceled, with no items.
    site.orders = [
      {
        id: '9802',
        paidAt: new Date('2026-10-31T13:00:00.000Z'),
        state: 'canceled',
        itemIds: ['8102'],
        priceCents: 1400,
        title: 'Invented sold tee',
      },
    ];
    expect(await phone.listOrdersSince(new Date('2026-10-30T00:00:00.000Z'), ctx())).toMatchObject([
      { externalOrderId: '9802', canceled: true, items: [] },
    ]);
  });

  it("reads the buyers' offers from the conversations, and answers one on its conversation page", async () => {
    const offer = site.offers.add({
      listingId: '8101',
      listingTitle: 'Invented denim jacket',
      amountCents: 3000,
      listPriceCents: 4200,
      buyer: 'invented-buyer',
    });
    const ids = site.conversationOf(offer.id);
    const vinted = adapter(site.url);
    const read = await vinted.listOffers(ctx());
    expect(read).toEqual([
      expect.objectContaining({
        externalOfferId: `${ids.id}/${ids.transactionId}`,
        externalListingId: '8101',
        amountCents: 3000,
        listPriceCents: 4200,
        buyerName: 'invented-buyer',
        turn: 'seller',
      }),
    ]);
    const ref = {
      externalOfferId: `${ids.id}/${ids.transactionId}`,
      externalListingId: '8101',
      url: null,
    };
    await expect(
      vinted.answerOffer(
        {
          responseId: 'r1',
          offer: ref,
          answer: 'counter',
          expectedAmountCents: 3000,
          counterCents: 3600,
        },
        ctx(),
      ),
    ).resolves.toEqual({ type: 'sent' });
    await expect(vinted.readOffer(ref, ctx())).resolves.toMatchObject({
      found: true,
      status: 'countered',
      offer: { amountCents: 3600 },
    });
    // The answer only: no message of Listora's own in the conversation.
    expect(site.messages).toEqual([]);
    site.offers.clear();
  });

  it('cannot check a site that does not answer, and keeps the session', async () => {
    expect(await adapter(unreachable).healthCheck(ctx())).toMatchObject({ status: 'degraded' });
  });
});
