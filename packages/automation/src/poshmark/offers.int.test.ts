/**
 * Poshmark's offers on the fake Poshmark (the shared offers suite, fake-offers/offers-suite.ts):
 * Active Offers' embedded data, an offer's page, and the seller's answers, in a real headless
 * Chromium. No real Poshmark traffic, and never a real buyer's offer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { offerSuite } from '../fake-offers/offers-suite.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, testRunner } from '../test-support.ts';
import { createPoshmarkAutomationAdapter } from './adapter.ts';
import { FakePoshmark } from './fake/fake-poshmark.ts';

describe('Poshmark offers (headless Chromium, fake Poshmark)', () => {
  let site: FakePoshmark;
  let adapter: ReturnType<typeof createPoshmarkAutomationAdapter>;
  const { runner } = testRunner({ stepTimeoutMs: 4_000 });
  const connection = {
    id: 'connection-poshmark',
    mode: 'automation',
    status: 'connected',
  } as const;
  const ctx = () => ({ signal: new AbortController().signal, connection });

  beforeAll(async () => {
    site = await FakePoshmark.start(0);
    const profile = {
      ...standInProfile(automationProfile('poshmark'), site.url),
      pacing: QUICK_PACING,
    };
    adapter = createPoshmarkAutomationAdapter({
      profile,
      sessions: new FakeSiteSessions(site, runner, profile),
      photos: { fetch: () => Promise.reject(new Error('no photos here')) },
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

  it('reads no offers from an empty Active Offers', async () => {
    await expect(adapter.listOffers(ctx())).resolves.toEqual([]);
  });

  offerSuite('the offers suite', () => ({
    adapter,
    desk: site.offers,
    ctx,
    listingId: (n) => n.toString(16).padStart(24, 'a'),
    offerUrl: (id) => `${site.url}/offers/${id}`,
    offerId: (offer) => offer.id,
    details: (offer) => ({
      listingTitle: offer.listingTitle,
      listPriceCents: offer.listPriceCents,
    }),
    botCheckOnOffers: () => {
      site.inject({ action: 'offers', fault: { type: 'bot_check' } });
    },
    redesignOfferPage: () => {
      site.inject({ action: 'offer', fault: { type: 'redesign' } });
    },
    name: 'Poshmark',
  }));
});
