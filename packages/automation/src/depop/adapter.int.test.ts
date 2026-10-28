/**
 * The Depop automation adapter's own flows on the fake Depop site, in a real headless Chromium
 * (the shared conformance suite is in adapter.conformance.int.test.ts): every field of the sell
 * form, photos in posting order, the SKU line and hashtags, a new listing found in the seller's
 * shop by its SKU, delete and relist as a new listing, sold listings, a product Depop deleted for
 * good (410 Gone), the seller's listings for imports, sale checks (no sales, and sales Listora
 * can't read yet), and the stops: a bot-check page, a CAPTCHA, a login code, a logged-out
 * session, and a redesigned page. No traffic goes to Depop.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  ListingContent,
  ListingRef,
  OperationRequest,
  WriteOperationKind,
} from '@listora/marketplaces';
import { desiredStateForContent, isContentKind, readBackState } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile, standInProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createDepopAutomationAdapter } from './adapter.ts';
import { DEPOP_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import {
  FakeDepopSite,
  type FakeDepopSiteAction,
  type FakeDepopSiteFault,
  type FakeDepopSiteOptions,
} from './fake/fake-depop-site.ts';
import type { DepopAutomationPayload } from './payload.ts';

const connection = { id: 'connection-depop', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('Depop automation adapter on the fake Depop site', () => {
  let site: FakeDepopSite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createDepopAutomationAdapter>;
  let sequence = 0;

  function adapterOn(fake: FakeDepopSite) {
    const profile = { ...automationProfile('depop'), pacing: QUICK_PACING };
    const own = new FakeSiteSessions(fake, runner, standInProfile(profile, fake.url));
    return {
      sessions: own,
      adapter: createDepopAutomationAdapter({
        siteUrl: fake.url,
        profile,
        sessions: own,
        photos: stubPhotos,
        logger: silentLogger,
      }),
    };
  }

  /** A fake Depop site of its own for one test, closed after it. */
  async function withSite<T>(
    options: FakeDepopSiteOptions,
    body: (fake: FakeDepopSite, own: ReturnType<typeof adapterOn>['adapter']) => Promise<T>,
  ): Promise<T> {
    const fake = await FakeDepopSite.start(0, options);
    try {
      return await body(fake, adapterOn(fake).adapter);
    } finally {
      await fake.close();
    }
  }

  beforeAll(async () => {
    site = await FakeDepopSite.start(0, { pageSize: 2 });
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: DEPOP_STEP_TIMEOUT_MS,
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
    const id = `depop-${String(process.pid)}-${String(sequence)}`;
    return { listingId: id, externalListingId: null, externalSku: `SKU-${id}`, externalUrl: null };
  }

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    change: { content?: ListingContent; priceCents?: number; attempt?: number } = {},
  ): OperationRequest<DepopAutomationPayload> {
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

  function inject(action: FakeDepopSiteAction, fault: FakeDepopSiteFault): void {
    site.inject({ action, fault });
  }

  const posts = (since: number) =>
    site.requests.slice(since).filter((entry) => entry.method === 'POST');

  it('signs a seller in by hand, as the app does when linking in development', async () => {
    const login = `${site.url}/login/`;
    const signedIn = await fetch(login, {
      method: 'POST',
      body: new URLSearchParams({ username: 'vintage_finds', password: 'anything' }),
      redirect: 'manual',
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/sellinghub/');
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const hub = await fetch(`${site.url}/sellinghub/`, { headers: { cookie }, redirect: 'manual' });
    expect(hub.status).toBe(200);
    const refused = await fetch(login, {
      method: 'POST',
      body: new URLSearchParams({ username: 'vintage_finds' }),
      redirect: 'manual',
    });
    expect(refused.status).toBe(200);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });

  it('signs a seller in with an emailed link, once, as the app does when the link is pasted', async () => {
    const before = site.signInLinks().length;
    const asked = await fetch(`${site.url}/login/email-link/`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'vintage_finds@example.com' }),
    });
    expect(await asked.text()).toContain('Check your email');
    const links = site.signInLinks();
    expect(links).toHaveLength(before + 1);
    const link = links.at(-1) ?? '';
    expect(new URL(link).pathname).toBe('/login/magic-link/');

    const signedIn = await fetch(link, { redirect: 'manual' });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/sellinghub/');
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const hub = await fetch(`${site.url}/sellinghub/`, { headers: { cookie }, redirect: 'manual' });
    expect(await hub.text()).toContain('vintage_finds');

    // A link signs in once; a used or made-up one signs nobody in.
    for (const refused of [link, `${site.url}/login/magic-link/?token=made-up`]) {
      const again = await fetch(refused, { redirect: 'manual' });
      expect(again.status).toBe(400);
      expect(again.headers.get('set-cookie')).toBeNull();
    }
  });

  it('fills every field of the sell form, uploads photos in posting order, and reads the listing back', async () => {
    const content = sampleListingContent({ variant: { hashtags: ['vintage', 'denim'] } });
    const { ref, outcome } = await create(content);
    const listed = site.product(ref.externalListingId);
    expect(listed).toMatchObject({
      status: 'ONSALE',
      // The copy, Listora's SKU line, then the hashtags on their own last line.
      description: `${content.variant.description}\n\nSKU: ${ref.externalSku ?? ''}\n\n#vintage #denim`,
      priceCents: 4500,
      category: ['Men', 'Coats and jackets', 'Jackets'],
      size: 'M',
      brand: "Levi's",
      condition: 'used_excellent',
      // Depop's own colour for the item's, before the photos' suggestion could take it.
      colours: ['Blue'],
      // "Boost your listing" left off: no extra fee.
      boosted: false,
      // The seller's own shipping choice, left as it was.
      shipping: 'depop_shipping',
      // The sample lists its photos out of posting order: tag (2), front (0), back (1).
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    // The seller's username, then the listing's first words.
    expect(ref.externalListingId).toMatch(/^fake_seller-classic-trucker-jacket-in-/);

    const remote = await adapter.readListing(ref, ctx());
    expect(remote).toEqual({
      found: true,
      externalListingId: ref.externalListingId,
      externalUrl: `${site.url}/products/${ref.externalListingId}/`,
      status: 'active',
      // Depop listings have no title; the SKU line and hashtags are not the listing's copy.
      title: null,
      description: content.variant.description,
      priceCents: 4500,
      currency: 'USD',
      // Depop's own last change time, from the read its edit page makes.
      revision: listed?.updatedAt.getTime(),
      refreshedAt: listed?.updatedAt.toISOString(),
    });
    expect(remote).toMatchObject(
      readBackState(desiredStateForContent('create', content), adapter.capabilities()),
    );
    // Found by its SKU in the same run, with the same revision.
    expect(outcome).toMatchObject({ revision: remote.found ? remote.revision : -1 });
    // Found again by its SKU before its slug is known, the way a timed-out create is.
    expect(await adapter.readListing({ ...ref, externalListingId: null }, ctx())).toEqual(remote);
  });

  it('turns "Boost your listing" off when the form starts with it on', async () => {
    await withSite({ boostByDefault: true }, async (fake, own) => {
      const ref = newRef();
      const outcome = await own.execute(request('create', ref), ctx());
      expect(outcome).toMatchObject({ type: 'confirmed' });
      const [posted] = fake.productsWithSku(ref.externalSku ?? '');
      expect(posted).toMatchObject({ status: 'ONSALE', boosted: false });
    });
  });

  it('posts a create sent again once, finding the first by its SKU', async () => {
    const ref = newRef();
    const first = await adapter.execute(request('create', ref), ctx());
    const before = site.requests.length;
    const again = await adapter.execute(request('create', ref, { attempt: 2 }), ctx());
    expect(again).toMatchObject({
      type: 'confirmed',
      externalListingId: first.type === 'confirmed' ? first.externalListingId : '',
    });
    expect(posts(before)).toEqual([]);
    expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(1);
  });

  it("picks Depop's brand whatever the case or by its longer name, and never one Depop doesn't list", async () => {
    const cased = await create(sampleListingContent({ item: { brand: 'ADIDAS' } }));
    expect(site.product(cased.ref.externalListingId)?.brand).toBe('adidas');
    // Depop lists the brand under a longer name.
    const longer = await create(sampleListingContent({ item: { brand: 'free' } }));
    expect(site.product(longer.ref.externalListingId)?.brand).toBe('Free People');
    // A brand Depop doesn't list is not typed in: the form keeps Depop's own suggestion from
    // the photos, as it does for a seller filling it by hand (the fake's is Nike).
    const unknown = await create(sampleListingContent({ item: { brand: 'Handmade Studio' } }));
    expect(site.product(unknown.ref.externalListingId)?.brand).toBe('Nike');
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
      variant: {
        description: 'Dr. Martens 1460 boots. Worn, resoled.',
        price: { amountCents: 6550, currency: 'USD' },
      },
    });
    const outcome = await adapter.execute(request('revise', ref, { content }), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed', externalListingId: ref.externalListingId });
    expect(site.product(ref.externalListingId)).toMatchObject({
      category: ['Women', 'Footwear', 'Boots'],
      size: 'US 8.5',
      condition: 'used_fair',
      brand: 'Dr. Martens',
      priceCents: 6550,
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      description: 'Dr. Martens 1460 boots. Worn, resoled.',
      priceCents: 6550,
      status: 'active',
    });
  });

  it("fills a women's dress's and jeans' size, body fit, length, fit, type, and style", async () => {
    const dress = sampleListingContent({
      item: {
        department: 'women',
        category: 'clothing/dresses/dresses',
        sizeLabel: '4P',
        sizeSystem: 'numeric',
        brand: 'Free People',
        colors: ['orange'],
        materials: ['rayon'],
      },
      variant: {
        title: 'Free People Orange Floral Maxi Dress, A-line',
        hashtags: ['boho', 'floral'],
      },
    });
    const { ref } = await create(dress);
    expect(site.product(ref.externalListingId)).toMatchObject({
      category: ['Women', 'Dresses', 'Dresses'],
      size: '4',
      colours: ['Orange'],
      materials: ['Rayon'],
      details: {
        'attributes.dress-length': ['Maxi'],
        'attributes.dress-type': ['A-line'],
        'attributes.body-fit': ['Petite'],
        style: ['Boho'],
      },
    });

    // Revised into jeans: the jeans' own details are picked, and the dress's that jeans don't
    // offer go; a detail Listora has no value for (the style here) is left as it was.
    const jeans = sampleListingContent({
      item: {
        department: 'women',
        category: 'clothing/bottoms/jeans',
        sizeLabel: '27/4',
        sizeSystem: 'numeric',
        brand: 'Free People',
        colors: ['blue'],
        materials: ['denim'],
      },
      variant: { title: "'90s Straight Ultra High Rise ripped jeans", hashtags: [] },
    });
    const revised = await adapter.execute(request('revise', ref, { content: jeans }), ctx());
    expect(revised).toMatchObject({ type: 'confirmed' });
    expect(site.product(ref.externalListingId)).toMatchObject({
      category: ['Women', 'Bottoms', 'Jeans'],
      size: '27"',
      details: {
        'attributes.bottom-style': ['High waisted', 'Straight leg'],
        'attributes.bottom-fit': ['Ripped'],
      },
    });
    expect(site.product(ref.externalListingId)?.details).not.toHaveProperty(
      'attributes.dress-length',
    );
  });

  it('changes only the price, in dollars and cents', async () => {
    const { ref } = await create();
    const before = site.product(ref.externalListingId);
    expect(await adapter.execute(request('price', ref, { priceCents: 3999 }), ctx())).toMatchObject(
      { type: 'confirmed' },
    );
    expect(site.product(ref.externalListingId)).toMatchObject({
      priceCents: 3999,
      description: before?.description,
      category: before?.category,
    });
  });

  it('deletes to end, reads the listing as ended, and relists it as a new listing', async () => {
    const { ref } = await create();
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(site.product(ref.externalListingId)?.status).toBe('DELETED');
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      found: true,
      status: 'ended',
    });
    const relisted = await adapter.execute(request('relist', ref), ctx());
    if (relisted.type !== 'confirmed' || relisted.externalListingId === undefined) {
      throw new Error(`relist was ${JSON.stringify(relisted)}`);
    }
    expect(relisted.externalListingId).not.toBe(ref.externalListingId);
    expect(site.product(relisted.externalListingId)?.status).toBe('ONSALE');
    expect(site.product(ref.externalListingId)?.status).toBe('DELETED');
    // Relisting a listing that is on sale changes nothing.
    const before = site.requests.length;
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
        message: expect.stringContaining('Depop') as unknown,
      });
    }
    const before = site.requests.length;
    // Nothing is live, so an end is applied without sending anything; the read-back decides.
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(posts(before)).toEqual([]);
    expect(site.product(ref.externalListingId)?.priceCents).toBe(4500);
  });

  it("rejects a create in Depop's words when the seller has set up no shipping", async () => {
    await withSite({ defaultShipping: null }, async (fake, own) => {
      const ref = newRef();
      expect(await own.execute(request('create', ref), ctx())).toMatchObject({
        type: 'rejected',
        code: 'validation_failed',
        message: 'Depop: Choose how you’ll ship this item.',
      });
      expect(fake.products()).toEqual([]);
    });
  });

  it('maps a product type id Depop documents, as API mode names it, to the form', async () => {
    const content = sampleListingContent({
      item: { department: 'women', category: 'other/other', sizeLabel: '9' },
      variant: { categoryRef: 'boots' },
    });
    const { ref } = await create(content);
    expect(site.product(ref.externalListingId)).toMatchObject({
      category: ['Women', 'Footwear', 'Boots'],
      size: 'US 9',
    });
  });

  it('reads a listing Depop does not serve as missing, never as gone for good', async () => {
    const { ref } = await create();
    site.forget(ref.externalListingId);
    expect(await adapter.readListing(ref, ctx())).toEqual({ found: false, authoritative: false });
  });

  it('reads a listing Depop deleted for good (410 Gone) as gone, and ends it without a click', async () => {
    const { ref } = await create();
    site.gone(ref.externalListingId);
    expect(await adapter.readListing(ref, ctx())).toEqual({ found: false, authoritative: true });
    const before = site.requests.length;
    // Gone is ended already: nothing is sent, and the read-back confirms it.
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(posts(before)).toEqual([]);
  });

  describe('stops at every check and gives the step to the user', () => {
    const cases: [string, FakeDepopSiteFault, string][] = [
      ['a bot-check page', { type: 'bot_check' }, 'bot_check'],
      ['a CAPTCHA on the sell form', { type: 'captcha' }, 'captcha'],
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
          task: { kind: 'list_manually', deepLink: 'https://www.depop.com/' },
          excerpt: { automation: 'challenge', failure: { kind: 'challenge', code: challenge } },
        });
        expect(sessions.challenges).toEqual([challenge]);
        expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(0);
        // Nothing after the check: the run stopped at the page that showed it.
        expect(posts(before)).toEqual([]);
      });
    }

    it('when the check comes on the post itself, and nothing is listed', async () => {
      const ref = newRef();
      inject('create', { type: 'bot_check' });
      expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
        type: 'pendingUser',
        excerpt: { automation: 'challenge', failure: { code: 'bot_check', step: 'post' } },
      });
      expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(0);
    });

    it('in a delete, which the user then does', async () => {
      const { ref } = await create();
      // Delete listing is on the product's own page.
      inject('read', { type: 'captcha' });
      expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
        type: 'pendingUser',
        task: { kind: 'delist_manually', deepLink: expect.stringContaining('https://') as unknown },
        excerpt: { automation: 'challenge' },
      });
      expect(site.product(ref.externalListingId)?.status).toBe('ONSALE');
    });

    it('in a read-back, which fails instead of guessing', async () => {
      const { ref } = await create();
      inject('read', { type: 'bot_check' });
      await expect(adapter.readListing(ref, ctx())).rejects.toThrow('Depop');
      expect(sessions.challenges).toEqual(['bot_check']);
    });

    it('in a health check, which asks the seller to log in again', async () => {
      inject('health', { type: 'captcha' });
      expect(await adapter.healthCheck(ctx())).toMatchObject({
        status: 'reauth_required',
        code: 'captcha',
        message: expect.stringContaining('never solves') as unknown,
      });
    });

    it('in a sale check, which fails and is retried after the relink', async () => {
      inject('receipts', { type: 'bot_check' });
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toThrow('Depop');
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
    expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('gives a create to the user when the form offers no such category', async () => {
    const ref = newRef();
    // The category picker finds product types in groups headed by department and category:
    // Jackets are there, but in no "Men > Hovercraft" group.
    const op = request('create', ref);
    // A category Listora's copy of Depop's taxonomy has, and Depop's form no longer offers.
    if (op.payload === null) throw new Error('a create has a payload');
    const stale = { ...op, payload: { ...op.payload, category: ['Men', 'Hovercraft', 'Jackets'] } };
    expect(await adapter.execute(stale, ctx())).toMatchObject({
      type: 'pendingUser',
      excerpt: { automation: 'page_changed' },
    });
    expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('fails a read-back of a product page it no longer understands', async () => {
    const { ref } = await create();
    // The product's page and the API's read of it, both redesigned.
    site.inject({ action: 'read', fault: { type: 'redesigned' }, times: 2 });
    await expect(adapter.readListing(ref, ctx())).rejects.toThrow('element_missing');
  });

  it("reads the seller's listings for sale a page at a time, with what an import needs", async () => {
    await withSite({ pageSize: 2 }, async (fake, own) => {
      const slugs = ['Faded tee.', 'Baggy jeans.', 'Chelsea boots.'].map((description) =>
        fake.seed({ description, priceCents: 2000 }),
      );
      const sold = fake.seed({ description: 'Tote bag.', priceCents: 5000 });
      fake.sell(sold);
      fake.seed({ description: 'Not mine.', priceCents: 900, seller: 'someone-else' });
      const hashtagged = fake.seed({
        description: 'Cord cap.\n\nSKU: AJ-000001\n\n#vintage',
        // Marked down from $20.00.
        priceCents: 1250,
        originalPriceCents: 2000,
        category: ['Women', 'Dresses', 'Casual dresses'],
        size: 'S',
        brand: "Levi's",
        condition: 'used_like_new',
        colours: ['Blue', 'Khaki'],
        photos: ['front.jpg', 'back.jpg'],
      });
      const unbranded = fake.seed({ description: 'Plain tee.', priceCents: 900, brand: null });

      const listings = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await own.listListings(cursor, ctx());
        listings.push(...page.listings);
        cursor = page.next;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBeGreaterThan(1);
      expect(new Set(listings.map((listing) => listing.externalListingId))).toEqual(
        new Set([...slugs, hashtagged, unbranded]),
      );
      expect(listings.find((listing) => listing.externalListingId === hashtagged)).toEqual({
        found: true,
        externalListingId: hashtagged,
        externalUrl: `${fake.url}/products/${hashtagged}/`,
        status: 'active',
        title: null,
        description: 'Cord cap.',
        priceCents: 1250,
        currency: 'USD',
        revision: expect.any(Number) as number,
        refreshedAt: expect.any(String) as string,
        details: {
          photoUrls: [`${fake.url}/media/front.jpg`, `${fake.url}/media/back.jpg`],
          // The brand's name, not Depop's slug of it (`levi-s`).
          brand: "Levi's",
          size: 'S',
          condition: 'pre_owned_excellent',
          // Depop's ids, which name the product type; its names stop at the category.
          categoryRef: 'womenswear/dresses/casual-dresses',
          categoryPath: ['Womenswear', 'Dresses'],
          colors: ['blue'],
          originalPriceCents: 2000,
          sku: 'AJ-000001',
        },
      });
      // Depop's "Other" is no brand.
      expect(
        listings.find((listing) => listing.externalListingId === unbranded)?.details,
      ).toMatchObject({ brand: null, originalPriceCents: null });
      // Only reads: nothing on Depop changed.
      expect(fake.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    });
  });

  it('finds no sales on the sold items page of a seller without any, for sale checks', async () => {
    await withSite({}, async (fake, own) => {
      fake.seed({ description: 'Still for sale.', priceCents: 1000 });
      expect(await own.listOrdersSince(null, ctx())).toEqual([]);
    });
  });

  it("reads each sale from Depop's receipts: what the buyer paid, its listing, whether it shipped", async () => {
    await withSite({ pageSize: 2 }, async (fake, own) => {
      const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
      const offer = fake.seed({
        description: 'Denim jacket\nLight wash.',
        priceCents: 4500,
        size: 'M',
        photos: ['front.jpg', 'back.jpg'],
      });
      const offerSoldAt = at(5);
      fake.sell(offer, offerSoldAt, undefined, { paidCents: 3800 });
      const shipped = fake.seed({ description: 'Wool scarf.', priceCents: 2000 });
      fake.sell(shipped, at(4), undefined, { status: 'shipped' });
      // Sold somewhere else: no receipt, so no Depop sale.
      fake.markAsSold(fake.seed({ description: 'Cord cap.', priceCents: 1250 }), at(3));
      const canceled = fake.seed({ description: 'Silk top.', priceCents: 3000 });
      fake.sell(canceled, at(2), undefined, { status: 'cancelled' });
      const tee = fake.seed({ description: 'Band tee.', priceCents: 1500 });
      const skirt = fake.seed({ description: 'Mini skirt.', priceCents: 2500 });
      const bundle = fake.sellBundle(
        [
          { slug: tee, paidCents: 1200 },
          { slug: skirt, paidCents: 2000 },
        ],
        at(1),
      );
      fake.seed({ description: 'Still for sale.', priceCents: 1000 });

      const orders = await own.listOrdersSince(null, ctx());
      expect(orders.map((order) => order.externalOrderId)).toEqual([
        String(bundle),
        String(fake.purchaseIdOf(shipped)),
        String(fake.purchaseIdOf(offer)),
      ]);
      const [both, scarf, jacket] = orders;
      // A bundle is one order, each item at what it sold for (its receipt says so).
      expect(
        both?.items.map(({ externalListingId, priceCents }) => [externalListingId, priceCents]),
      ).toEqual([
        [tee, 1200],
        [skirt, 2000],
      ]);
      expect(both?.shipped).toBe(false);
      expect(scarf?.shipped).toBe(true);
      // An accepted offer: what the buyer paid, not the listing's price.
      expect(jacket).toEqual({
        externalOrderId: String(fake.purchaseIdOf(offer)),
        soldAt: offerSoldAt,
        shipped: false,
        // What the buyer paid less what the seller is paid: Depop's fees, from the receipt.
        fees: [
          { kind: 'marketplace', description: "Depop's fees", amountCents: 380, currency: 'USD' },
        ],
        items: [
          {
            externalListingId: offer,
            title: 'Denim jacket',
            priceCents: 3800,
            currency: 'USD',
            listing: expect.objectContaining({
              externalListingId: offer,
              status: 'sold',
              description: 'Denim jacket\nLight wash.',
              details: expect.objectContaining({
                size: 'M',
                photoUrls: [`${fake.url}/media/front.jpg`, `${fake.url}/media/back.jpg`],
              }) as unknown,
            }) as unknown,
          },
        ],
      });
      // Since a time: only the sales after it.
      expect(
        (await own.listOrdersSince(at(4.5), ctx())).map((order) => order.externalOrderId),
      ).toEqual([String(bundle), String(fake.purchaseIdOf(shipped))]);
      // Only reads: nothing on Depop changed.
      expect(fake.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    });
  });

  it('fails a sale check visibly when a receipt is not as Listora knows it, rather than guess', async () => {
    await withSite({}, async (fake, own) => {
      fake.sell(fake.seed({ description: 'Tote bag.', priceCents: 5000 }));
      fake.inject({ action: 'receipts', fault: { type: 'redesigned' } });
      await expect(own.listOrdersSince(null, ctx())).rejects.toThrow('element_missing');
    });
  });
});
