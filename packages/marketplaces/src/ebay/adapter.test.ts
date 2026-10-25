/**
 * The eBay adapter beyond the shared conformance suite (adapter.conformance.test.ts), against
 * the fake eBay: duplicate protection, photo upload, eBay's own error codes, the daily call
 * budget, token expiry, sold and stale reads, and preparing a listing with Taxonomy and
 * VerifyAddFixedPriceItem.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  ListingRef,
  OperationRequest,
  WriteOperationKind,
} from '../adapter.ts';
import { desiredStateForContent, isContentKind, type ListingContent } from '../content.ts';
import { sampleListingContent } from '../testing.ts';
import { EbayAdapter, ebayUuid, chooseEbayCategory, fitItemSpecifics } from './adapter.ts';
import { DailyCallBudget } from './budget.ts';
import { loadEbayConfig, type EbayConfig } from './config.ts';
import { createEbayAdapter } from './create.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import { ApplicationToken, EbayOAuthClient, RefreshTokenSeller } from './oauth.ts';
import type { EbayListingPayload } from './payload.ts';

/** The connection the configured seller is bound to (`EBAY_USER_CONNECTION_ID`). */
const CONNECTION_ID = 'connection-ebay';

const ctx = (
  connection: AdapterContext['connection'] = {
    id: CONNECTION_ID,
    mode: 'api',
    status: 'connected',
  },
) => ({
  signal: new AbortController().signal,
  connection,
});

let sequence = 0;
function newRef(): ListingRef {
  sequence += 1;
  return {
    listingId: `listing-${String(sequence)}`,
    externalListingId: null,
    externalSku: `AJ-${String(sequence).padStart(6, '0')}`,
    externalUrl: null,
  };
}

describe('EbayAdapter against the fake eBay', () => {
  let fake: FakeEbay;
  let config: EbayConfig;
  let adapter: EbayAdapter;

  beforeAll(async () => {
    fake = await FakeEbay.start();
    const loaded = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: fake.url,
      EBAY_USER_CONNECTION_ID: CONNECTION_ID,
    });
    if (loaded === undefined) throw new Error('no config');
    config = loaded;
    adapter = createEbayAdapter(config, { requestTimeoutMs: 1_000 });
  });

  afterAll(async () => {
    await fake.close();
  });

  afterEach(() => {
    fake.clearFaults();
  });

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    options: {
      content?: ListingContent;
      key?: string;
      priceCents?: number;
      using?: EbayAdapter;
    } = {},
  ): OperationRequest<EbayListingPayload> {
    const content = options.content ?? sampleListingContent();
    const using = options.using ?? adapter;
    return {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: options.key ?? `key-${listing.listingId}-${kind}`,
      attempt: 1,
      listing,
      desired: isContentKind(kind)
        ? desiredStateForContent(kind, content)
        : kind === 'price'
          ? { priceCents: options.priceCents ?? 3900, currency: 'USD' }
          : { status: 'ended' },
      payload: isContentKind(kind) ? using.buildPayload(content.item, content.variant) : null,
    };
  }

  async function create(ref = newRef(), content?: ListingContent) {
    const outcome = await adapter.execute(
      request('create', ref, content === undefined ? {} : { content }),
      ctx(),
    );
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(JSON.stringify(outcome));
    }
    return { ...ref, externalListingId: outcome.externalListingId };
  }

  it('lists with the photos copied into EPS in posting order, the SKU, and the UUID', async () => {
    const ref = await create();
    const listing = fake.listing(ref.externalListingId);
    expect(listing).toMatchObject({
      sku: ref.externalSku,
      trackedBySku: true,
      uuid: ebayUuid(`key-${ref.listingId}-create`),
      categoryId: '57988',
      conditionId: 2990,
      price: '45.0',
      postalCode: '95125',
      status: 'Active',
    });
    expect(listing?.pictureUrls).toHaveLength(3);
    expect(listing?.pictureUrls.every((url) => url.startsWith('https://i.ebayimg.test/'))).toBe(
      true,
    );
    const uploads = fake.requests.filter((entry) => entry.action === 'media');
    expect(uploads.length).toBeGreaterThanOrEqual(3);
  });

  it('applies a create whose answer was lost once, and learns its id from the repeat', async () => {
    const ref = newRef();
    fake.inject({ action: 'add', fault: { type: 'timeout_after_send', delayMs: 3_000 } });
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'unknown',
      code: 'timeout',
    });
    const [created] = fake.listings(ref.externalSku ?? '');
    const again = await adapter.execute({ ...request('create', ref), attempt: 2 }, ctx());
    expect(again).toMatchObject({ type: 'confirmed', externalListingId: created?.itemId });
    expect(fake.listings(ref.externalSku ?? '')).toHaveLength(1);
  });

  it('leaves a live listing with the same SKU for the read-back to decide', async () => {
    const ref = await create();
    const other = await adapter.execute(
      request('create', ref, { key: 'another-operation' }),
      ctx(),
    );
    expect(other).toMatchObject({ type: 'confirmed' });
    expect(other).not.toHaveProperty('externalListingId');
    expect(fake.listings(ref.externalSku ?? '')).toHaveLength(1);
  });

  it('lists nothing when a photo is refused or cannot be copied', async () => {
    const refused = newRef();
    fake.inject({ action: 'media', fault: { type: 'reject', message: 'No valid image' } });
    expect(await adapter.execute(request('create', refused), ctx())).toMatchObject({
      type: 'rejected',
      code: 'photo_rejected',
    });
    const failing = newRef();
    fake.inject({ action: 'media', fault: { type: 'server_error' } });
    expect(await adapter.execute(request('create', failing), ctx())).toMatchObject({
      type: 'transient',
    });
    expect(fake.listings(refused.externalSku ?? '')).toEqual([]);
    expect(fake.listings(failing.externalSku ?? '')).toEqual([]);
  });

  it("maps eBay's system errors to transient, before and after the change", async () => {
    const before = newRef();
    fake.inject({ action: 'add', fault: { type: 'system_error' } });
    expect(await adapter.execute(request('create', before), ctx())).toMatchObject({
      type: 'transient',
      code: 'server_error',
    });
    expect(fake.listings(before.externalSku ?? '')).toEqual([]);
    const after = newRef();
    fake.inject({ action: 'add', fault: { type: 'system_error', afterApply: true } });
    expect(await adapter.execute(request('create', after), ctx())).toMatchObject({
      type: 'transient',
    });
    // The next attempt's read-back finds the listing by SKU.
    expect(await adapter.readListing(after, ctx())).toMatchObject({
      found: true,
      status: 'active',
    });
  });

  it('changes the price and the details, and refuses changes to an ended listing', async () => {
    const ref = await create();
    expect(await adapter.execute(request('price', ref, { priceCents: 3999 }), ctx())).toMatchObject(
      { type: 'confirmed' },
    );
    expect(fake.listing(ref.externalListingId)?.price).toBe('39.99');
    const revised = sampleListingContent({
      variant: { title: 'New title', description: 'Line one\nLine & two' },
    });
    expect(
      await adapter.execute(request('revise', ref, { content: revised }), ctx()),
    ).toMatchObject({ type: 'confirmed' });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({
      title: 'New title',
      description: 'Line one\nLine & two',
      priceCents: 4500,
    });
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(await adapter.execute(request('price', ref), ctx())).toMatchObject({
      type: 'rejected',
      code: 'not_active',
    });
  });

  it('relists under a new id once, even when the answer was lost', async () => {
    const ref = await create();
    await adapter.execute(request('end', ref), ctx());
    fake.inject({ action: 'relist', fault: { type: 'timeout_after_send', delayMs: 3_000 } });
    expect(await adapter.execute(request('relist', ref), ctx())).toMatchObject({ type: 'unknown' });
    const relisted = fake.listing(ref.externalListingId)?.relistedItemId;
    expect(relisted).toEqual(expect.any(String));
    expect(await adapter.execute({ ...request('relist', ref), attempt: 2 }, ctx())).toEqual(
      expect.objectContaining({ type: 'confirmed', externalListingId: relisted }),
    );
    const live = { ...ref, externalListingId: relisted ?? null };
    expect(
      await adapter.execute(request('relist', live, { key: 'relist-again' }), ctx()),
    ).toMatchObject({
      type: 'rejected',
      code: 'cannot_relist',
    });
  });

  it('ends a listing eBay no longer has as "not found", which a read-back proves absent', async () => {
    const ref = await create();
    fake.remove(ref.externalListingId);
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
      type: 'rejected',
      code: 'not_found',
    });
    expect(await adapter.readListing(ref, ctx())).toEqual({ found: false, authoritative: true });
  });

  it('reads a listing that sold as sold, and a stale read as eBay serves it', async () => {
    const sold = await create();
    fake.sell(sold.externalListingId);
    expect(await adapter.readListing(sold, ctx())).toMatchObject({
      found: true,
      status: 'sold',
      revision: null,
    });

    const ref = await create();
    await adapter.execute(request('price', ref, { priceCents: 2500 }), ctx());
    fake.inject({ action: 'get_item', fault: { type: 'stale_read' } });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ priceCents: 4500 });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ priceCents: 2500 });
  });

  it('gets a fresh token when eBay says the access token expired', async () => {
    // Every token expires: the photo upload's 401 leads to a refresh, and the listing goes out.
    fake.expireAccessTokens();
    expect(await adapter.execute(request('create', newRef()), ctx())).toMatchObject({
      type: 'confirmed',
    });
    // Trading's own "expired IAF token" answer: the next attempt refreshes.
    const ref = newRef();
    fake.inject({ action: 'add', fault: { type: 'token_expired' } });
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'transient',
      code: 'token_expired',
    });
    expect(await adapter.execute({ ...request('create', ref), attempt: 2 }, ctx())).toMatchObject({
      type: 'confirmed',
    });
    expect(fake.listings(ref.externalSku ?? '')).toHaveLength(1);
    // The Taxonomy calls refresh the application token the same way.
    fake.expireAccessTokens();
    expect(await adapter.prepareListing(sampleListingContent(), ctx())).toMatchObject({
      type: 'prepared',
    });
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it('asks the seller to reconnect when the grant is revoked, everywhere', async () => {
    const { refreshToken } = fake.addSeller();
    const revoked = createEbayAdapter(
      { ...config, seller: { refreshToken, connectionId: CONNECTION_ID } },
      { requestTimeoutMs: 1_000 },
    );
    fake.revokeSeller(refreshToken);
    expect(
      await revoked.execute(request('create', newRef(), { using: revoked }), ctx()),
    ).toMatchObject({
      type: 'rejected',
      code: 'reauth_required',
    });
    expect(await revoked.healthCheck(ctx())).toMatchObject({ status: 'reauth_required' });
    await expect(revoked.readListing(newRef(), ctx())).rejects.toThrow('reauth_required');
  });

  it("acts for the configured seller's connection only: any other, or none, must connect eBay", async () => {
    const before = fake.requests.length;
    for (const connection of [
      { id: 'another-connection', mode: 'api', status: 'connected' } as const,
      null,
    ]) {
      expect(await adapter.execute(request('create', newRef()), ctx(connection))).toMatchObject({
        type: 'rejected',
        code: 'reauth_required',
        message: 'Connect eBay to list there.',
      });
      await expect(adapter.readListing(newRef(), ctx(connection))).rejects.toThrow(
        'reauth_required',
      );
      expect(await adapter.healthCheck(ctx(connection))).toMatchObject({
        status: 'reauth_required',
      });
      const prepared = await adapter.prepareListing(sampleListingContent(), ctx(connection));
      expect(prepared).toMatchObject({ type: 'unavailable', code: 'reauth_required' });
    }
    // Nothing reached the seller's account: only the Taxonomy calls, with the app's own token.
    const sent = fake.requests.slice(before).map((entry) => entry.action);
    expect(sent.filter((action) => action !== 'taxonomy' && action !== 'token')).toEqual([]);
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it('removes the condition description from a listing when the item no longer has one', async () => {
    const ref = await create();
    expect(fake.listing(ref.externalListingId)?.conditionDescription).toBe(
      'Light fading at the cuffs.',
    );
    const cleared = sampleListingContent({ item: { conditionNotes: null, flaws: [] } });
    expect(
      await adapter.execute(request('revise', ref, { content: cleared }), ctx()),
    ).toMatchObject({ type: 'confirmed' });
    expect(fake.listing(ref.externalListingId)?.conditionDescription).toBeNull();
  });

  it("never puts a token in an outcome's excerpt", async () => {
    const ref = newRef();
    fake.inject({ action: 'add', fault: { type: 'unauthorized' } });
    const outcomes = [
      await adapter.execute(request('create', ref), ctx()),
      await adapter.execute(request('create', newRef()), ctx()),
    ];
    for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toMatch(/v\^1\.1#/);
  });

  describe('daily call budget', () => {
    it("stops normal calls at the reserve, keeps ends going, and stops at eBay's limit", async () => {
      const limited = await FakeEbay.start({ tradingDailyLimit: 6 });
      try {
        const oauth = new EbayOAuthClient({
          tokenUrl: `${limited.url}/identity/v1/oauth2/token`,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        });
        const budgeted = new EbayAdapter({
          endpoints: { ...config.endpoints, ...endpointsAt(limited.url) },
          seller: new RefreshTokenSeller({
            oauth,
            refreshToken: config.seller?.refreshToken ?? '',
            connectionId: CONNECTION_ID,
          }),
          applicationToken: new ApplicationToken(oauth),
          budget: new DailyCallBudget({ dailyLimit: 6, reserveRatio: 0.5 }),
          tradingDailyLimit: 6,
          categorySuggestions: true,
          requestTimeoutMs: 1_000,
        });
        const listed = await budgeted.execute(
          request('create', newRef(), { using: budgeted }),
          ctx(),
        );
        expect(listed).toMatchObject({ type: 'confirmed' });
        const ref = {
          ...newRef(),
          externalListingId:
            listed.type === 'confirmed' ? (listed.externalListingId ?? null) : null,
        };
        await budgeted.execute(request('price', ref, { using: budgeted }), ctx());
        await budgeted.execute(request('price', ref, { using: budgeted }), ctx());
        // Three calls left, all in the reserve: a price change waits, an end goes ahead.
        const waiting = await budgeted.execute(request('price', ref, { using: budgeted }), ctx());
        expect(waiting).toMatchObject({ type: 'transient', code: 'call_budget' });
        expect(waiting.type === 'transient' && waiting.retryAfterMs).toBeGreaterThan(60_000);
        const sent = limited.tradingCalls;
        expect(
          await budgeted.execute(request('end', ref, { using: budgeted }), ctx()),
        ).toMatchObject({ type: 'confirmed' });
        expect(limited.tradingCalls).toBe(sent + 1);

        // eBay's own limit: another process used the rest.
        limited.inject({ action: 'get_item', fault: { type: 'call_limit' } });
        await expect(budgeted.readListing(ref, ctx())).rejects.toThrow('518');
        expect(
          await budgeted.execute(request('end', ref, { using: budgeted }), ctx()),
        ).toMatchObject({
          type: 'transient',
          code: 'call_budget',
        });
      } finally {
        await limited.close();
      }
    });
  });

  describe('prepareListing', () => {
    it('picks the Taxonomy suggestion inside the mapped branch and pins the item specifics', async () => {
      const content = sampleListingContent({
        item: {
          department: 'women',
          category: 'clothing/bottoms/pants',
          sizeLabel: '28',
          sizeSystem: 'numeric',
        },
        variant: { title: 'Madewell Skinny Jeans Womens 28 Blue Denim', aspects: [] },
      });
      const prepared = await adapter.prepareListing(content, ctx());
      expect(prepared).toMatchObject({ type: 'prepared', issues: [], verifiedByEbay: true });
      if (prepared.type !== 'prepared') return;
      // The map says Women's Pants; eBay's suggestion inside Women's Clothing is Jeans.
      expect(prepared.variant.categoryRef).toBe('11554');
      expect(prepared.variant.aspects).toContainEqual({ name: 'Size', values: ['28'] });
      expect(fake.listings(content.item.sku)).toEqual([]);
    });

    it("matches sizes to eBay's spelling and reports what eBay would refuse", async () => {
      const spelled = await adapter.prepareListing(
        sampleListingContent({
          item: { sizeLabel: '2XL' },
          variant: { aspects: [{ name: 'Size', values: ['2XL'] }] },
        }),
        ctx(),
      );
      expect(spelled.type === 'prepared' && spelled.variant.aspects).toContainEqual({
        name: 'Size',
        values: ['XXL'],
      });

      const odd = await adapter.prepareListing(
        sampleListingContent({
          item: { sizeLabel: 'Medium-ish', sizeSystem: null },
          variant: { aspects: [{ name: 'Size', values: ['Medium-ish'] }] },
        }),
        ctx(),
      );
      expect(odd).toMatchObject({
        type: 'prepared',
        verifiedByEbay: false,
        issues: [
          {
            field: 'item.sizeLabel',
            code: 'not_standard',
            message: 'eBay doesn\'t accept "Medium-ish" for Size.',
          },
        ],
      });
    });

    it('takes the category from suggestions alone where the map has none', async () => {
      const prepared = await adapter.prepareListing(
        sampleListingContent({
          item: {
            department: 'kids',
            category: 'clothing/dresses/dresses',
            sizeLabel: '8',
            sizeSystem: 'numeric',
          },
          variant: {
            title: 'Girls Floral Dress Size 8',
            aspects: [{ name: 'Department', values: ['Girls'] }],
          },
        }),
        ctx(),
      );
      expect(prepared.type === 'prepared' && prepared.variant.categoryRef).toBe('51581');
    });

    it("reports eBay's own refusal from the dry run", async () => {
      fake.inject({
        action: 'verify',
        fault: { type: 'reject', message: 'The item specific Type is missing.' },
      });
      const prepared = await adapter.prepareListing(sampleListingContent(), ctx());
      expect(prepared).toMatchObject({
        type: 'prepared',
        verifiedByEbay: true,
        issues: [{ code: 'ebay_37', message: 'eBay: The item specific Type is missing.' }],
      });
    });

    it('keeps the mapped category where suggestions are not trusted (the sandbox)', async () => {
      const oauth = new EbayOAuthClient({
        tokenUrl: config.endpoints.oauthToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
      const noSuggestions = new EbayAdapter({
        endpoints: config.endpoints,
        seller: new RefreshTokenSeller({
          oauth,
          refreshToken: config.seller?.refreshToken ?? '',
          connectionId: CONNECTION_ID,
        }),
        applicationToken: new ApplicationToken(oauth),
        budget: new DailyCallBudget(),
        tradingDailyLimit: 5_000,
        categorySuggestions: false,
      });
      const before = fake.requests.filter((entry) => entry.action === 'taxonomy').length;
      const prepared = await noSuggestions.prepareListing(
        sampleListingContent({
          item: {
            department: 'women',
            category: 'clothing/bottoms/pants',
            sizeLabel: '28',
            sizeSystem: 'numeric',
          },
          variant: { title: 'Madewell Skinny Jeans Womens 28', aspects: [] },
        }),
        ctx(),
      );
      expect(prepared.type === 'prepared' && prepared.variant.categoryRef).toBe('63863');
      // Only the aspects call: no suggestions asked.
      expect(fake.requests.filter((entry) => entry.action === 'taxonomy').length - before).toBe(1);
    });
  });
});

describe('chooseEbayCategory', () => {
  const suggestions = [
    { categoryId: '63862', ancestors: ["Women's Clothing", 'Women'] },
    { categoryId: '57988', ancestors: ["Men's Clothing", 'Men'] },
  ];

  it('prefers the best suggestion in the mapped branch, else the mapped category', () => {
    const mapped = {
      categoryId: '57989',
      name: 'Pants',
      branch: "Men's Clothing",
      conditionScheme: 'apparel',
      size: 'clothing',
    } as const;
    expect(chooseEbayCategory(suggestions, mapped, 'men')).toBe('57988');
    expect(chooseEbayCategory([], mapped, 'men')).toBe('57989');
    expect(chooseEbayCategory(suggestions.slice(0, 1), mapped, 'men')).toBe('57989');
  });

  it("uses the department's part of the tree without a mapping", () => {
    expect(chooseEbayCategory(suggestions, null, 'men')).toBe('57988');
    expect(chooseEbayCategory(suggestions, null, null)).toBe('63862');
    expect(chooseEbayCategory([], null, 'women')).toBeNull();
  });
});

describe('fitItemSpecifics', () => {
  const aspect = (name: string, values: string[] = ['M', 'L']) => ({
    name,
    required: true,
    mode: 'SELECTION_ONLY' as const,
    cardinality: 'SINGLE' as const,
    values,
  });

  it('reports a required aspect once: refused when a value was given, missing when none was', () => {
    const { specifics, issues } = fitItemSpecifics(
      [
        { name: 'size', values: ['Medium-ish'] },
        { name: 'Color', values: ['blue'] },
      ],
      [aspect('Size'), aspect('Color', ['Blue']), aspect('US Shoe Size'), aspect('Brand', [])],
    );
    expect(specifics).toEqual([{ name: 'Color', values: ['Blue'] }]);
    expect(issues).toEqual([
      {
        field: 'item.sizeLabel',
        code: 'not_standard',
        message: 'eBay doesn\'t accept "Medium-ish" for Size.',
      },
      {
        field: 'item.sizeLabel',
        code: 'required',
        message: 'eBay needs US Shoe Size for this category.',
      },
      {
        field: 'variant.aspects',
        code: 'required',
        message: 'eBay needs Brand for this category.',
      },
    ]);
  });
});

function endpointsAt(url: string) {
  return {
    trading: `${url}/ws/api.dll`,
    api: url,
    media: url,
    oauthToken: `${url}/identity/v1/oauth2/token`,
  };
}
