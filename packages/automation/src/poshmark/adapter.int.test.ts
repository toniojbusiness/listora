/**
 * The Poshmark automation adapter's own flows, in a real headless Chromium on the fake Poshmark
 * (beyond the shared conformance suite): reading each page's data where Poshmark keeps it, every
 * form field and the photo order, not for sale and back, the private SKU lookup that keeps a
 * retried create from posting twice, the closet listing and sold items across closet pages, and
 * every check and page change that has to stop the run and hand the step to the user. No real
 * Poshmark traffic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  ListingRef,
  OperationRequest,
  WriteOperationKind,
} from '@listora/marketplaces';
import { desiredStateForContent, isContentKind } from '@listora/marketplaces';
import { sampleListingContent, type SampleContentOverrides } from '@listora/marketplaces/testing';

import type { PhotoSource } from '../adapter/photos.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { loadChromium } from '../runner/playwright.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, testRunner } from '../test-support.ts';
import { createPoshmarkAutomationAdapter } from './adapter.ts';
import { FakePoshmark } from './fake/fake-poshmark.ts';
import type { PoshmarkListingPayload } from './payload.ts';

/** Each photo's bytes are as long as its position says, so the posting order is visible. */
const sizedPhotos: PhotoSource = {
  fetch: (url) => {
    const length = { 'front.jpg': 10, 'back.jpg': 20, 'tag.jpg': 30 }[url.split('/').at(-1) ?? ''];
    return Promise.resolve({
      name: url.split('/').at(-1) ?? 'photo.jpg',
      mimeType: 'image/jpeg',
      bytes: Buffer.alloc(length ?? 5, 0xff),
    });
  },
};

describe('Poshmark automation adapter (headless Chromium, fake Poshmark)', () => {
  let site: FakePoshmark;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createPoshmarkAutomationAdapter>;
  const { runner } = testRunner({ stepTimeoutMs: 4_000 });
  const connection = {
    id: 'connection-poshmark',
    mode: 'automation',
    status: 'connected',
  } as const;
  const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });
  let sequence = 0;

  beforeAll(async () => {
    site = await FakePoshmark.start(0, { pageSize: 3 });
    const profile = {
      ...standInProfile(automationProfile('poshmark'), site.url),
      pacing: QUICK_PACING,
    };
    sessions = new FakeSiteSessions(site, runner, profile);
    adapter = createPoshmarkAutomationAdapter({
      profile,
      sessions,
      photos: sizedPhotos,
      logger: silentLogger,
      settleWaitMs: 50,
    });
  });

  afterEach(() => {
    site.clearFaults();
    site.reviewChanges(false);
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  function newRef(): ListingRef {
    sequence += 1;
    return {
      listingId: `listing-${String(sequence)}`,
      externalListingId: null,
      externalSku: `AJ-${String(sequence).padStart(6, '0')}`,
      externalUrl: null,
    };
  }

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    overrides: SampleContentOverrides = {},
    desired?: OperationRequest['desired'],
  ): OperationRequest<PoshmarkListingPayload> {
    const content = sampleListingContent(overrides);
    return {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: `key-${listing.listingId}-${kind}`,
      attempt: 1,
      listing,
      desired: desired ?? (isContentKind(kind) ? desiredStateForContent(kind, content) : {}),
      payload: isContentKind(kind) ? adapter.buildPayload(content.item, content.variant) : null,
    };
  }

  async function create(overrides: SampleContentOverrides = {}) {
    const ref = newRef();
    const outcome = await adapter.execute(request('create', ref, overrides), ctx());
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(`create: ${JSON.stringify(outcome)}`);
    }
    return { ...ref, externalListingId: outcome.externalListingId };
  }

  it('lists with every field, the photos in posting order, and the private SKU', async () => {
    const ref = await create({
      item: { brand: 'Madewell', department: 'women', category: 'clothing/tops/blouses' },
      variant: {
        title: 'Madewell Silk Blouse',
        aspects: [
          { name: 'Size', values: ['Small'] },
          { name: 'Original Price', values: ['$128'] },
        ],
      },
    });
    expect(site.listing(ref.externalListingId)).toMatchObject({
      sku: ref.externalSku,
      title: 'Madewell Silk Blouse',
      description: 'Classic trucker jacket in medium wash. Light fading at the cuffs.',
      brand: 'Madewell',
      department: 'Women',
      category: 'Tops',
      subcategory: 'Blouses',
      sizeSet: 'Standard',
      size: 'S',
      condition: 'uln',
      priceCents: 4500,
      originalPriceCents: 12_800,
      inventory: 'available',
      // front, back, tag: the cover first.
      photoSizes: [10, 20, 30],
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      found: true,
      status: 'active',
      title: 'Madewell Silk Blouse',
      priceCents: 4500,
    });
    const read = await adapter.readListing(ref, ctx());
    expect(read.found && Number.isSafeInteger(read.revision)).toBe(true);
  });

  it("fills every shape of Poshmark's form: sizes by their labels, one size, groups, kids, colors", async () => {
    // A men's shirt in a neck size, whose button reads "Neck 15.5", new with tags.
    const shirt = await create({
      item: {
        department: 'men',
        category: 'clothing/tops/shirts',
        sizeLabel: '15.5',
        condition: 'new_with_tags',
        colors: ['navy', 'white'],
      },
      variant: { aspects: [] },
    });
    expect(site.listing(shirt.externalListingId)).toMatchObject({
      department: 'Men',
      category: 'Shirts',
      subcategory: 'Casual Button Down Shirts',
      sizeSet: 'Standard',
      size: '15.5',
      condition: 'nwt',
      colors: ['Blue', 'White'],
    });
    // A one-size category, whose form chooses its size by itself.
    const lamp = await create({
      item: { department: null, category: 'home/decor', sizeLabel: null, colors: [] },
      variant: { aspects: [] },
    });
    expect(site.listing(lamp.externalListingId)).toMatchObject({
      department: 'Home',
      category: 'Accents',
      subcategory: 'Decor',
      size: 'OS',
    });
    // A category in a display group, named by the listing.
    const kurta = await create({
      item: { department: 'women', sizeLabel: 'M' },
      variant: { aspects: [], categoryRef: 'Women/Kurtas' },
    });
    expect(site.listing(kurta.externalListingId)).toMatchObject({
      category: 'Kurtas',
      subcategory: null,
      size: 'M',
    });
    // A kids' size, under the set the size names.
    const tee = await create({
      item: { department: 'kids', category: 'clothing/tops/t_shirts', sizeLabel: 'Boys 8' },
      variant: { aspects: [] },
    });
    expect(site.listing(tee.externalListingId)).toMatchObject({
      department: 'Kids',
      category: 'Shirts & Tops',
      subcategory: 'Tees - Short Sleeve',
      sizeSet: 'Boys',
      size: '8B',
    });
  });

  it('changes a listing Poshmark is reviewing, and reads it live only once Poshmark publishes it', async () => {
    const ref = await create();
    site.reviewChanges(true);
    const price = request('price', ref, {}, { priceCents: 5000, currency: 'USD' });
    expect(await adapter.execute(price, ctx())).toMatchObject({ type: 'confirmed' });
    // Under review, buyers can't buy it: not live yet, but not gone either.
    expect(await adapter.readListing(ref, ctx())).toEqual({ found: false, authoritative: false });
    // Its seller can still end it, and an ended listing reads as ended, reviewed or not.
    // The edit form shows it for sale, so End changes it there: no read of its page first, and
    // none after Update (the operation's read-back reads it).
    const end = await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx());
    expect(end).toMatchObject({
      type: 'confirmed',
      externalListingId: ref.externalListingId,
      excerpt: { steps: ['open the edit form', 'set the availability', 'update'] },
    });
    expect(site.listing(ref.externalListingId)).toMatchObject({
      inventory: 'not_for_sale',
      priceCents: 5000,
      reviewing: true,
    });
    const relist = await adapter.execute(request('relist', ref, {}, { status: 'active' }), ctx());
    expect(relist.type).not.toBe('rejected');
    site.publish(ref.externalListingId);
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      found: true,
      status: 'active',
      priceCents: 5000,
    });
  });

  it('moves a listing to another department, subcategory, size, and colors on revise', async () => {
    const ref = await create({
      item: { department: 'women', category: 'clothing/tops/blouses', colors: ['red'] },
      variant: { aspects: [{ name: 'Size', values: ['S'] }] },
    });
    const revise = request('revise', ref, {
      item: { department: 'men', category: 'clothing/bottoms/jeans', colors: ['blue', 'black'] },
      variant: { aspects: [{ name: 'Size', values: ['32x30'] }] },
    });
    expect(await adapter.execute(revise, ctx())).toMatchObject({ type: 'confirmed' });
    expect(site.listing(ref.externalListingId)).toMatchObject({
      department: 'Men',
      category: 'Jeans',
      // The picker's "None": the blouse's subcategory is not kept.
      subcategory: null,
      sizeSet: 'Standard',
      size: '32',
      colors: ['Blue', 'Black'],
    });
  });

  it('confirms a new listing on its own page, by the id its form named, not in the closet', async () => {
    const ref = newRef();
    const before = site.requests.length;
    const outcome = await adapter.execute(request('create', ref), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed' });
    const id = outcome.type === 'confirmed' ? (outcome.externalListingId ?? '') : '';
    expect(site.listing(id)).toMatchObject({ sku: ref.externalSku });
    // After List (whose answer is the closet), only the new listing's own page is read: the
    // closet, which can lag, is not searched.
    const seen = site.requests.slice(before);
    const listed = seen.findIndex((request) => request.action === 'create');
    expect(seen.slice(listed + 1).map((request) => request.action)).toEqual(['closet', 'listing']);
  });

  it('edits details and price, ends as not for sale, and relists, each with a newer revision', async () => {
    const ref = await create();
    const read = async () => {
      const remote = await adapter.readListing(ref, ctx());
      if (!remote.found) throw new Error('not found');
      return remote;
    };
    const first = await read();

    const revise = request('revise', ref, {
      variant: {
        title: 'Levi Trucker Jacket Size M',
        description: 'Updated.',
        price: { amountCents: 4000, currency: 'USD' },
      },
    });
    expect(await adapter.execute(revise, ctx())).toMatchObject({ type: 'confirmed' });
    const revised = await read();
    expect(revised).toMatchObject({
      title: 'Levi Trucker Jacket Size M',
      description: 'Updated.',
      priceCents: 4000,
    });
    expect(revised.revision ?? 0).toBeGreaterThan(first.revision ?? 0);

    const end = await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx());
    expect(end).toMatchObject({ type: 'confirmed' });
    const ended = await read();
    expect(ended.status).toBe('ended');
    expect(site.listing(ref.externalListingId)?.inventory).toBe('not_for_sale');
    expect(ended.revision ?? 0).toBeGreaterThan(revised.revision ?? 0);

    // Ending it again changes nothing: the edit form shows it not for sale already.
    expect(
      await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx()),
    ).toMatchObject({ type: 'confirmed', excerpt: { steps: ['open the edit form'] } });
    expect(
      await adapter.execute(request('relist', ref, {}, { status: 'active' }), ctx()),
    ).toMatchObject({
      type: 'confirmed',
      excerpt: { steps: ['open the edit form', 'set the availability', 'update'] },
    });
    expect(await read()).toMatchObject({ status: 'active', title: 'Levi Trucker Jacket Size M' });
  });

  it('refuses to relist a sold listing, and never lists a price Poshmark would refuse', async () => {
    const ref = await create();
    site.sell(ref.externalListingId);
    expect(
      await adapter.execute(request('relist', ref, {}, { status: 'active' }), ctx()),
    ).toMatchObject({
      type: 'rejected',
      code: 'sold',
    });
    expect(
      await adapter.execute(
        request('price', ref, {}, { priceCents: 3950, currency: 'USD' }),
        ctx(),
      ),
    ).toMatchObject({ type: 'rejected', code: 'out_of_range' });
  });

  it('reads only a deleted listing as gone, and changes nothing on one Poshmark hides', async () => {
    const deleted = await create();
    site.remove(deleted.externalListingId);
    expect(await adapter.readListing(deleted, ctx())).toEqual({
      found: false,
      authoritative: true,
    });

    // Poshmark hides a listing it removed under its rules: its page answers 404 as well, but
    // the listing may be shown again, so it is not gone, and End and Relist say why they can't.
    const hidden = await create();
    site.hide(hidden.externalListingId);
    expect(await adapter.readListing(hidden, ctx())).toEqual({
      found: false,
      authoritative: false,
    });
    for (const [kind, desired] of [
      ['end', { status: 'ended' }],
      ['relist', { status: 'active' }],
    ] as const) {
      expect(await adapter.execute(request(kind, hidden, {}, desired), ctx())).toMatchObject({
        type: 'rejected',
        code: 'hidden',
        message:
          'Poshmark is hiding this listing, as it does with a listing it removed under its rules.',
      });
    }
  });

  it('finds an earlier attempt by its private SKU among listings with the same title', async () => {
    const title = 'Same Title Every Time';
    // Other listings with the same title, listed by hand and by another seller.
    site.seed({ title, priceCents: 2000, sku: 'SOMEONE-ELSE' });
    site.seed({ title, priceCents: 2000, sku: 'X', seller: 'other_closet' });
    const ref = newRef();
    const op = request('create', ref, { variant: { title } });
    const first = await adapter.execute(op, ctx());
    site.seed({ title, priceCents: 2000, sku: 'LISTED-LATER' });
    const again = await adapter.execute({ ...op, attempt: 2 }, ctx());
    expect(first).toMatchObject({ type: 'confirmed' });
    expect(again).toMatchObject({
      type: 'confirmed',
      externalListingId: first.type === 'confirmed' ? first.externalListingId : '',
    });
    expect(site.listings(ref.externalSku ?? '')).toHaveLength(1);
    // A read without the id finds it the same way.
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      found: true,
      externalListingId: first.type === 'confirmed' ? first.externalListingId : '',
    });
  });

  it('finds the seller where Poshmark keeps them: an id in auth, the handle in userCookies', async () => {
    // Read 2026-10-26 in Poshmark's own app: `auth.identity` is the user's id, and the handle
    // closets are addressed by is `userCookies.userInfo` (`username`, else `dh`). Reading a
    // handle from `auth.identity` failed every check on a real Poshmark session.
    const body = new URLSearchParams({
      'login_form[username_email]': 'shape_check',
      'login_form[password]': 'x',
    });
    const login = await fetch(`${site.url}/login`, { method: 'POST', body, redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const html = await (await fetch(`${site.url}/create-listing`, { headers: { cookie } })).text();
    const marker = 'window.__INITIAL_STATE__=';
    const start = html.indexOf(marker) + marker.length;
    const state = JSON.parse(html.slice(start, html.indexOf(';(function()', start))) as {
      auth: { identity: unknown };
      userCookies: { userInfo?: { dh?: string } };
    };
    expect(typeof state.auth.identity).toBe('string');
    expect(state.userCookies.userInfo?.dh).toBe('shape_check');
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it("reads each page's data from its global once the script that embedded it removed itself", async () => {
    // Poshmark's embedding script takes itself out of the page as soon as it ran, so a ready
    // page has no trace of it in its markup (the fake does the same). Reading the markup made
    // every session check on a real Poshmark session fail as a page Listora no longer understood.
    const browser = await (await loadChromium()).launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${site.url}/closet/listora_closet`, { waitUntil: 'domcontentloaded' });
      expect(
        await page.evaluate(`({
          inMarkup: document.documentElement.outerHTML.includes('__INITIAL_STATE__'),
          inGlobal: '__INITIAL_STATE__' in window,
        })`),
      ).toEqual({ inMarkup: false, inGlobal: true });
    } finally {
      await browser.close();
    }
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it("reads the seller's listings for sale with what an import needs, and finds sold items for sale checks", async () => {
    const before = new Date(Date.now() - 1000);
    const sold = await create({ variant: { title: 'Sold Jacket' } });
    site.sell(sold.externalListingId);
    const dress = site.seed({
      title: 'Floral maxi dress',
      description: 'Worn once.\n\nSKU: AJ-000009',
      priceCents: 3800,
      seller: 'listora_closet',
      brand: 'Free People',
      department: 'Women',
      category: 'Dresses',
      subcategory: 'Maxi',
      size: 'S',
      condition: 'uln',
      photoSizes: [4, 4, 4],
    });
    const listings = [];
    let cursor: string | null = null;
    do {
      const shown = await adapter.listListings(cursor, ctx());
      listings.push(...shown.listings);
      cursor = shown.next;
    } while (cursor !== null);
    const page = { listings };
    const forSale = site
      .listings()
      .filter(
        (listing) => listing.seller === 'listora_closet' && listing.inventory === 'available',
      );
    expect(page.listings.map((listing) => listing.externalListingId).sort()).toEqual(
      forSale.map((listing) => listing.id).sort(),
    );
    expect(page.listings.map((listing) => listing.externalListingId)).not.toContain(
      sold.externalListingId,
    );
    expect(page.listings.find((listing) => listing.externalListingId === dress)).toMatchObject({
      status: 'active',
      title: 'Floral maxi dress',
      priceCents: 3800,
      details: {
        photoUrls: [0, 1, 2].map((index) => `${site.url}/media/${dress}-${String(index)}.jpg`),
        brand: 'Free People',
        size: 'S',
        condition: 'pre_owned_excellent',
        categoryRef: 'Women/Dresses/Maxi',
        categoryPath: ['Women', 'Dresses', 'Maxi'],
        sku: 'AJ-000009',
      },
    });

    const orders = await adapter.listOrdersSince(before, ctx());
    const order = orders.find(
      (found) => found.externalOrderId === `listing:${sold.externalListingId}`,
    );
    expect(order?.soldAt).toBeInstanceOf(Date);
    expect(order).toEqual({
      externalOrderId: `listing:${sold.externalListingId}`,
      soldAt: order?.soldAt,
      items: [
        {
          externalListingId: sold.externalListingId,
          title: 'Sold Jacket',
          priceCents: 4500,
          currency: 'USD',
        },
      ],
    });
    expect(await adapter.listOrdersSince(new Date(Date.now() + 60_000), ctx())).toEqual([]);
  });

  describe('stops at every check and hands the step to the user', () => {
    const checks = [
      { fault: { type: 'captcha' }, challenge: 'captcha' },
      { fault: { type: 'bot_check' }, challenge: 'bot_check' },
      { fault: { type: 'login_challenge' }, challenge: 'login_challenge' },
      { fault: { type: 'session_expired' }, challenge: 'session_rejected' },
      { fault: { type: 'offsite' }, challenge: 'unexpected_page' },
    ] as const;

    for (const { fault, challenge } of checks) {
      it(`a ${fault.type} on the listing form`, async () => {
        const ref = newRef();
        const requestsBefore = site.requests.length;
        site.inject({ action: 'new_form', fault });
        const outcome = await adapter.execute(request('create', ref), ctx());
        expect(outcome).toMatchObject({
          type: 'pendingUser',
          task: { kind: 'list_manually', payload: { action: 'create' } },
          excerpt: { automation: 'challenge', mutated: false },
        });
        expect(sessions.challenges.at(-1)).toBe(challenge);
        expect(site.listings(ref.externalSku ?? '')).toHaveLength(0);
        // Nothing ran after the check: no listing was submitted.
        expect(site.requests.slice(requestsBefore).some((seen) => seen.method === 'POST')).toBe(
          false,
        );
      });
    }

    it('a CAPTCHA in the middle of an edit, before anything is saved', async () => {
      const ref = await create();
      site.inject({ action: 'edit_form', fault: { type: 'captcha' } });
      const outcome = await adapter.execute(
        request('price', ref, {}, { priceCents: 3000, currency: 'USD' }),
        ctx(),
      );
      expect(outcome).toMatchObject({
        type: 'pendingUser',
        task: { kind: 'edit_manually' },
        excerpt: { automation: 'challenge' },
      });
      expect(site.listing(ref.externalListingId)?.priceCents).toBe(4500);
    });

    it('a check during a read-back makes the read fail, never report the listing', async () => {
      const ref = await create();
      site.inject({ action: 'listing', fault: { type: 'captcha' } });
      await expect(adapter.readListing(ref, ctx())).rejects.toThrow(/Poshmark/);
      site.inject({ action: 'new_form', fault: { type: 'session_expired' } });
      expect(await adapter.healthCheck(ctx())).toMatchObject({ status: 'reauth_required' });
    });

    it('a redesigned page the adapter no longer understands', async () => {
      const ref = newRef();
      site.inject({ action: 'new_form', fault: { type: 'redesign' } });
      // A first attempt goes straight to the form: nothing before it could have posted.
      const outcome = await adapter.execute(request('create', ref), ctx());
      expect(outcome).toMatchObject({
        type: 'pendingUser',
        excerpt: {
          automation: 'page_changed',
          failure: { kind: 'error', code: 'element_missing', step: 'open the listing form' },
        },
      });
      expect(site.listings(ref.externalSku ?? '')).toHaveLength(0);
    });
  });

  it('signs a seller in by hand, as the app does when linking in development', async () => {
    const body = new URLSearchParams({
      'login_form[username_email]': 'closet_queen',
      'login_form[password]': 'anything',
    });
    const response = await fetch(`${site.url}/login`, { method: 'POST', body, redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/closet/closet_queen');
    const token = /_web_session=([0-9a-f]+);/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    expect(site.sessionValid(token ?? '')).toBe(true);
    const refused = await fetch(`${site.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ 'login_form[username_email]': 'closet_queen' }),
      redirect: 'manual',
    });
    expect(refused.status).toBe(200);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });

  it('reports Poshmark refusing the form in its own words', async () => {
    site.inject({ action: 'create', fault: { type: 'reject', message: 'Please select a size.' } });
    const outcome = await adapter.execute(request('create', newRef()), ctx());
    expect(outcome).toMatchObject({
      type: 'rejected',
      code: 'validation_failed',
      message: 'Poshmark: Please select a size.',
    });
  });
});
