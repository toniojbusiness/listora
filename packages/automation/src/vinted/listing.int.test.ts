/**
 * The Vinted listing scripts (Vinted plan M5) on the fake Vinted site, in a real headless
 * Chromium: a create fills every field of the upload form (up to 20 photos, the category level by
 * level, brand, size, condition, colours, package size) and uploads only once, a price change
 * saves the edit form, an end hides and a relist unhides, and every change is confirmed only by
 * a read-back. A listing in Vinted's review reads as not live yet, never as listed, and an end
 * waits for the review. A form that can't take the listing refuses before anything is sent, and
 * a check stops the run. The steps stay assisted for a seller until they pass live. No traffic
 * goes to Vinted; the pages are Listora's model until the mapping (M2) records the real ones.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  desiredStateForContent,
  isContentKind,
  useMarketplaceFeatures,
  type AdapterContext,
  type ConnectionRef,
  type ListingRef,
  type OperationRequest,
  type WriteOperationKind,
} from '@listora/marketplaces';
import { sampleListingContent, type SampleContentOverrides } from '@listora/marketplaces/testing';

import { splitSkuLine } from '../adapter/sku-line.ts';
import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from './adapter.ts';
import { VINTED_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import { FakeVintedSite, type FakeVintedItem } from './fake/fake-vinted-site.ts';
import type { VintedListingPayload } from './payload.ts';
import { REVIEW_WAIT_MS } from './scripts.ts';

const connection: ConnectionRef = {
  id: 'connection-vinted',
  mode: 'automation',
  status: 'connected',
};
const ctx = (on: ConnectionRef = connection): AdapterContext => ({
  signal: new AbortController().signal,
  connection: on,
});

/** A women's mini dress: the fake's form recommends a small package for it. */
const DRESS: SampleContentOverrides = {
  item: {
    brand: 'Zara',
    department: 'women',
    category: 'clothing/dresses',
    sizeLabel: 'M',
    colors: ['black', 'white', 'red'],
    condition: 'new_with_tags',
  },
  variant: {
    title: 'Zara Black Mini Dress M',
    description: 'A black mini dress, new with tags.',
    categoryRef: 'Women > Clothing > Dresses > Mini-dresses',
    aspects: [],
  },
};

describe('Vinted listing scripts on the fake Vinted site', () => {
  let site: FakeVintedSite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createVintedAutomationAdapter>;
  let sequence = 0;

  beforeAll(async () => {
    site = await FakeVintedSite.start(0);
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: VINTED_STEP_TIMEOUT_MS,
    });
    const profile = { ...automationProfile('vinted'), pacing: QUICK_PACING };
    sessions = new FakeSiteSessions(
      { issueSession: () => site.issueSession('vinted-test') },
      runner,
      { ...profile, origins: [site.url], apiOrigins: [site.url], cookieDomains: ['127.0.0.1'] },
    );
    adapter = createVintedAutomationAdapter({
      siteUrl: site.url,
      profile,
      sessions,
      photos: stubPhotos,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    site.clearFaults();
    site.reviewUploads = false;
    sessions.challenges.length = 0;
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  function newRef(): ListingRef {
    sequence += 1;
    return {
      listingId: `listing-vinted-${String(sequence)}`,
      externalListingId: null,
      externalSku: `AJ-${String(900_000 + sequence)}`,
      externalUrl: null,
    };
  }

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    overrides: SampleContentOverrides = {},
    desired?: OperationRequest['desired'],
  ): OperationRequest<VintedListingPayload> {
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

  const item = (id: string | null): FakeVintedItem => {
    const found = site.items.find((one) => one.id === id);
    if (found === undefined) throw new Error(`no fake item ${String(id)}`);
    return found;
  };

  /** Whether any request since `from` posted to Vinted. */
  const posted = (from: number, path?: RegExp) =>
    site.requests
      .slice(from)
      .some((one) => one.method === 'POST' && (path === undefined || path.test(one.path)));

  const photos = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      photoId: `photo-${String(index)}`,
      position: index,
      role: 'detail' as const,
      url: `https://media.listora.test/p/${String(index)}.jpg`,
    }));

  it('uploads with every field, then reads the listing back with its SKU line set apart', async () => {
    const ref = await create(DRESS);
    expect(item(ref.externalListingId)).toMatchObject({
      title: 'Zara Black Mini Dress M',
      category: ['Women', 'Clothing', 'Dresses', 'Mini-dresses'],
      brand: 'Zara',
      size: 'M / 8-10',
      condition: 'New with tags',
      // Vinted takes two colours at most.
      colors: ['Black', 'White'],
      // The package size Vinted recommends for the category, kept.
      packageSize: 'small',
      priceCents: 4500,
      state: 'active',
    });
    expect(item(ref.externalListingId).photos).toHaveLength(3);
    expect(splitSkuLine(item(ref.externalListingId).description)).toEqual({
      description: 'A black mini dress, new with tags.',
      sku: ref.externalSku,
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      found: true,
      externalListingId: ref.externalListingId,
      status: 'active',
      title: 'Zara Black Mini Dress M',
      description: 'A black mini dress, new with tags.',
      priceCents: 4500,
      currency: 'USD',
      revision: null,
    });
    // Found by its SKU line too, before Listora knew its id.
    expect(await adapter.readListing({ ...ref, externalListingId: null }, ctx())).toMatchObject({
      found: true,
      externalListingId: ref.externalListingId,
    });
  });

  it('uploads all 20 photos Vinted takes, in posting order', async () => {
    const ref = await create({ ...DRESS, item: { ...DRESS.item, photos: photos(20) } });
    expect(item(ref.externalListingId).photos).toHaveLength(20);
    expect(item(ref.externalListingId).photos[0]).toMatch(/^0-/);
  });

  it('maps the item to its Vinted category, condition, and brand without a category of its own', async () => {
    // The sample: a men's Levi's denim jacket, pre-owned.
    const ref = await create();
    expect(item(ref.externalListingId)).toMatchObject({
      category: ['Men', 'Clothing', 'Outerwear', 'Jackets', 'Denim jackets'],
      brand: "Levi's",
      size: 'M',
      condition: 'Very good',
      colors: ['Blue'],
      packageSize: 'medium',
    });
  });

  it("picks Vinted's No brand for a brand it doesn't list, and for an item without one", async () => {
    const unlisted = await create({ ...DRESS, item: { ...DRESS.item, brand: 'Atelier Inventé' } });
    expect(item(unlisted.externalListingId).brand).toBeNull();
    const none = await create({ ...DRESS, item: { ...DRESS.item, brand: null } });
    expect(item(none.externalListingId).brand).toBeNull();
  });

  it('picks the package size the listing names over the one Vinted recommends', async () => {
    const ref = await create({
      ...DRESS,
      variant: { ...DRESS.variant, aspects: [{ name: 'Package size', values: ['Large'] }] },
    });
    expect(item(ref.externalListingId).packageSize).toBe('large');
  });

  it('refuses before anything is sent when Vinted recommends no package size and the listing names none', async () => {
    const from = site.requests.length;
    const outcome = await adapter.execute(
      request('create', newRef(), {
        ...DRESS,
        item: { ...DRESS.item, category: 'clothing/bottoms/skirts', sizeLabel: 'S' },
        variant: { ...DRESS.variant, categoryRef: 'Women > Clothing > Skirts' },
      }),
      ctx(),
    );
    expect(outcome).toMatchObject({ type: 'rejected', code: 'package_size_required' });
    expect(posted(from)).toBe(false);
  });

  it("refuses before anything is sent when the category's sizes don't have the item's", async () => {
    const from = site.requests.length;
    const outcome = await adapter.execute(
      request('create', newRef(), { ...DRESS, item: { ...DRESS.item, sizeLabel: 'XXL' } }),
      ctx(),
    );
    expect(outcome).toMatchObject({ type: 'rejected', code: 'size_not_offered' });
    expect(outcome.type === 'rejected' && outcome.message).toContain(
      "Vinted doesn't offer size XXL for this category (its sizes include XS / 0-2, S / 4-6",
    );
    expect(posted(from)).toBe(false);
  });

  it('lists a category whose form asks no size, brand, or colour', async () => {
    const ref = await create({
      item: { brand: null, department: null, category: 'home/decor', sizeLabel: null, colors: [] },
      variant: {
        title: 'Blue Glass Vase',
        description: 'A blue glass vase, no chips.',
        categoryRef: 'Home > Decor > Vases',
        aspects: [],
      },
    });
    expect(item(ref.externalListingId)).toMatchObject({
      category: ['Home', 'Decor', 'Vases'],
      size: null,
      packageSize: 'large',
    });
  });

  it("refuses with Vinted's own words when its form refuses the listing", async () => {
    site.injectFault({
      action: 'create',
      fault: { type: 'reject', message: 'Add a longer title.' },
    });
    const ref = newRef();
    const outcome = await adapter.execute(request('create', ref, DRESS), ctx());
    expect(outcome).toMatchObject({ type: 'rejected', code: 'validation_failed' });
    expect(outcome.type === 'rejected' && outcome.message).toBe('Vinted: Add a longer title.');
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('finds the listing an earlier attempt posted, and never uploads it twice', async () => {
    const ref = newRef();
    const op = request('create', ref, DRESS);
    expect(await adapter.execute(op, ctx())).toMatchObject({ type: 'confirmed' });
    const from = site.requests.length;
    const again = await adapter.execute({ ...op, attempt: 2, mayHaveApplied: true }, ctx());
    expect(again).toMatchObject({
      type: 'confirmed',
      externalListingId: site.itemsWithSku(ref.externalSku ?? '')[0]?.id,
    });
    expect(posted(from)).toBe(false);
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(1);
  });

  describe("Vinted's review", () => {
    it('reads a listing in review as not live yet, never as listed, until Vinted finishes it', async () => {
      site.reviewUploads = true;
      const ref = await create(DRESS);
      expect(await adapter.readListing(ref, ctx())).toEqual({
        found: false,
        authoritative: false,
        inReview: true,
      });
      site.finishReview(ref.externalListingId);
      expect(await adapter.readListing(ref, ctx())).toMatchObject({
        found: true,
        status: 'active',
      });
    });

    it("waits to hide a listing Vinted is reviewing, sending nothing, then hides it once it's done", async () => {
      site.reviewUploads = true;
      const ref = await create(DRESS);
      const from = site.requests.length;
      const waiting = await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx());
      expect(waiting).toMatchObject({
        type: 'transient',
        code: 'in_review',
        retryAfterMs: REVIEW_WAIT_MS,
      });
      expect(waiting.type === 'transient' && waiting.message).toContain(
        "Vinted is reviewing this listing and won't let it be hidden",
      );
      expect(posted(from)).toBe(false);
      expect(item(ref.externalListingId).state).toBe('active');

      site.finishReview(ref.externalListingId);
      expect(
        await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx()),
      ).toMatchObject({
        type: 'confirmed',
      });
      expect(item(ref.externalListingId).state).toBe('hidden');
    });

    it('waits to change the price of a listing Vinted is reviewing', async () => {
      site.reviewUploads = true;
      const ref = await create(DRESS);
      const from = site.requests.length;
      expect(
        await adapter.execute(
          request('price', ref, {}, { priceCents: 3900, currency: 'USD' }),
          ctx(),
        ),
      ).toMatchObject({ type: 'transient', code: 'in_review' });
      expect(posted(from)).toBe(false);
    });
  });

  it('changes the price on the edit form, and the read shows it', async () => {
    const ref = await create(DRESS);
    expect(
      await adapter.execute(
        request('price', ref, {}, { priceCents: 3950, currency: 'USD' }),
        ctx(),
      ),
    ).toMatchObject({ type: 'confirmed' });
    expect(item(ref.externalListingId).priceCents).toBe(3950);
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      priceCents: 3950,
      status: 'active',
    });
  });

  it('hides a listing for its end and unhides it for its relist, the same listing throughout', async () => {
    const ref = await create(DRESS);
    expect(
      await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx()),
    ).toMatchObject({ type: 'confirmed' });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'ended' });
    const relisted = await adapter.execute(request('relist', ref, DRESS), ctx());
    expect(relisted).toMatchObject({ type: 'confirmed', externalListingId: ref.externalListingId });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'active' });
    // One listing, never deleted and posted again.
    expect(site.itemsWithSku(ref.externalSku ?? '')).toHaveLength(1);
  });

  it('leaves a sold listing alone: its end has nothing to do, and it is never relisted', async () => {
    const ref = await create(DRESS);
    item(ref.externalListingId).state = 'sold';
    const from = site.requests.length;
    expect(
      await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx()),
    ).toMatchObject({ type: 'confirmed' });
    expect(await adapter.execute(request('relist', ref, DRESS), ctx())).toMatchObject({
      type: 'rejected',
      code: 'listing_sold',
    });
    expect(posted(from)).toBe(false);
  });

  it("stops at Vinted's account verification before listing, and the seller does the step", async () => {
    site.injectFault({ action: 'upload_page', fault: { type: 'account_verification' } });
    const from = site.requests.length;
    const outcome = await adapter.execute(request('create', newRef(), DRESS), ctx());
    expect(outcome).toMatchObject({ type: 'pendingUser', task: { kind: 'list_manually' } });
    expect(sessions.challenges).toEqual(['login_challenge']);
    expect(posted(from)).toBe(false);
  });

  it('gives the step to the seller when the upload form is not the one Listora knows', async () => {
    site.injectFault({ action: 'upload_page', fault: { type: 'redesigned' } });
    const from = site.requests.length;
    const outcome = await adapter.execute(request('create', newRef(), DRESS), ctx());
    expect(outcome).toMatchObject({
      type: 'pendingUser',
      excerpt: { automation: 'page_changed' },
    });
    expect(posted(from)).toBe(false);
  });

  it('reads the change back when a Hide may have gone through before its page broke', async () => {
    const ref = await create(DRESS);
    site.injectFault({ action: 'end', fault: { type: 'server_error', afterApply: true } });
    expect(
      await adapter.execute(request('end', ref, {}, { status: 'ended' }), ctx()),
    ).toMatchObject({ type: 'transient', code: 'server_error' });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'ended' });
  });

  it("keeps a seller's listing steps assisted until they pass live, but in Test mode", async () => {
    useMarketplaceFeatures('verified');
    try {
      const from = site.requests.length;
      const outcome = await adapter.execute(request('create', newRef(), DRESS), ctx());
      expect(outcome).toMatchObject({
        type: 'pendingUser',
        task: { kind: 'list_manually' },
        excerpt: { automation: 'not_verified' },
      });
      expect(site.requests.length).toBe(from);
      expect(adapter.capabilities(connection)).toMatchObject({
        create: 'assisted',
        updatePrice: 'assisted',
        delist: 'assisted',
        relist: 'assisted',
        verifyRead: 'automation',
      });
      // The owner's Test mode automates them.
      const testMode = { ...connection, listingAutomation: true };
      expect(adapter.capabilities(testMode)).toMatchObject({
        create: 'automation',
        updatePrice: 'automation',
        delist: 'automation',
        relist: 'automation',
      });
      expect(
        await adapter.execute(request('create', newRef(), DRESS), ctx(testMode)),
      ).toMatchObject({ type: 'confirmed' });
    } finally {
      useMarketplaceFeatures('all');
    }
  });
});
