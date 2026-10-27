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
    });
  });

  afterEach(() => {
    site.clearFaults();
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

    expect(
      await adapter.execute(request('relist', ref, {}, { status: 'active' }), ctx()),
    ).toMatchObject({
      type: 'confirmed',
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

  it("lists the seller's closet across pages, and finds sold items for sale checks", async () => {
    const before = new Date(Date.now() - 1000);
    const sold = await create({ variant: { title: 'Sold Jacket' } });
    site.sell(sold.externalListingId);
    const listings = await adapter.listListings(ctx());
    expect(listings.complete).toBe(true);
    const mine = site.listings().filter((listing) => listing.seller === 'listora_closet');
    expect(listings.listings.map((listing) => listing.externalListingId).sort()).toEqual(
      mine.map((listing) => listing.id).sort(),
    );
    expect(
      listings.listings.find((listing) => listing.externalListingId === sold.externalListingId),
    ).toMatchObject({
      status: 'sold',
      title: 'Sold Jacket',
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
      const outcome = await adapter.execute(request('create', ref), ctx());
      expect(outcome).toMatchObject({
        type: 'pendingUser',
        excerpt: {
          automation: 'page_changed',
          failure: { kind: 'error', code: 'element_missing', step: 'find the seller' },
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
