/**
 * Depop's offers on the fake Depop site (the shared offers suite, fake-offers/offers-suite.ts):
 * the Offers page's web API, an offer's page, and the seller's answers, in a real headless
 * Chromium. No real Depop traffic, and never a real buyer's offer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { offerSuite } from '../fake-offers/offers-suite.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createDepopAutomationAdapter } from './adapter.ts';
import { DEPOP_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import { FakeDepopSite } from './fake/fake-depop-site.ts';

describe('Depop offers (headless Chromium, fake Depop)', () => {
  let site: FakeDepopSite;
  let runner: PlaywrightBrowserRunner;
  let adapter: ReturnType<typeof createDepopAutomationAdapter>;
  const connection = { id: 'connection-depop', mode: 'automation', status: 'connected' } as const;
  const ctx = () => ({ signal: new AbortController().signal, connection });

  beforeAll(async () => {
    site = await FakeDepopSite.start(0);
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: DEPOP_STEP_TIMEOUT_MS,
    });
    const profile = { ...automationProfile('depop'), pacing: QUICK_PACING };
    adapter = createDepopAutomationAdapter({
      siteUrl: site.url,
      profile,
      sessions: new FakeSiteSessions(site, runner, standInProfile(profile, site.url)),
      photos: stubPhotos,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    site.clearFaults();
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  it('reads no offers when the Offers page has none', async () => {
    await expect(adapter.listOffers(ctx())).resolves.toEqual([]);
  });

  it("never reads the seller's own offers to likers, or an accepted one, as waiting on her", async () => {
    site.offers.clear();
    const slug = site.seed({ description: 'Wool scarf', priceCents: 1600 });
    for (let n = 0; n < 12; n += 1) {
      site.offers.add({
        listingId: slug,
        amountCents: 1440,
        sentBySeller: true,
        buyer: `liker${String(n)}`,
      });
    }
    const accepted = site.offers.add({ listingId: slug, amountCents: 1290 });
    site.offers.update(accepted.id, { status: 'accepted' });
    await expect(adapter.listOffers(ctx())).resolves.toEqual([]);
    const received = site.offers.add({ listingId: slug, amountCents: 1300, buyer: 'scarffan' });
    const read = await adapter.listOffers(ctx());
    expect(read.map((offer) => [offer.amountCents, offer.buyerName, offer.turn])).toEqual([
      [received.amountCents, 'scarffan', 'seller'],
    ]);
    site.offers.clear();
  });

  it('reads the offers through a server error the web API answers for a moment', async () => {
    // As a real phone's read met on 2026-10-29: one 500 among its reads ended the whole read.
    site.offers.clear();
    const slug = site.seed({ description: 'Corduroy cap', priceCents: 2400 });
    const offer = site.offers.add({ listingId: slug, amountCents: 1800, buyer: 'capfan' });
    site.inject({ action: 'offers', fault: { type: 'server_error' } });
    const read = await adapter.listOffers(ctx());
    expect(read.map((shown) => [shown.amountCents, shown.buyerName])).toEqual([
      [offer.amountCents, 'capfan'],
    ]);

    site.offers.clear();
  });

  it("stops at an offer status Listora doesn't know rather than guess whose it is", async () => {
    const slug = site.seed({ description: 'Wool hat', priceCents: 2000 });
    site.offers.add({ listingId: slug, amountCents: 1500 });
    site.offerStatusOverride = 'SOMETHING_NEW';
    await expect(adapter.listOffers(ctx())).rejects.toMatchObject({ code: 'element_missing' });
    site.offerStatusOverride = null;
    site.offers.clear();
  });

  offerSuite('the offers suite', () => ({
    adapter,
    desk: site.offers,
    ctx,
    listingId: (n) => site.seed({ description: `Black tee ${String(n)}`, priceCents: 4000 }),
    offerUrl: () => `${site.url}/sellinghub/offers/`,
    offerId: (offer) => `${String(site.productId(offer.listingId))}//${offer.id}`,
    details: (offer) => ({ listingTitle: site.product(offer.listingId)?.description ?? null }),
    botCheckOnOffers: () => {
      site.inject({ action: 'offers', fault: { type: 'bot_check' } });
    },
    redesignOfferPage: () => {
      site.inject({ action: 'offer', fault: { type: 'redesigned' } });
    },
    name: 'Depop',
  }));
});
