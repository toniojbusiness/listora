/**
 * The Depop automation adapter's own flows on the fake Depop site, in a real headless Chromium
 * (the shared conformance suite is in adapter.conformance.int.test.ts): every field of the sell
 * form, photos in posting order, the SKU line and hashtags, a new listing found in the seller's
 * shop by its SKU, delete and relist as a new listing, sold listings, a product Depop deleted for
 * good (410 Gone), the seller's listings for imports, sold items for sale checks, and the stops: a
 * bot-check page, a CAPTCHA, a login code, a logged-out session, and a redesigned page. No
 * traffic goes to Depop.
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

import { automationProfile } from '../profiles.ts';
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
    const own = new FakeSiteSessions(fake, runner, {
      ...profile,
      origins: [fake.url],
      cookieDomains: ['127.0.0.1'],
    });
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
      category: ['Menswear', 'Coats & jackets', 'Jackets'],
      size: 'M',
      brand: "Levi's",
      condition: 'used_excellent',
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
      // Depop's product page no longer says when the product last changed.
      revision: null,
    });
    expect(remote).toMatchObject(
      readBackState(desiredStateForContent('create', content), adapter.capabilities()),
    );
    expect(outcome).not.toHaveProperty('revision');
    // Found again by its SKU before its slug is known, the way a timed-out create is.
    expect(await adapter.readListing({ ...ref, externalListingId: null }, ctx())).toEqual(remote);
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

  it('posts without a brand Depop does not list, and picks a brand it does whatever the case', async () => {
    const unknown = await create(sampleListingContent({ item: { brand: 'Handmade Studio' } }));
    expect(site.product(unknown.ref.externalListingId)?.brand).toBeNull();
    const cased = await create(sampleListingContent({ item: { brand: 'ADIDAS' } }));
    expect(site.product(cased.ref.externalListingId)?.brand).toBe('adidas');
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
      category: ['Womenswear', 'Footwear', 'Boots'],
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
      category: ['Womenswear', 'Footwear', 'Boots'],
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
      inject('sold', { type: 'login_challenge' });
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toThrow('Depop');
      expect(sessions.challenges).toEqual(['login_challenge']);
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
    const content = sampleListingContent({
      variant: { categoryRef: 'Menswear > Hovercraft > Jackets' },
    });
    expect(await adapter.execute(request('create', ref, { content }), ctx())).toMatchObject({
      type: 'pendingUser',
      excerpt: { automation: 'page_changed' },
    });
    expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('fails a read-back of a product page it no longer understands', async () => {
    const { ref } = await create();
    inject('read', { type: 'redesigned' });
    await expect(adapter.readListing(ref, ctx())).rejects.toThrow('element_missing');
  });

  it("lists the seller's listings for sale across pages, for imports and drift checks", async () => {
    await withSite({ pageSize: 2 }, async (fake, own) => {
      const slugs = ['Faded tee.', 'Baggy jeans.', 'Chelsea boots.'].map((description) =>
        fake.seed({ description, priceCents: 2000 }),
      );
      const sold = fake.seed({ description: 'Tote bag.', priceCents: 5000 });
      fake.sell(sold);
      fake.seed({ description: 'Not mine.', priceCents: 900, seller: 'someone-else' });
      const hashtagged = fake.seed({
        description: 'Cord cap.\n\nSKU: AJ-000001\n\n#vintage',
        priceCents: 1250,
      });

      const { listings, complete } = await own.listListings(ctx());
      expect(complete).toBe(true);
      expect(new Set(listings.map((listing) => listing.externalListingId))).toEqual(
        new Set([...slugs, hashtagged]),
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
        revision: fake.product(hashtagged)?.updatedAt.getTime(),
      });
    });
  });

  it('finds sold items since a time, newest first across pages, for sale checks', async () => {
    await withSite({ pageSize: 2 }, async (fake, own) => {
      const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
      const [, older, recent, fresh] = [
        ['Old sale.', 72],
        ['Older sale.', 5],
        ['Recent sale.', 3],
        ['Fresh sale.', 1],
      ].map(([description, hoursAgo]) => {
        const slug = fake.seed({ description: String(description), priceCents: 3050 });
        fake.sell(slug, at(Number(hoursAgo)));
        return slug;
      });
      fake.seed({ description: 'Still for sale.', priceCents: 1000 });

      const orders = await own.listOrdersSince(at(24), ctx());
      expect(orders.map((order) => order.externalOrderId)).toEqual([fresh, recent, older]);
      expect(orders[0]).toEqual({
        externalOrderId: fresh,
        soldAt: expect.any(Date) as unknown,
        items: [{ externalListingId: fresh, title: null, priceCents: 3050, currency: 'USD' }],
      });
      expect(await own.listOrdersSince(null, ctx())).toHaveLength(4);
    });
  });
});
