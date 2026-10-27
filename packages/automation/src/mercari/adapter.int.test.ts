/**
 * The Mercari automation adapter's own flows on the fake Mercari site, in a real headless
 * Chromium (the shared conformance suite is in adapter.conformance.int.test.ts): every field of
 * the sell form, photos in posting order, the SKU line, deactivate and activate, sold listings,
 * the seller's listings for imports, sold items for sale checks, Mercari's refusals (an account
 * to verify, a card to add), and the stops: Cloudflare's interstitial and Turnstile, a CAPTCHA,
 * a login code, a logged-out session, and a redesigned page. No traffic goes to Mercari.
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
import {
  FAKE_MERCARI_LABEL,
  FakeMercariSite,
  type FakeMercariAction,
  type FakeMercariFault,
} from './fake/fake-mercari.ts';
import type { MercariListingPayload } from './payload.ts';

const connection = { id: 'connection-mercari', mode: 'automation', status: 'connected' } as const;
/**
 * The step timeout here: the form step (three times it) has room for the form's own wait for a
 * part that never comes (8 seconds), which several checks below run into, and for two brand
 * searches that find nothing (4 seconds each) before Mercari's "No brand".
 */
const STEP_TIMEOUT_MS = 6_000;
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
      stepTimeoutMs: STEP_TIMEOUT_MS,
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

  /** The adapter on a fake Mercari site of a test's own, in the shared browser. */
  function adapterOn(other: FakeMercariSite) {
    const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };
    return createMercariAutomationAdapter({
      siteUrl: other.url,
      profile,
      sessions: new FakeSiteSessions(other, runner, {
        ...profile,
        origins: [other.url],
        cookieDomains: ['127.0.0.1'],
      }),
      photos: stubPhotos,
      logger: silentLogger,
    });
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
      size: 'M (38-40)',
      shippingPayer: 'Buyer',
      shippingWeight: FAKE_MERCARI_LABEL,
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
    // Mercari's page after List is not the listing's, so the read-back gives the revision.
    expect(outcome).not.toHaveProperty('revision');
    // Found again by its SKU before its id is known, the way a timed-out create is.
    expect(await adapter.readListing({ ...ref, externalListingId: null }, ctx())).toEqual(remote);
  });

  it('picks a brand Mercari lists whatever its case', async () => {
    const cased = await create(sampleListingContent({ item: { brand: 'ADIDAS' } }));
    expect(site.item(cased.ref.externalListingId)?.brand).toBe('adidas');
  });

  it("picks Mercari's own spelling of a brand, and its No brand for one it doesn't list", async () => {
    const spelled = await create(
      sampleListingContent({ item: { brand: 'Abercrombie and Fitch' } }),
    );
    expect(site.item(spelled.ref.externalListingId)?.brand).toBe('Abercrombie & Fitch');
    // Mercari needs a brand: its "No brand / Not sure"; the title still names the item's.
    const unlisted = await create(sampleListingContent({ item: { brand: 'Handmade Studio' } }));
    expect(site.item(unlisted.ref.externalListingId)?.brand).toBeNull();
    const none = await create(sampleListingContent({ item: { brand: null } }));
    expect(site.item(none.ref.externalListingId)?.brand).toBeNull();
  }, 90_000);

  it('fills every kind of form Mercari has: each size list, and none', async () => {
    // A category of each of Mercari's size groups (catalog/catalog.json), with a size of the
    // item's own, and the label the form must get.
    const shapes = [
      ['Women > Dresses > Midi', 'women', '8', 'M (8-10)'],
      ['Men > Tops > T-shirts', 'men', 'XXL', 'XXL (50-52)'],
      ['Women > Jeans > Skinny Jeans', 'women', 'W29 L30', '29 in.'],
      ['Men > Suits > Two button', 'men', '40R', '40R'],
      ['Women > Shoes > Boots', 'women', '8 1/2', '8.5 (39)'],
      ['Kids > Girls dresses > Girls 2T-5T', 'kids', '3T', '3T'],
      ['Kids > Boys shoes > Boys (4+)', 'kids', '2.5', '2.5'],
      ['Men > Shoes > Athletic', 'men', '10', '10 (43)'],
      ['Women > Underwear > Bras', 'women', '34DD', '34E (DD)'],
      ['Home > Bedding > Quilts', 'women', null, null],
      ['Beauty > Makeup > Lips', 'women', null, null],
    ] as const;
    for (const [categoryRef, department, sizeLabel, size] of shapes) {
      const content = sampleListingContent({
        item: { department, sizeLabel, condition: 'new_with_tags' },
        variant: { categoryRef },
      });
      expect(
        adapter.validate(adapter.buildPayload(content.item, content.variant)),
        categoryRef,
      ).toEqual([]);
      const { ref } = await create(content);
      expect(site.item(ref.externalListingId), categoryRef).toMatchObject({
        category: categoryRef.split(' > '),
        size,
      });
    }
  }, 240_000);

  it("picks a women's petite or tall size in its own part of the size list", async () => {
    const shapes = [
      ['Women > Dresses > Maxi', '4P', 'S (4-6)', 'Petite'],
      ['Women > Skirts > Pleated', 'S Petite', 'S (4-6)', 'Petite'],
      ['Women > Pants > Casual pants', 'XL Tall', 'XL (16-18)', 'Tall'],
      ['Women > Shorts > Denim', '0', 'XS (0-2)', 'Standard'],
      ['Women > Jeans > Straight leg', '27/4', '27 in.', 'Inch'],
    ] as const;
    for (const [categoryRef, sizeLabel, size, sizeSet] of shapes) {
      const content = sampleListingContent({
        item: { department: 'women', sizeLabel, sizeSystem: null, condition: 'new_with_tags' },
        variant: { categoryRef },
      });
      const { ref } = await create(content);
      expect(site.item(ref.externalListingId), sizeLabel).toMatchObject({ size, sizeSet });
    }
  }, 120_000);

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
      variant: { title: 'Dr. Martens 1460 Boots', description: 'Worn and resoled, still sturdy.' },
    });
    const outcome = await adapter.execute(request('revise', ref, { content }), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed', externalListingId: ref.externalListingId });
    expect(site.item(ref.externalListingId)).toMatchObject({
      title: 'Dr. Martens 1460 Boots',
      category: ['Women', 'Shoes', 'Boots'],
      size: '8.5 (39)',
      conditionId: 4,
      brand: 'Dr. Martens',
      shippingWeight: FAKE_MERCARI_LABEL,
      photos: ['front.jpg', 'back.jpg', 'tag.jpg'],
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject(
      desiredStateForContent('revise', content),
    );
  });

  it('deactivates to end and activates the same listing to relist, from the edit page alone', async () => {
    const { ref } = await create();
    // The edit page says whether the listing is active: the listing's own page isn't opened.
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
      type: 'confirmed',
      excerpt: { steps: ['open the editor', 'deactivate'] },
    });
    expect(site.item(ref.externalListingId)?.status).toBe('inactive');
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'ended' });
    // Ending it again changes nothing: the edit page shows it inactive already.
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
      type: 'confirmed',
      excerpt: { steps: ['open the editor'] },
    });
    expect(await adapter.execute(request('relist', ref), ctx())).toMatchObject({
      type: 'confirmed',
      externalListingId: ref.externalListingId,
      excerpt: { steps: ['open the editor', 'activate'] },
    });
    expect(site.item(ref.externalListingId)?.status).toBe('on_sale');
    expect(site.items().filter((item) => item.id === ref.externalListingId)).toHaveLength(1);
  });

  it('relists a listing deleted on Mercari by posting it again, with its own id', async () => {
    const { ref } = await create();
    site.remove(ref.externalListingId);
    const outcome = await adapter.execute(request('relist', ref), ctx());
    const [posted, ...more] = site.itemsWithSku(ref.externalSku ?? '');
    expect(more).toEqual([]);
    expect(posted?.id).not.toBe(ref.externalListingId);
    expect(outcome).toMatchObject({ type: 'confirmed', externalListingId: posted?.id });
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
    // Ending it deactivates nothing: Mercari shows no editor for it, and its page says it sold.
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
      type: 'confirmed',
      excerpt: { steps: ['open the editor', 'open the listing'] },
    });
    expect(site.item(ref.externalListingId)?.status).not.toBe('inactive');
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
        failure: { code: 'element_missing', step: 'open the sell page' },
      },
    });
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('refuses a create when Mercari asks the seller to verify their account first', async () => {
    const ref = newRef();
    inject('form', { type: 'verification_required' });
    const before = site.requests.length;
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'rejected',
      code: 'account_verification_required',
      message: expect.stringContaining('verify your account') as unknown,
    });
    expect(site.requests.slice(before).filter((entry) => entry.method === 'POST')).toEqual([]);
  });

  it('refuses a create when Mercari asks for a card on file before it lists', async () => {
    const ref = newRef();
    inject('create', { type: 'card_required' });
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'rejected',
      code: 'validation_failed',
      message: expect.stringContaining('credit or debit card') as unknown,
    });
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it("finds a new listing by its SKU when Mercari's page after List does not link to it", async () => {
    const shop = await FakeMercariSite.start(0, { listedPageLinksItem: false });
    try {
      const ref = newRef();
      const outcome = await adapterOn(shop).execute(request('create', ref), ctx());
      const listed = shop.itemsWithSku(ref.externalSku ?? '');
      expect(listed).toHaveLength(1);
      expect(outcome).toMatchObject({ type: 'confirmed', externalListingId: listed[0]?.id });
    } finally {
      await shop.close();
    }
  });

  it("refuses a category Mercari's catalog doesn't have before anything is sent", () => {
    const content = sampleListingContent({ variant: { categoryRef: 'Men > Hovercraft > Parts' } });
    expect(adapter.validate(adapter.buildPayload(content.item, content.variant))).toMatchObject([
      { field: 'variant.categoryRef', code: 'required' },
    ]);
  });

  it('gives a create to the user when the form no longer offers the category', async () => {
    const shop = await FakeMercariSite.start(0, { withoutCategories: ['Men > Coats & jackets'] });
    try {
      const ref = newRef();
      expect(await adapterOn(shop).execute(request('create', ref), ctx())).toMatchObject({
        type: 'pendingUser',
        excerpt: { automation: 'page_changed' },
      });
      expect(shop.items()).toHaveLength(0);
    } finally {
      await shop.close();
    }
  });

  it("stops at Mercari's warning that a listing may be prohibited, and never continues", async () => {
    const ref = newRef();
    inject('create', {
      type: 'item_warning',
      message: 'This item may violate our Prohibited Items policy.',
    });
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'rejected',
      code: 'validation_failed',
      message: expect.stringContaining(
        'This item may violate our Prohibited Items policy.',
      ) as unknown,
    });
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('gives a device to the seller when the form asks for its IMEI, sending nothing', async () => {
    // A category the catalog doesn't know asks for one: the form's field stops the create.
    const tablets = 'Electronics > Tablets & E-readers > iPad/tablet/ebook readers';
    const shop = await FakeMercariSite.start(0, { imeiCategories: [tablets] });
    try {
      const ref = newRef();
      const content = sampleListingContent({ variant: { categoryRef: tablets } });
      const before = shop.requests.length;
      expect(
        await adapterOn(shop).execute(request('create', ref, { content }), ctx()),
      ).toMatchObject({
        type: 'rejected',
        code: 'imei_required',
      });
      expect(shop.requests.slice(before).filter((entry) => entry.method === 'POST')).toEqual([]);
    } finally {
      await shop.close();
    }
  });

  it('fails a read-back of a listing page it no longer understands', async () => {
    const { ref } = await create();
    inject('read', { type: 'redesigned' });
    await expect(adapter.readListing(ref, ctx())).rejects.toThrow('element_missing');
  });

  it("reads the seller's listings for sale a page at a time, with what an import needs", async () => {
    const seller = await FakeMercariSite.start(0, { pageSize: 2 });
    try {
      const own = adapterOn(seller);
      const ids = ['Tee', 'Jeans'].map((title) => seller.seed({ title, priceCents: 2000 }));
      seller.seed({ title: 'Hat', priceCents: 1200, status: 'inactive' });
      const sold = seller.seed({ title: 'Bag', priceCents: 5000 });
      seller.sell(sold);
      seller.seed({ title: 'Not mine', priceCents: 900, seller: 'someone-else' });
      const dress = seller.seed({
        title: 'Floral maxi dress',
        description: 'Worn once.\n\nSKU: AJ-000007',
        priceCents: 3400,
        category: ['Women', 'Dresses', 'Maxi'],
        brand: 'Free People',
        size: 'S',
        conditionId: 2,
        photos: ['front.jpg', 'back.jpg'],
      });

      const listings = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await own.listListings(cursor, ctx());
        listings.push(...page.listings);
        cursor = page.next;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(2);
      // Only listings for sale: not the deactivated one, the sold one, or another seller's.
      expect(new Set(listings.map((listing) => listing.externalListingId))).toEqual(
        new Set([...ids, dress]),
      );
      expect(listings.find((listing) => listing.externalListingId === dress)).toEqual({
        found: true,
        externalListingId: dress,
        externalUrl: `${seller.url}/us/item/${dress}/`,
        status: 'active',
        title: 'Floral maxi dress',
        description: 'Worn once.',
        priceCents: 3400,
        currency: 'USD',
        revision: expect.any(Number) as number,
        details: {
          photoUrls: [
            `${seller.url}/media/${dress}-0-front.jpg`,
            `${seller.url}/media/${dress}-1-back.jpg`,
          ],
          brand: 'Free People',
          size: 'S',
          condition: 'pre_owned_excellent',
          categoryRef: 'Women > Dresses > Maxi',
          categoryPath: ['Women', 'Dresses', 'Maxi'],
          sku: 'AJ-000007',
        },
      });
      expect(seller.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    } finally {
      await seller.close();
    }
  });

  it('finds sold items waiting to ship and done, since a time, for sale checks', async () => {
    const shop = await FakeMercariSite.start(0, { pageSize: 2 });
    try {
      const own = adapterOn(shop);
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
