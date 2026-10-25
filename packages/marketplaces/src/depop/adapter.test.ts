/**
 * The Depop adapter beyond the shared conformance suite (adapter.conformance.test.ts), against
 * the fake Depop: DELETE's 200 for a missing product, relisting under a new SKU, mark-as-sold,
 * listings linked by slug, token refresh on 401, scopes and partner access, Depop's own
 * refusals, reads Depop can't see yet, the history excerpts, and the orders poll.
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
import type { DepopAdapter } from './adapter.ts';
import { loadDepopConfig, type DepopConfig } from './config.ts';
import { createDepopAdapter } from './create.ts';
import { FakeDepop } from './fake/fake-depop.ts';
import type { DepopListingPayload } from './payload.ts';
import { depopRemoteListing } from './product.ts';
import { MemoryDepopTokenStore } from './tokens.ts';

/** The connection the configured seller is bound to (`DEPOP_USER_CONNECTION_ID`). */
const CONNECTION_ID = 'connection-depop';

const ctx = (connection: AdapterContext['connection'] = { id: CONNECTION_ID, mode: 'api' }) => ({
  signal: new AbortController().signal,
  connection,
});

let sequence = 0;
/** A listing whose create Listora named with a fresh SKU, as the engine does. */
function namedRef(): ListingRef {
  sequence += 1;
  return {
    listingId: `listing-${String(sequence)}`,
    externalListingId: `AJ-${String(sequence).padStart(6, '0')}-D1`,
    externalSku: null,
    externalUrl: null,
  };
}

const tee = (overrides: Partial<ListingContent['variant']> = {}) =>
  sampleListingContent({ item: { category: 'clothing/tops/t_shirts' }, variant: overrides });

describe('DepopAdapter against the fake Depop', () => {
  let fake: FakeDepop;
  let config: DepopConfig;
  let adapter: DepopAdapter;

  beforeAll(async () => {
    fake = await FakeDepop.start();
    const loaded = loadDepopConfig({
      DEPOP_ENV: 'fake',
      DEPOP_FAKE_URL: fake.url,
      DEPOP_USER_CONNECTION_ID: CONNECTION_ID,
    });
    if (loaded === undefined) throw new Error('no config');
    config = loaded;
    adapter = createDepopAdapter(config, { requestTimeoutMs: 2_000, refusalGraceMs: 30 });
  });

  afterAll(async () => {
    expect(fake.specViolations).toEqual([]);
    await fake.close();
  });

  afterEach(() => {
    fake.clearFaults();
  });

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    options: { content?: ListingContent; priceCents?: number } = {},
  ): OperationRequest<DepopListingPayload> {
    const content = options.content ?? tee();
    return {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: `key-${listing.listingId}-${kind}`,
      attempt: 1,
      listing,
      desired: isContentKind(kind)
        ? desiredStateForContent(kind, content)
        : kind === 'price'
          ? { priceCents: options.priceCents ?? 3900, currency: 'USD' }
          : { status: kind === 'mark_sold' ? 'sold' : 'ended' },
      payload: isContentKind(kind) ? adapter.buildPayload(content.item, content.variant) : null,
    };
  }

  /**
   * Another adapter for the development seller, with a grant of its own: the configured
   * refresh token was used up by `adapter`'s first refresh, as Depop rotates them.
   */
  function adapterWith(changes: Partial<DepopConfig>): DepopAdapter {
    const store = new MemoryDepopTokenStore();
    store.connect(CONNECTION_ID, {
      accessToken: '',
      accessExpiresAt: 0,
      refreshToken: fake.grant(fake.developmentSellerId),
      grantExpiresAt: Date.now() + 60_000,
    });
    return createDepopAdapter(
      { ...config, ...changes },
      { tokenStore: store, requestTimeoutMs: 2_000 },
    );
  }

  async function create(ref = namedRef(), content = tee()) {
    expect(await adapter.execute(request('create', ref, { content }), ctx())).toMatchObject({
      type: 'confirmed',
      externalListingId: ref.externalListingId,
    });
    return ref;
  }

  it('reads a listing back without a title, with its copy apart from its hashtag line', async () => {
    const ref = await create(namedRef(), tee({ hashtags: ['vintage', 'levis'] }));
    const product = fake.product(ref.externalListingId ?? '');
    expect(product?.fields['description']).toBe(
      'Classic trucker jacket in medium wash. Light fading at the cuffs.\n\n#vintage #levis',
    );
    expect(await adapter.readListing(ref, ctx())).toEqual({
      found: true,
      externalListingId: ref.externalListingId,
      externalUrl: `https://www.depop.com/products/${product?.slug ?? ''}/`,
      status: 'active',
      title: null,
      description: 'Classic trucker jacket in medium wash. Light fading at the cuffs.',
      priceCents: 4500,
      currency: 'USD',
      revision: null,
    });
  });

  it("answers an end of a missing product with Depop's 200, and the read-back still finds nothing", async () => {
    const missing = namedRef();
    // Depop's DELETE "will return a successful response (200) even if the product doesn't
    // exist": the adapter passes that on as accepted, never as done...
    expect(await adapter.execute(request('end', missing), ctx())).toMatchObject({
      type: 'confirmed',
    });
    expect(fake.requests.at(-1)).toMatchObject({ action: 'delete', status: 200 });
    // ...and the read-back that decides finds no listing, which proves nothing either way.
    expect(await adapter.readListing(missing, ctx())).toEqual({
      found: false,
      authoritative: false,
    });
    // A real end reads back ended, and so does ending it again.
    const ref = await create();
    expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({ type: 'confirmed' });
    expect(fake.product(ref.externalListingId ?? '')?.status).toBe('STATUS_DELETED_ONSALE');
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ found: true, status: 'ended' });
  });

  it('relists as a new product under the next SKU, since Depop never reuses one', async () => {
    const ref = await create();
    await adapter.execute(request('end', ref), ctx());
    // The ended product's SKU can't be used again...
    const reused = await adapter.execute(request('relist', ref), ctx());
    expect(reused).toMatchObject({ type: 'rejected', code: 'sku_used' });
    // ...so the relist goes under the SKU the engine names next.
    const next = adapter.newListingId(tee().item, [ref.externalListingId ?? '']);
    const relisted = { ...ref, externalListingId: next };
    expect(await adapter.execute(request('relist', relisted), ctx())).toMatchObject({
      type: 'confirmed',
      externalListingId: next,
    });
    expect(await adapter.readListing(relisted, ctx())).toMatchObject({
      found: true,
      status: 'active',
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ found: true, status: 'ended' });
  });

  it('marks a listing sold after a sale elsewhere, and leaves an ended one as it is', async () => {
    const ref = await create();
    expect(await adapter.execute(request('mark_sold', ref), ctx())).toMatchObject({
      type: 'confirmed',
    });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'sold' });
    const ended = await create();
    await adapter.execute(request('end', ended), ctx());
    // "If the product is not in a selling state, this endpoint will still return successfully."
    expect(await adapter.execute(request('mark_sold', ended), ctx())).toMatchObject({
      type: 'confirmed',
    });
    expect(await adapter.readListing(ended, ctx())).toMatchObject({ status: 'ended' });
    // A product Depop doesn't have is refused, for the read-back to settle.
    expect(await adapter.execute(request('mark_sold', namedRef()), ctx())).toMatchObject({
      type: 'rejected',
      code: 'not_found',
    });
  });

  it("refuses changes to a listing that isn't on sale", async () => {
    const ref = await create();
    await adapter.execute(request('end', ref), ctx());
    for (const kind of ['price', 'revise'] as const) {
      expect(await adapter.execute(request(kind, ref), ctx()), kind).toMatchObject({
        type: 'rejected',
        code: 'not_active',
      });
    }
    const banned = await create();
    fake.ban(banned.externalListingId ?? '');
    expect(await adapter.execute(request('revise', banned), ctx())).toMatchObject({
      code: 'banned',
    });
    expect(await adapter.readListing(banned, ctx())).toMatchObject({ status: 'ended' });
  });

  it('works on a listing the user linked by its slug', async () => {
    const created = await create();
    const slug = fake.product(created.externalListingId ?? '')?.slug ?? '';
    const linked: ListingRef = { ...namedRef(), externalListingId: slug };
    expect(await adapter.readListing(linked, ctx())).toMatchObject({
      found: true,
      externalListingId: slug,
      status: 'active',
    });
    expect(
      await adapter.execute(request('price', linked, { priceCents: 2500 }), ctx()),
    ).toMatchObject({
      type: 'confirmed',
    });
    expect(await adapter.readListing(linked, ctx())).toMatchObject({ priceCents: 2500 });
    expect(fake.requests.at(-2)?.path).toBe(`/api/v1/products/by-slug/${slug}/`);
    // A new listing is never made under a slug: a relist needs the SKU Listora names.
    expect(await adapter.execute(request('relist', linked), ctx())).toMatchObject({
      type: 'rejected',
      code: 'not_named',
    });
  });

  it('refreshes an access token Depop refuses and sends once more; nothing was done the first time', async () => {
    const ref = namedRef();
    fake.expireAccessTokens();
    const before = fake.tokenRequests;
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'confirmed',
    });
    expect(fake.tokenRequests - before).toBe(1);
    const puts = fake.requests.filter(
      (sent) => sent.action === 'put' && sent.sku === ref.externalListingId,
    );
    expect(puts.map((sent) => sent.status)).toEqual([401, 200]);
    expect(fake.products(ref.externalListingId ?? '')).toHaveLength(1);
  });

  it('asks to reconnect for a missing scope, and says so when Depop pauses partner access', async () => {
    const store = new MemoryDepopTokenStore();
    store.connect('read-only', {
      accessToken: '',
      accessExpiresAt: 0,
      refreshToken: fake.grant(fake.developmentSellerId, ['products_read']),
      grantExpiresAt: Date.now() + 60_000,
    });
    const readOnly = createDepopAdapter(config, { tokenStore: store, requestTimeoutMs: 2_000 });
    const connection = { id: 'read-only', mode: 'api' } as const;
    expect(await readOnly.execute(request('create', namedRef()), ctx(connection))).toMatchObject({
      type: 'rejected',
      code: 'reauth_required',
    });
    expect(await readOnly.healthCheck(ctx(connection))).toMatchObject({
      status: 'reauth_required',
    });

    fake.inject({ action: 'put', fault: { type: 'partner_access_denied' } });
    expect(await adapter.execute(request('create', namedRef()), ctx())).toMatchObject({
      type: 'rejected',
      code: 'partner_access_denied',
    });
  });

  it("passes on Depop's own refusals with its reason, and sends nothing Listora can't name", async () => {
    // US sellers can't list with manual shipping on Depop.
    const manual = adapterWith({
      listingSettings: {
        address: { countryCode: 'US', state: null },
        shipping: { type: 'manual', nationalCostCents: 500 },
      },
    });
    expect(await manual.execute(request('create', namedRef()), ctx())).toMatchObject({
      type: 'rejected',
      code: 'depop_manual_shipping_not_allowed',
      message: expect.stringContaining('manual shipping is not allowed') as string,
    });
    const unnamed = { ...namedRef(), externalListingId: null };
    expect(await adapter.execute(request('create', unnamed), ctx())).toMatchObject({
      code: 'not_named',
    });
    const unknownSeller = adapterWith({ listingSettings: null });
    expect(await unknownSeller.execute(request('create', namedRef()), ctx())).toMatchObject({
      type: 'rejected',
      code: 'settings_missing',
    });
    // An item Depop documents no category for is the engine's to refuse, by validation.
    expect(
      adapter.validate(
        adapter.buildPayload(sampleListingContent().item, sampleListingContent().variant),
      ),
    ).toMatchObject([{ field: 'variant.categoryRef', code: 'required' }]);
  });

  it("reports a product Depop can't see yet as not found, never as gone", async () => {
    const ref = await create();
    fake.inject({ action: 'get', fault: { type: 'not_visible' } });
    expect(await adapter.readListing(ref, ctx())).toEqual({ found: false, authoritative: false });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ found: true });
  });

  it('refuses to read a product status Listora does not know', () => {
    expect(() =>
      depopRemoteListing('AJ-000001-D1', {
        product_id: 1,
        slug: 's-1',
        status: 'STATUS_SOMETHING_NEW',
        description: 'x',
        price_currency: 'USD',
        price_amount: '1.00',
        quantity: 1,
      }),
    ).toThrow('unknown listing status');
  });

  it('keeps no token or listing body in the history excerpts', async () => {
    const ref = namedRef();
    const outcome = await adapter.execute(request('create', ref), ctx());
    const text = JSON.stringify(outcome.excerpt);
    expect(outcome.excerpt).toEqual({
      request: { method: 'PUT', by: 'sku', id: ref.externalListingId },
      response: { status: 200 },
    });
    expect(text).not.toMatch(/pat_|prt_|Bearer|trucker/i);
    fake.inject({
      action: 'put',
      fault: { type: 'reject', code: 'invalid_brand', message: 'Bad brand' },
    });
    const refused = await adapter.execute(request('create', namedRef()), ctx());
    expect(refused.excerpt).toMatchObject({
      response: { status: 422, errors: ['invalid_brand'], errorId: expect.any(String) as string },
    });
  });

  it('reads the seller orders a page at a time, for the poll that backs up the webhooks', async () => {
    const first = await create();
    const second = await create();
    const older = fake.purchase(first.externalListingId ?? '');
    const newer = fake.purchase(second.externalListingId ?? '');
    const page = await adapter.listOrders({ limit: 1 }, ctx());
    if (page.type !== 'ok') throw new Error('orders unavailable');
    expect(page.page.orders.map((order) => order.purchaseId)).toEqual([newer.purchase_id]);
    expect(page.page.orders[0]).toMatchObject({
      status: 'SHIPPING_PENDING',
      lines: [{ sku: second.externalListingId, soldPriceCents: 4500 }],
      fees: [{ type: 'PAYMENT_FEE' }],
    });
    const next = await adapter.listOrders({ limit: 1, cursor: page.page.cursor ?? '' }, ctx());
    expect(next).toMatchObject({
      type: 'ok',
      page: { orders: [{ purchaseId: older.purchase_id }] },
    });
    // A sold product reads back sold.
    expect(await adapter.readListing(second, ctx())).toMatchObject({ status: 'sold' });
    expect(await adapter.listOrders({}, ctx({ id: 'elsewhere', mode: 'api' }))).toEqual({
      type: 'unavailable',
      reauthRequired: true,
    });
  });
});
