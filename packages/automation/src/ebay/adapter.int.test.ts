/**
 * The eBay automation adapter's own flows on the fake eBay site, in a real headless Chromium
 * (the shared conformance suite is in adapter.conformance.int.test.ts): every field of the
 * listing form, photos in posting order, the SKU as the Custom label, item specifics (the
 * category's and custom ones), a revise into another category, ending and relisting under a new
 * item number, sold listings, the seller's active listings for imports, sold listings for sale
 * checks, and the stops: eBay's security check, a CAPTCHA, a sign-in code, a logged-out
 * session, and a redesigned page. No traffic goes to eBay.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  ListingContent,
  ListingRef,
  OperationRequest,
  WriteOperationKind,
} from '@listora/marketplaces';
import {
  descriptionHtml,
  desiredStateForContent,
  isContentKind,
  readBackState,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createEbayAutomationAdapter } from './adapter.ts';
import { EBAY_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import {
  FakeEbaySite,
  type FakeEbaySiteAction,
  type FakeEbaySiteFault,
  type FakeEbaySiteOptions,
} from './fake/fake-ebay-site.ts';
import type { EbayAutomationPayload } from './payload.ts';

const connection = { id: 'connection-ebay', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('eBay automation adapter on the fake eBay site', () => {
  let site: FakeEbaySite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createEbayAutomationAdapter>;
  let sequence = 0;

  function adapterOn(fake: FakeEbaySite) {
    const profile = { ...automationProfile('ebay'), pacing: QUICK_PACING };
    const own = new FakeSiteSessions(fake, runner, {
      ...profile,
      origins: [fake.url],
      cookieDomains: ['127.0.0.1'],
    });
    return {
      sessions: own,
      adapter: createEbayAutomationAdapter({
        siteUrl: fake.url,
        profile,
        sessions: own,
        photos: stubPhotos,
        logger: silentLogger,
      }),
    };
  }

  /** A fake eBay site of its own for one test, closed after it. */
  async function withSite<T>(
    options: FakeEbaySiteOptions,
    body: (fake: FakeEbaySite, own: ReturnType<typeof adapterOn>['adapter']) => Promise<T>,
  ): Promise<T> {
    const fake = await FakeEbaySite.start(0, options);
    try {
      return await body(fake, adapterOn(fake).adapter);
    } finally {
      await fake.close();
    }
  }

  beforeAll(async () => {
    site = await FakeEbaySite.start(0, { pageSize: 2 });
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: EBAY_STEP_TIMEOUT_MS,
    });
    ({ sessions, adapter } = adapterOn(site));
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
    const id = `ebay-${String(process.pid)}-${String(sequence)}`;
    return { listingId: id, externalListingId: null, externalSku: `SKU-${id}`, externalUrl: null };
  }

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    change: { content?: ListingContent; priceCents?: number; attempt?: number } = {},
  ): OperationRequest<EbayAutomationPayload> {
    const content = change.content ?? sampleListingContent();
    const base = {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: `key-${listing.listingId}-${kind}`,
      attempt: change.attempt ?? 1,
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

  function inject(action: FakeEbaySiteAction, fault: FakeEbaySiteFault): void {
    site.inject({ action, fault });
  }

  const posts = (since: number) =>
    site.requests.slice(since).filter((entry) => entry.method === 'POST');

  it('signs a seller in by hand, as the app does when linking in development', async () => {
    const signIn = `${site.url}/signin/`;
    const signedIn = await fetch(signIn, {
      method: 'POST',
      body: new URLSearchParams({ username: 'vintage_finds', password: 'anything' }),
      redirect: 'manual',
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/sh/ovw');
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const hub = await fetch(`${site.url}/sh/ovw`, { headers: { cookie }, redirect: 'manual' });
    expect(hub.status).toBe(200);
    const refused = await fetch(signIn, {
      method: 'POST',
      body: new URLSearchParams({ username: 'vintage_finds' }),
      redirect: 'manual',
    });
    expect(refused.status).toBe(200);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });

  it('fills every field of the listing form, uploads photos in posting order, and reads the listing back', async () => {
    const content = sampleListingContent({
      variant: { description: 'Classic trucker jacket.\nLight fading at the cuffs & hem.' },
    });
    const { ref, outcome } = await create(content);
    const listed = site.listing(ref.externalListingId);
    expect(listed).toMatchObject({
      status: 'active',
      title: content.variant.title,
      // The listing's SKU, in the Custom label, as the API adapter sends it.
      sku: ref.externalSku,
      categoryId: '57988',
      // Pre-owned - Excellent: apparel's own grade.
      conditionId: 2990,
      conditionDescription: 'Light fading at the cuffs.',
      // The HTML the API adapter sends, so either mode makes the same listing.
      descriptionHtml: descriptionHtml(content.variant.description),
      priceCents: 4500,
      // The seller's own shipping policy, left as it was.
      shipping: 'Standard shipping',
      // The sample lists its photos out of posting order: tag (2), front (0), back (1).
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    expect(listed?.itemSpecifics).toEqual(
      expect.arrayContaining([
        { name: 'Brand', values: ["Levi's"] },
        { name: 'Department', values: ['Men'] },
        { name: 'Size', values: ['M'] },
        { name: 'Size Type', values: ['Regular'] },
        { name: 'Color', values: ['Blue'] },
        { name: 'Material', values: ['Cotton'] },
        { name: 'MPN', values: ['72334-0130'] },
      ]),
    );
    expect(ref.externalListingId).toMatch(/^\d{12}$/);

    const remote = await adapter.readListing(ref, ctx());
    expect(remote).toEqual({
      found: true,
      externalListingId: ref.externalListingId,
      externalUrl: `${site.url}/itm/${ref.externalListingId}`,
      status: 'active',
      title: content.variant.title,
      description: content.variant.description,
      priceCents: 4500,
      currency: 'USD',
      // Never changed since it was listed.
      revision: 0,
    });
    expect(remote).toMatchObject(
      readBackState(desiredStateForContent('create', content), adapter.capabilities()),
    );
    expect(outcome.revision).toBe(0);
    // Found again by its SKU before its item number is known, the way a timed-out create is.
    expect(await adapter.readListing({ ...ref, externalListingId: null }, ctx())).toEqual(remote);
  });

  it('adds an item specific the category has no field for as a custom one', async () => {
    const content = sampleListingContent({
      variant: { aspects: [{ name: 'Era', values: ['1990s'] }] },
    });
    const { ref } = await create(content);
    expect(site.listing(ref.externalListingId)?.itemSpecifics).toEqual(
      expect.arrayContaining([{ name: 'Era', values: ['1990s'] }]),
    );
  });

  it('lists a create sent again once, finding the first by its SKU', async () => {
    const ref = newRef();
    const first = await adapter.execute(request('create', ref), ctx());
    const before = site.requests.length;
    const again = await adapter.execute(request('create', ref, { attempt: 2 }), ctx());
    expect(again).toMatchObject({
      type: 'confirmed',
      externalListingId: first.type === 'confirmed' ? first.externalListingId : '',
    });
    expect(posts(before)).toEqual([]);
    expect(site.listingsWithSku(ref.externalSku ?? '')).toHaveLength(1);
  });

  it('revises every detail into another category and keeps the photos, with a newer revision', async () => {
    const { ref } = await create();
    const content = sampleListingContent({
      item: {
        department: 'women',
        category: 'shoes/boots',
        sizeLabel: '8 1/2',
        condition: 'pre_owned_fair',
        brand: 'Dr. Martens',
        colors: ['black'],
        styleNumber: null,
      },
      variant: {
        title: 'Dr. Martens 1460 Boots Women 8.5 Black',
        description: 'Dr. Martens 1460 boots. Worn, resoled.',
        price: { amountCents: 6550, currency: 'USD' },
        aspects: [],
      },
    });
    const outcome = await adapter.execute(request('revise', ref, { content }), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed', externalListingId: ref.externalListingId });
    const revised = site.listing(ref.externalListingId);
    expect(revised).toMatchObject({
      categoryId: '53557',
      // Shoes have one pre-owned grade.
      conditionId: 3000,
      title: 'Dr. Martens 1460 Boots Women 8.5 Black',
      priceCents: 6550,
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    expect(revised?.itemSpecifics).toEqual(
      expect.arrayContaining([
        { name: 'Brand', values: ['Dr. Martens'] },
        { name: 'US Shoe Size', values: ['8.5'] },
        { name: 'Department', values: ['Women'] },
      ]),
    );
    const read = await adapter.readListing(ref, ctx());
    expect(read).toMatchObject({
      description: 'Dr. Martens 1460 boots. Worn, resoled.',
      priceCents: 6550,
      status: 'active',
      revision: revised?.updatedAt?.getTime(),
    });
    expect(outcome.type === 'confirmed' && outcome.revision).toBe(revised?.updatedAt?.getTime());
  });

  it('changes only the price, in dollars and cents', async () => {
    const { ref } = await create();
    const before = site.listing(ref.externalListingId);
    expect(await adapter.execute(request('price', ref, { priceCents: 3999 }), ctx())).toMatchObject(
      { type: 'confirmed' },
    );
    expect(site.listing(ref.externalListingId)).toMatchObject({
      priceCents: 3999,
      title: before?.title,
      descriptionHtml: before?.descriptionHtml,
      categoryId: before?.categoryId,
    });
  });

  it("refuses a price below eBay's lowest without opening eBay", async () => {
    const { ref } = await create();
    const before = site.requests.length;
    expect(await adapter.execute(request('price', ref, { priceCents: 50 }), ctx())).toMatchObject({
      type: 'rejected',
      code: 'invalid_price',
      message: 'eBay prices must be at least $0.99.',
    });
    expect(site.requests.length).toBe(before);
  });

  it('ends a listing, reads it as ended, and relists it under a new item number', async () => {
    const { ref } = await create();
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    const ended = site.listing(ref.externalListingId);
    expect(ended?.status).toBe('ended');
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      found: true,
      status: 'ended',
      description: null,
      revision: ended?.endedAt?.getTime(),
    });
    const relisted = await adapter.execute(request('relist', ref), ctx());
    if (relisted.type !== 'confirmed' || relisted.externalListingId === undefined) {
      throw new Error(`relist was ${JSON.stringify(relisted)}`);
    }
    expect(relisted.externalListingId).not.toBe(ref.externalListingId);
    expect(site.listing(relisted.externalListingId)).toMatchObject({
      status: 'active',
      sku: ref.externalSku,
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    expect(site.listing(ref.externalListingId)).toMatchObject({
      status: 'ended',
      relistedAs: relisted.externalListingId,
    });
    // A relist sent again finds the first one by its SKU instead of listing it twice.
    const before = site.requests.length;
    expect(await adapter.execute(request('relist', ref, { attempt: 2 }), ctx())).toMatchObject({
      type: 'confirmed',
      externalListingId: relisted.externalListingId,
    });
    // And relisting a listing that is on sale changes nothing.
    expect(
      await adapter.execute(
        request('relist', { ...ref, externalListingId: relisted.externalListingId }),
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ externalListingId: relisted.externalListingId }));
    expect(posts(before)).toEqual([]);
  });

  it('refuses to change a listing that sold, reads it as sold, and ends it without a click', async () => {
    const { ref } = await create();
    site.sell(ref.externalListingId);
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'sold' });
    for (const kind of ['price', 'revise'] as const) {
      expect(await adapter.execute(request(kind, ref), ctx()), kind).toMatchObject({
        type: 'rejected',
        code: 'listing_sold',
        message: expect.stringContaining('eBay') as unknown,
      });
    }
    const before = site.requests.length;
    // Nothing is live, so an end is applied without sending anything; the read-back decides.
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(posts(before)).toEqual([]);
  });

  it("rejects a create in eBay's words when the seller has set up no shipping", async () => {
    await withSite({ shippingPolicy: null }, async (fake, own) => {
      const ref = newRef();
      expect(await own.execute(request('create', ref), ctx())).toMatchObject({
        type: 'rejected',
        code: 'validation_failed',
        message: 'eBay: Add shipping details before you list.',
      });
      expect(fake.listings()).toEqual([]);
    });
  });

  it("rejects a size that is not one of eBay's standard values in eBay's words", async () => {
    const ref = newRef();
    const content = sampleListingContent({
      variant: { aspects: [{ name: 'Size', values: ['Medium-ish'] }] },
    });
    expect(await adapter.execute(request('create', ref, { content }), ctx())).toMatchObject({
      type: 'rejected',
      message:
        'eBay: Medium-ish is not a valid value for Size. Select a value from the available options.',
    });
    expect(site.listingsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('reads a listing eBay does not serve as missing, never as gone for good', async () => {
    const { ref } = await create();
    site.forget(ref.externalListingId);
    expect(await adapter.readListing(ref, ctx())).toEqual({ found: false, authoritative: false });
  });

  describe('stops at every check and gives the step to the user', () => {
    const cases: [string, FakeEbaySiteFault, string][] = [
      ["eBay's security check", { type: 'bot_check' }, 'bot_check'],
      ['a CAPTCHA on the listing form', { type: 'captcha' }, 'captcha'],
      ['a sign-in code', { type: 'login_challenge' }, 'login_challenge'],
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
          task: { kind: 'list_manually', deepLink: 'https://www.ebay.com/' },
          excerpt: { automation: 'challenge', failure: { kind: 'challenge', code: challenge } },
        });
        expect(sessions.challenges).toEqual([challenge]);
        expect(site.listingsWithSku(ref.externalSku ?? '')).toHaveLength(0);
        // Nothing after the check: the run stopped at the page that showed it.
        expect(posts(before)).toEqual([]);
      });
    }

    it('when the check comes on List it, and nothing is listed', async () => {
      const ref = newRef();
      inject('create', { type: 'bot_check' });
      expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
        type: 'pendingUser',
        excerpt: { automation: 'challenge', failure: { code: 'bot_check', step: 'list it' } },
      });
      expect(site.listingsWithSku(ref.externalSku ?? '')).toHaveLength(0);
    });

    it('in an end, which the user then does', async () => {
      const { ref } = await create();
      inject('form', { type: 'captcha' });
      expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
        type: 'pendingUser',
        task: { kind: 'delist_manually', deepLink: expect.stringContaining('https://') as unknown },
        excerpt: { automation: 'challenge' },
      });
      expect(site.listing(ref.externalListingId)?.status).toBe('active');
    });

    it('in a read-back, which fails instead of guessing', async () => {
      const { ref } = await create();
      inject('read', { type: 'bot_check' });
      await expect(adapter.readListing(ref, ctx())).rejects.toThrow('eBay');
      expect(sessions.challenges).toEqual(['bot_check']);
    });

    it('in a health check, which asks the seller to sign in again', async () => {
      inject('health', { type: 'captcha' });
      expect(await adapter.healthCheck(ctx())).toMatchObject({
        status: 'reauth_required',
        code: 'captcha',
        message: expect.stringContaining('never solves') as unknown,
      });
    });

    it('in a sale check, which fails and is retried after the relink', async () => {
      inject('sold', { type: 'login_challenge' });
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toThrow('eBay');
      expect(sessions.challenges).toEqual(['login_challenge']);
    });
  });

  it('gives a create to the user when the listing form is not as Listora knows it', async () => {
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
    expect(site.listingsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('gives a create to the user when eBay opens no form for the category', async () => {
    const ref = newRef();
    const content = sampleListingContent({ variant: { categoryRef: '99999999' } });
    expect(await adapter.execute(request('create', ref, { content }), ctx())).toMatchObject({
      type: 'pendingUser',
      excerpt: { automation: 'page_changed' },
    });
    expect(site.listingsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('fails a read-back of a listing page it no longer understands', async () => {
    const { ref } = await create();
    inject('read', { type: 'redesigned' });
    await expect(adapter.readListing(ref, ctx())).rejects.toThrow('element_missing');
  });

  it("lists the seller's active listings a page at a time", async () => {
    await withSite({ pageSize: 2 }, async (fake, own) => {
      const ids = ['Faded tee', 'Baggy jeans', 'Chelsea boots'].map((title) =>
        fake.seed({ title, priceCents: 2000 }),
      );
      fake.sell(fake.seed({ title: 'Tote bag', priceCents: 5000 }));
      fake.seed({ title: 'Not mine', priceCents: 900, seller: 'someone-else' });
      const labeled = fake.seed({ title: 'Cord cap', priceCents: 104_550, sku: 'AJ-000001' });

      const listings = [];
      let cursor: string | null = null;
      do {
        const page = await own.listListings(cursor, ctx());
        listings.push(...page.listings);
        cursor = page.next;
      } while (cursor !== null);
      expect(new Set(listings.map((listing) => listing.externalListingId))).toEqual(
        new Set([...ids, labeled]),
      );
      expect(listings.find((listing) => listing.externalListingId === labeled)).toEqual({
        found: true,
        externalListingId: labeled,
        externalUrl: `${fake.url}/itm/${labeled}`,
        status: 'active',
        title: 'Cord cap',
        description: null,
        priceCents: 104_550,
        currency: 'USD',
        revision: null,
        details: {
          photoUrls: [],
          brand: null,
          size: null,
          condition: null,
          categoryRef: null,
          categoryPath: [],
          sku: null,
        },
      });
    });
  });

  it('finds sold listings since a time, newest first across pages, for sale checks', async () => {
    await withSite({ pageSize: 2 }, async (fake, own) => {
      const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
      const [, older, recent, fresh] = [
        ['Old sale', 72],
        ['Older sale', 5],
        ['Recent sale', 3],
        ['Fresh sale', 1],
      ].map(([title, hoursAgo]) => {
        const itemId = fake.seed({ title: String(title), priceCents: 3050 });
        return { itemId, orderId: fake.sell(itemId, at(Number(hoursAgo))) };
      });
      fake.seed({ title: 'Still for sale', priceCents: 1000 });

      const orders = await own.listOrdersSince(at(24), ctx());
      expect(orders.map((order) => order.externalOrderId)).toEqual([
        fresh?.orderId,
        recent?.orderId,
        older?.orderId,
      ]);
      expect(orders[0]).toEqual({
        externalOrderId: fresh?.orderId,
        soldAt: expect.any(Date) as unknown,
        items: [
          { externalListingId: fresh?.itemId, title: null, priceCents: 3050, currency: 'USD' },
        ],
      });
      expect(orders[0]?.externalOrderId).toMatch(/^\d{2}-\d{5}-\d{5}$/);
      expect(await own.listOrdersSince(null, ctx())).toHaveLength(4);
    });
  });
});
