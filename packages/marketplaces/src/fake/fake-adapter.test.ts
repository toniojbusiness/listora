import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterContext, ListingRef, OperationRequest } from '../adapter.ts';
import { FakeMarketplaceAdapter } from './fake-adapter.ts';
import { FakeMarketplace } from './fake-marketplace.ts';

const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection: null });
let sequence = 0;

function newRef(): ListingRef {
  sequence += 1;
  return { listingId: `listing-${String(sequence)}`, externalListingId: null, externalSku: null };
}

function create(ref: ListingRef, idempotencyKey = `key-${ref.listingId}`): OperationRequest {
  return {
    operationId: `op-${ref.listingId}`,
    kind: 'create',
    idempotencyKey,
    attempt: 1,
    desired: { status: 'active', title: 'Denim jacket', priceCents: 4500 },
    listing: ref,
  };
}

describe('FakeMarketplaceAdapter against the fake marketplace', () => {
  let fake: FakeMarketplace;
  let adapter: FakeMarketplaceAdapter;

  beforeAll(async () => {
    fake = await FakeMarketplace.start();
    adapter = new FakeMarketplaceAdapter({
      marketplace: 'ebay',
      baseUrl: fake.url,
      requestTimeoutMs: 200,
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  afterEach(() => {
    fake.clearFaults();
  });

  async function created(): Promise<ListingRef> {
    const ref = newRef();
    const outcome = await adapter.execute(create(ref), ctx());
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(`create failed: ${JSON.stringify(outcome)}`);
    }
    return { ...ref, externalListingId: outcome.externalListingId };
  }

  it('creates, reads back by id and by SKU, and maps the remote listing', async () => {
    const ref = newRef();
    const outcome = await adapter.execute(create(ref), ctx());
    expect(outcome).toMatchObject({
      type: 'confirmed',
      revision: 1,
      excerpt: { request: { method: 'POST', path: '/listings' }, response: { status: 201 } },
    });
    const externalListingId = outcome.type === 'confirmed' ? outcome.externalListingId : undefined;
    expect(externalListingId).toMatch(/^EBAY-/);

    const bySku = await adapter.readListing(ref, ctx());
    expect(bySku).toEqual({
      found: true,
      externalListingId,
      externalUrl: `${fake.url}/ebay/listings/${externalListingId ?? ''}`,
      status: 'active',
      title: 'Denim jacket',
      description: '',
      priceCents: 4500,
      currency: 'USD',
      revision: 1,
    });
    const byId = await adapter.readListing(
      { ...ref, externalListingId: bySku.found ? bySku.externalListingId : null },
      ctx(),
    );
    expect(byId).toEqual(bySku);
  });

  it('applies a create sent twice with the same idempotency key once', async () => {
    const ref = newRef();
    const first = await adapter.execute(create(ref), ctx());
    const second = await adapter.execute(create(ref), ctx());
    expect(second).toMatchObject({ type: 'confirmed', excerpt: { response: { status: 200 } } });
    expect(first.type === 'confirmed' && first.externalListingId).toBe(
      second.type === 'confirmed' && second.externalListingId,
    );
    expect(fake.listings('ebay', ref.listingId)).toHaveLength(1);

    // Without the same key, a resend is a second listing: what blind retries would cause.
    await adapter.execute(create(ref, 'another-key'), ctx());
    expect(fake.listings('ebay', ref.listingId)).toHaveLength(2);
  });

  it('reports a listing that does not exist as not found', async () => {
    expect(await adapter.readListing(newRef(), ctx())).toEqual({ found: false });
    expect(
      await adapter.readListing({ ...newRef(), externalListingId: 'EBAY-999999' }, ctx()),
    ).toEqual({ found: false });
  });

  it('maps 429 to a transient outcome with Retry-After', async () => {
    fake.inject({ action: 'create', fault: { type: 'rate_limited', retryAfterSeconds: 3 } });
    expect(await adapter.execute(create(newRef()), ctx())).toMatchObject({
      type: 'transient',
      code: 'rate_limited',
      retryAfterMs: 3_000,
      message: 'eBay is limiting requests right now.',
    });
  });

  it('maps 5xx to a transient outcome, whether or not the change was applied', async () => {
    const ref = newRef();
    fake.inject({ action: 'create', fault: { type: 'server_error', afterApply: true } });
    expect(await adapter.execute(create(ref), ctx())).toMatchObject({
      type: 'transient',
      code: 'server_error',
    });
    expect(fake.listings('ebay', ref.listingId)).toHaveLength(1);
  });

  it('maps a validation error to a rejected outcome with the reason and a fix', async () => {
    fake.inject({ action: 'create', fault: { type: 'reject', message: 'Size is required' } });
    expect(await adapter.execute(create(newRef()), ctx())).toMatchObject({
      type: 'rejected',
      code: 'validation_failed',
      message: 'eBay refused the change: Size is required.',
      fixHint: 'Fix the listing details, then retry.',
    });
    const invalid = create(newRef());
    expect(
      await adapter.execute(
        { ...invalid, desired: { ...invalid.desired, title: 'x'.repeat(81) } },
        ctx(),
      ),
    ).toMatchObject({ type: 'rejected', code: 'validation_failed' });
  });

  it('maps a timeout after sending to an unknown outcome; the change was applied', async () => {
    const ref = newRef();
    fake.inject({ action: 'create', fault: { type: 'timeout_after_send', delayMs: 2_000 } });
    expect(await adapter.execute(create(ref), ctx())).toMatchObject({
      type: 'unknown',
      code: 'timeout',
      message: "eBay didn't answer in time.",
    });
    expect(fake.listings('ebay', ref.listingId)).toHaveLength(1);
  });

  it('maps a request held mid-operation to an unknown outcome', async () => {
    const ref = newRef();
    fake.inject({ action: 'create', fault: { type: 'hang', afterApply: false } });
    expect(await adapter.execute(create(ref), ctx())).toMatchObject({ type: 'unknown' });
    expect(fake.listings('ebay', ref.listingId)).toEqual([]);
    expect(fake.requests.at(-1)).toMatchObject({
      sku: ref.listingId,
      status: 'held',
      applied: false,
    });
  });

  it('maps an unreachable marketplace to a transient outcome', async () => {
    const closed = await FakeMarketplace.start();
    const url = closed.url;
    await closed.close();
    const offline = new FakeMarketplaceAdapter({ marketplace: 'ebay', baseUrl: url });
    expect(await offline.execute(create(newRef()), ctx())).toMatchObject({
      type: 'transient',
      code: 'network_error',
    });
    await expect(offline.readListing(newRef(), ctx())).rejects.toThrow(/could not be read/);
  });

  it('updates the price and details of a live listing', async () => {
    const ref = await created();
    const outcome = await adapter.execute(
      { ...create(ref), kind: 'price', desired: { priceCents: 3900 } },
      ctx(),
    );
    expect(outcome).toMatchObject({ type: 'confirmed' });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ priceCents: 3900 });
  });

  it('rejects edits to a listing that is not on the marketplace yet', async () => {
    expect(
      await adapter.execute(
        { ...create(newRef()), kind: 'price', desired: { priceCents: 100 } },
        ctx(),
      ),
    ).toMatchObject({ type: 'rejected', code: 'not_listed' });
  });

  it('ends, relists, and marks sold; "already ended" still needs a read-back', async () => {
    const ref = await created();
    const end = { ...create(ref), kind: 'end' as const, desired: { status: 'ended' as const } };
    expect(await adapter.execute(end, ctx())).toMatchObject({ type: 'confirmed' });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'ended' });
    expect(await adapter.execute(end, ctx())).toMatchObject({
      type: 'confirmed',
      excerpt: { response: { status: 409 } },
    });

    const relist = { ...end, kind: 'relist' as const, desired: { status: 'active' as const } };
    expect(await adapter.execute(relist, ctx())).toMatchObject({ type: 'confirmed' });
    const sold = { ...end, kind: 'mark_sold' as const, desired: { status: 'sold' as const } };
    expect(await adapter.execute(sold, ctx())).toMatchObject({ type: 'confirmed' });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'sold' });
  });

  it('serves stale reads when told to, like an eventually consistent API', async () => {
    const ref = await created();
    expect(
      await adapter.execute(
        { ...create(ref), kind: 'price', desired: { priceCents: 2500 } },
        ctx(),
      ),
    ).toMatchObject({ type: 'confirmed', revision: 2 });
    fake.inject({ action: 'read', fault: { type: 'stale_read' } });
    // The stale read carries the older revision, so the engine can tell it is stale.
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ priceCents: 4500, revision: 1 });
    expect(await adapter.readListing(ref, ctx())).toMatchObject({ priceCents: 2500, revision: 2 });
  });

  it('hides revisions when it plays a marketplace without a freshness marker', async () => {
    const plain = new FakeMarketplaceAdapter({
      marketplace: 'ebay',
      baseUrl: fake.url,
      readFreshness: 'none',
    });
    expect(plain.capabilities().readFreshness).toBe('none');
    const ref = newRef();
    const outcome = await plain.execute(create(ref), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed' });
    expect(outcome).not.toHaveProperty('revision');
    expect(await plain.readListing(ref, ctx())).toMatchObject({ found: true, revision: null });
  });

  it('relists under a new id when the marketplace issues one', async () => {
    const ref = await created();
    const end = { ...create(ref), kind: 'end' as const, desired: { status: 'ended' as const } };
    await adapter.execute(end, ctx());
    fake.setRelistIssuesNewId(true);
    try {
      const relisted = await adapter.execute(
        { ...end, kind: 'relist', desired: { status: 'active' } },
        ctx(),
      );
      expect(relisted).toMatchObject({ type: 'confirmed', revision: 1 });
      const newId = relisted.type === 'confirmed' ? relisted.externalListingId : undefined;
      expect(newId).toMatch(/^EBAY-/);
      expect(newId).not.toBe(ref.externalListingId);
      expect(await adapter.readListing(ref, ctx())).toMatchObject({ status: 'ended' });
      expect(
        await adapter.readListing({ ...ref, externalListingId: newId ?? null }, ctx()),
      ).toMatchObject({ status: 'active', externalListingId: newId, revision: 1 });
    } finally {
      fake.setRelistIssuesNewId(false);
    }
  });

  it('turns every write into a user task in assisted mode', async () => {
    const assisted = new FakeMarketplaceAdapter({
      marketplace: 'poshmark',
      baseUrl: fake.url,
      mode: 'assisted',
    });
    expect(assisted.capabilities().verifyRead).toBe('user_confirm');
    const ref = newRef();
    expect(await assisted.execute(create(ref), ctx())).toEqual({
      type: 'pendingUser',
      task: {
        kind: 'list_manually',
        deepLink: `${fake.url}/poshmark/listings?sku=${ref.listingId}`,
        payload: { action: 'create', status: 'active', title: 'Denim jacket', priceCents: 4500 },
      },
    });
    expect(
      await assisted.execute({ ...create(ref), kind: 'end', desired: { status: 'ended' } }, ctx()),
    ).toMatchObject({ type: 'pendingUser', task: { kind: 'delist_manually' } });
    expect(
      await assisted.execute({ ...create(ref), kind: 'price', desired: { priceCents: 1 } }, ctx()),
    ).toMatchObject({ type: 'rejected', code: 'not_supported' });
    expect(fake.requests.filter((request) => request.marketplace === 'poshmark')).toEqual([]);
  });
});
