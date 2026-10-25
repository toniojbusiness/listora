/**
 * The Mercari automation adapter's own flows on the fake Mercari site, in a real headless
 * Chromium (the shared conformance suite is in adapter.conformance.int.test.ts): every field of
 * the sell form, photos in posting order, the SKU line, deactivate and activate, sold listings,
 * the seller's listings for imports, sold items for sale checks, and the stops: Cloudflare's
 * interstitial and Turnstile, a CAPTCHA, a login code, a logged-out session, and a redesigned
 * page. No traffic goes to Mercari.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  ListingContent,
  ListingRef,
  OperationRequest,
  WriteOperationKind,
} from '@listora/marketplaces';
import { desiredStateForContent, isContentKind } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createMercariAutomationAdapter } from './adapter.ts';
import { MERCARI_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import {
  FakeMercariSite,
  type FakeMercariAction,
  type FakeMercariFault,
} from './fake/fake-mercari.ts';
import type { MercariListingPayload } from './payload.ts';

const connection = { id: 'connection-mercari', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('Mercari automation adapter on the fake Mercari site', () => {
  let site: FakeMercariSite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createMercariAutomationAdapter>;
  let sequence = 0;

  beforeAll(async () => {
    site = await FakeMercariSite.start(0, { pageSize: 2 });
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: MERCARI_STEP_TIMEOUT_MS,
    });
    const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };
    sessions = new FakeSiteSessions(site, runner, {
      ...profile,
      origins: [site.url],
      cookieDomains: ['127.0.0.1'],
    });
    adapter = createMercariAutomationAdapter({
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
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  function newRef(): ListingRef {
    sequence += 1;
    const id = `mercari-${String(process.pid)}-${String(sequence)}`;
    return { listingId: id, externalListingId: null, externalSku: `SKU-${id}`, externalUrl: null };
  }

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    change: { content?: ListingContent; priceCents?: number } = {},
  ): OperationRequest<MercariListingPayload> {
    const content = change.content ?? sampleListingContent();
    const base = {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: `key-${listing.listingId}-${kind}`,
      attempt: 1,
      listing,
    };
    if (isContentKind(kind)) {
      return {
        ...base,
        desired: desiredStateForContent(kind, content),
        payload: adapter.buildPayload(content.item, content.variant),
      };
    }
    const desired =
      kind === 'price'
        ? { priceCents: change.priceCents ?? 3900, currency: 'USD' as const }
        : { status: kind === 'end' ? ('ended' as const) : ('sold' as const) };
    return { ...base, desired, payload: null };
  }

  async function create(content = sampleListingContent()) {
    const ref = newRef();
    const outcome = await adapter.execute(request('create', ref, { content }), ctx());
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(`create was ${JSON.stringify(outcome)}`);
    }
    return { ref: { ...ref, externalListingId: outcome.externalListingId }, outcome };
  }

  function inject(action: FakeMercariAction, fault: FakeMercariFault): void {
    site.inject({ action, fault });
  }

  it('signs a seller in by hand, as the app does when linking in development', async () => {
    const login = `${site.url}/login/`;
    const signedIn = await fetch(login, {
      method: 'POST',
      body: new URLSearchParams({ email: 'seller@example.com', password: 'anything' }),
      redirect: 'manual',
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/mypage/');
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const account = await fetch(`${site.url}/mypage/`, { headers: { cookie }, redirect: 'manual' });
    expect(account.status).toBe(200);
    const refused = await fetch(login, {
      method: 'POST',
      body: new URLSearchParams({ email: 'seller@example.com' }),
      redirect: 'manual',
    });
    expect(refused.status).toBe(200);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });

  it('fills every field of the sell form, uploads photos in posting order, and reads the listing back', async () => {
    const content = sampleListingContent();
    const { ref, outcome } = await create(content);
    const listed = site.item(ref.externalListingId);
    expect(listed).toMatchObject({
      status: 'on_sale',
      title: content.variant.title,
      description: `${content.variant.description}\n\nSKU: ${ref.externalSku ?? ''}`,
      priceCents: 4500,
      category: ['Men', 'Coats & jackets'],
      brand: "Levi's",
      conditionId: 2,
      size: 'M',
      shippingPayer: 'Buyer',
      shippingWeight: 'Up to 3 lb',
      // The sample lists its photos out of posting order: tag (2), front (0), back (1).
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });

    const remote = await adapter.readListing(ref, ctx());
    expect(remote).toEqual({
      found: true,
      externalListingId: ref.externalListingId,
      externalUrl: `${site.url}/us/item/${ref.externalListingId}/`,
      status: 'active',
      title: content.variant.title,
      // The SKU line is Listora's; the description verified is the listing's own.
      description: content.variant.description,
      priceCents: 4500,
      currency: 'USD',
      revision: listed?.updatedAt.getTime(),
    });
    expect(outcome.revision).toBe(listed?.updatedAt.getTime());
    // Found again by its SKU before its id is known, the way a timed-out create is.
    expect(await adapter.readListing({ ...ref, externalListingId: null }, ctx())).toEqual(remote);
  });

  it('posts without a brand Mercari does not list, and picks a brand it does whatever the case', async () => {
    const unknown = await create(sampleListingContent({ item: { brand: 'Handmade Studio' } }));
    expect(site.item(unknown.ref.externalListingId)?.brand).toBeNull();
    const cased = await create(sampleListingContent({ item: { brand: 'ADIDAS' } }));
    expect(site.item(cased.ref.externalListingId)?.brand).toBe('adidas');
  });

  it('revises every detail on the edit page and keeps the photos', async () => {
    const { ref } = await create();
    const content = sampleListingContent({
      item: {
        department: 'women',
        category: 'shoes/boots',
        sizeLabel: '8 1/2',
        condition: 'pre_owned_fair',
        brand: 'Dr. Martens',
      },
      variant: { title: 'Dr. Martens 1460 Boots', description: 'Worn, resoled.' },
    });
    const outcome = await adapter.execute(request('revise', ref, { content }), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed', externalListingId: ref.externalListingId });
    expect(site.item(ref.externalListingId)).toMatchObject({
      title: 'Dr. Martens 1460 Boots',
      category: ['Women', 'Shoes', 'Boots'],
      size: '8.5',
      conditionId: 4,
      brand: 'Dr. Martens',
      shippingWeight: 'Up to 5 lb',
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject(
      desiredStateForContent('revise', content),
    );
  });

  it('deactivates to end and activates the same listing to relist', async () => {
    const { ref } = await create();
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(site.item(ref.externalListingId)?.status).toBe('inactive');
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'ended' });
    expect(await adapter.execute(request('relist', ref), ctx())).toMatchObject({
      type: 'confirmed',
      externalListingId: ref.externalListingId,
    });
    expect(site.item(ref.externalListingId)?.status).toBe('on_sale');
    expect(site.items().filter((item) => item.id === ref.externalListingId)).toHaveLength(1);
  });

  it('refuses to change or relist a listing that sold, and reads it as sold', async () => {
    const { ref } = await create();
    site.sell(ref.externalListingId);
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'sold' });
    for (const kind of ['price', 'relist'] as const) {
      expect(await adapter.execute(request(kind, ref), ctx()), kind).toMatchObject({
        type: 'rejected',
        code: 'listing_sold',
        message: expect.stringContaining('Mercari') as unknown,
      });
    }
    expect(site.item(ref.externalListingId)?.priceCents).toBe(4500);
  });

  describe('stops at every check and gives the step to the user', () => {
    const cases: [string, FakeMercariFault, string][] = [
      ["Cloudflare's interstitial", { type: 'cloudflare_interstitial' }, 'bot_check'],
      ["Cloudflare's Turnstile widget on the sell form", { type: 'turnstile' }, 'captcha'],
      ['a CAPTCHA', { type: 'captcha' }, 'captcha'],
      ['a login code', { type: 'login_challenge' }, 'login_challenge'],
      ['a logged-out session', { type: 'session_expired' }, 'session_rejected'],
    ];
    for (const [name, fault, challenge] of cases) {
      it(`on ${name}`, async () => {
        const ref = newRef();
        inject('form', fault);
        const before = site.requests.length;
        const outcome = await adapter.execute(request('create', ref), ctx());
        expect(outcome).toMatchObject({
          type: 'pendingUser',
          task: { kind: 'list_manually', deepLink: 'https://www.mercari.com/' },
          excerpt: { automation: 'challenge', failure: { kind: 'challenge', code: challenge } },
        });
        expect(sessions.challenges).toEqual([challenge]);
        expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
        // Nothing after the check: the run stopped at the page that showed it.
        const after = site.requests.slice(before).filter((entry) => entry.method === 'POST');
        expect(after).toEqual([]);
      });
    }

    it('in a read-back, which fails instead of guessing', async () => {
      const { ref } = await create();
      inject('read', { type: 'cloudflare_interstitial' });
      await expect(adapter.readListing(ref, ctx())).rejects.toThrow('Mercari');
      expect(sessions.challenges).toEqual(['bot_check']);
    });

    it('in a health check, which asks the seller to log in again', async () => {
      inject('health', { type: 'turnstile' });
      expect(await adapter.healthCheck(ctx())).toMatchObject({
        status: 'reauth_required',
        code: 'captcha',
        message: expect.stringContaining('never solves') as unknown,
      });
    });

    it('in a sale check, which fails and is retried after the relink', async () => {
      inject('listings', { type: 'cloudflare_interstitial' });
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toThrow('Mercari');
      expect(sessions.challenges).toEqual(['bot_check']);
    });
  });

  it('gives a create to the user when the sell page is not as Listora knows it', async () => {
    const ref = newRef();
    inject('form', { type: 'redesigned' });
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'pendingUser',
      task: { kind: 'list_manually' },
      excerpt: {
        automation: 'page_changed',
        failure: { code: 'element_missing', step: 'fill in the listing' },
      },
    });
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('gives a create to the user when the form offers no such category', async () => {
    const ref = newRef();
    const content = sampleListingContent({ variant: { categoryRef: 'Men > Hovercraft > Parts' } });
    expect(await adapter.execute(request('create', ref, { content }), ctx())).toMatchObject({
      type: 'pendingUser',
      excerpt: { automation: 'page_changed' },
    });
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('fails a read-back of a listing page it no longer understands', async () => {
    const { ref } = await create();
    inject('read', { type: 'redesigned' });
    await expect(adapter.readListing(ref, ctx())).rejects.toThrow('element_missing');
  });

  it("lists the seller's active and inactive listings across pages, for imports", async () => {
    const seller = await FakeMercariSite.start(0, { pageSize: 2 });
    try {
      const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };
      const own = createMercariAutomationAdapter({
        siteUrl: seller.url,
        profile,
        sessions: new FakeSiteSessions(seller, runner, {
          ...profile,
          origins: [seller.url],
          cookieDomains: ['127.0.0.1'],
        }),
        photos: stubPhotos,
        logger: silentLogger,
      });
      const ids = ['Tee', 'Jeans', 'Boots'].map((title) =>
        seller.seed({ title, priceCents: 2000 }),
      );
      const inactive = seller.seed({ title: 'Hat', priceCents: 1200, status: 'inactive' });
      const sold = seller.seed({ title: 'Bag', priceCents: 5000 });
      seller.sell(sold);
      seller.seed({ title: 'Not mine', priceCents: 900, seller: 'someone-else' });

      const { listings, complete } = await own.listListings(ctx());
      expect(complete).toBe(true);
      expect(listings).toHaveLength(4);
      expect(new Set(listings.map((listing) => listing.externalListingId))).toEqual(
        new Set([...ids, inactive]),
      );
      expect(listings.find((listing) => listing.externalListingId === inactive)).toEqual({
        found: true,
        externalListingId: inactive,
        externalUrl: `${seller.url}/us/item/${inactive}/`,
        status: 'ended',
        title: 'Hat',
        description: null,
        priceCents: 1200,
        currency: 'USD',
        revision: null,
      });
    } finally {
      await seller.close();
    }
  });

  it('finds sold items waiting to ship and done, since a time, for sale checks', async () => {
    const shop = await FakeMercariSite.start(0, { pageSize: 2 });
    try {
      const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };
      const own = createMercariAutomationAdapter({
        siteUrl: shop.url,
        profile,
        sessions: new FakeSiteSessions(shop, runner, {
          ...profile,
          origins: [shop.url],
          cookieDomains: ['127.0.0.1'],
        }),
        photos: stubPhotos,
        logger: silentLogger,
      });
      const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
      const [old, done, waiting, fresh] = [
        ['Old sale', 72],
        ['Done sale', 5],
        ['Waiting sale', 3],
        ['Fresh sale', 1],
      ].map(([title, hoursAgo]) => {
        const id = shop.seed({ title: String(title), priceCents: 3000 });
        shop.sell(id, at(Number(hoursAgo)));
        return id;
      });
      shop.complete(done ?? '');
      shop.complete(old ?? '');
      shop.seed({ title: 'Still for sale', priceCents: 1000 });

      const recent = await own.listOrdersSince(at(24), ctx());
      expect(recent.map((order) => order.externalOrderId).sort()).toEqual(
        [done, waiting, fresh].sort(),
      );
      expect(recent.find((order) => order.externalOrderId === fresh)).toEqual({
        externalOrderId: fresh,
        soldAt: expect.any(Date) as unknown,
        items: [
          { externalListingId: fresh, title: 'Fresh sale', priceCents: 3000, currency: 'USD' },
        ],
      });
      expect(await own.listOrdersSince(null, ctx())).toHaveLength(4);
    } finally {
      await shop.close();
    }
  });
});
