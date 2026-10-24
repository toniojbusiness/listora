/**
 * Behaviour of the fake marketplace adapter beyond the shared conformance suite
 * (fake-adapter.conformance.test.ts): request excerpts, duplicate creates, held requests,
 * relisting under a new id, and what the fake marketplace itself enforces.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  DesiredListingState,
  ListingRef,
  OperationRequest,
} from '../adapter.ts';
import { desiredStateForContent } from '../content.ts';
import { sampleListingContent } from '../testing.ts';
import { FakeMarketplaceAdapter, type FakeListingPayload } from './fake-adapter.ts';
import { FakeMarketplace } from './fake-marketplace.ts';

const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection: null });
let sequence = 0;

function newRef(): ListingRef {
  sequence += 1;
  return {
    listingId: `listing-${String(sequence)}`,
    externalListingId: null,
    externalSku: null,
    externalUrl: null,
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
      // Long enough that a loaded machine never times out a normal answer.
      requestTimeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  afterEach(() => {
    fake.clearFaults();
  });

  function create(
    ref: ListingRef,
    idempotencyKey = `key-${ref.listingId}`,
  ): OperationRequest<FakeListingPayload> {
    const content = sampleListingContent();
    return {
      operationId: `op-${ref.listingId}`,
      kind: 'create',
      idempotencyKey,
      attempt: 1,
      desired: desiredStateForContent('create', content),
      listing: ref,
      payload: adapter.buildPayload(content.item, content.variant),
    };
  }

  function change(
    ref: ListingRef,
    kind: 'end' | 'relist' | 'mark_sold' | 'price',
  ): OperationRequest<FakeListingPayload> {
    const desired = (
      {
        price: { priceCents: 3900 },
        end: { status: 'ended' },
        relist: { status: 'active' },
        mark_sold: { status: 'sold' },
      } satisfies Record<typeof kind, DesiredListingState>
    )[kind];
    return { ...create(ref), kind, desired, payload: null };
  }

  async function created(): Promise<ListingRef> {
    const ref = newRef();
    const outcome = await adapter.execute(create(ref), ctx());
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(`create failed: ${JSON.stringify(outcome)}`);
    }
    return { ...ref, externalListingId: outcome.externalListingId };
  }

  it('sends the payload with the seller SKU and records a short excerpt', async () => {
    const ref = newRef();
    const outcome = await adapter.execute(create(ref), ctx());
    expect(outcome).toMatchObject({
      type: 'confirmed',
      revision: 1,
      excerpt: { request: { method: 'POST', path: '/listings' }, response: { status: 201 } },
    });
    const [listing] = fake.listings('ebay', ref.listingId);
    expect(listing).toMatchObject({
      sku: ref.listingId,
      title: sampleListingContent().variant.title,
      photoUrls: [
        'https://media.listora.test/p/front.jpg',
        'https://media.listora.test/p/back.jpg',
        'https://media.listora.test/p/tag.jpg',
      ],
    });
    expect(fake.requests.at(-1)).toMatchObject({ idempotencyKey: `key-${ref.listingId}` });
  });

  it('creates a second listing when a create is resent without the same key', async () => {
    const ref = newRef();
    await adapter.execute(create(ref), ctx());
    await adapter.execute(create(ref), ctx());
    expect(fake.listings('ebay', ref.listingId)).toHaveLength(1);
    // Without the same key, a resend is a second listing: what blind retries would cause.
    await adapter.execute(create(ref, 'another-key'), ctx());
    expect(fake.listings('ebay', ref.listingId)).toHaveLength(2);
  });

  it('rejects an end of a listing the marketplace removed as not found', async () => {
    const ref = await created();
    fake.remove('ebay', ref.externalListingId ?? '');
    expect(await adapter.execute(change(ref, 'end'), ctx())).toMatchObject({
      type: 'rejected',
      code: 'not_found',
      excerpt: { response: { status: 410 } },
    });
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

  it('answers "already ended" with a confirmed outcome that the engine reads back', async () => {
    const ref = await created();
    expect(await adapter.execute(change(ref, 'end'), ctx())).toMatchObject({ type: 'confirmed' });
    expect(await adapter.execute(change(ref, 'end'), ctx())).toMatchObject({
      type: 'confirmed',
      excerpt: { response: { status: 409 } },
    });
  });

  it('relists under a new id when the marketplace issues one', async () => {
    const ref = await created();
    await adapter.execute(change(ref, 'end'), ctx());
    fake.setRelistIssuesNewId(true);
    try {
      const relisted = await adapter.execute(change(ref, 'relist'), ctx());
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

  it('hides revisions when it plays a marketplace without a freshness marker', async () => {
    const plain = new FakeMarketplaceAdapter({
      marketplace: 'ebay',
      baseUrl: fake.url,
      readFreshness: 'none',
    });
    const ref = newRef();
    const outcome = await plain.execute(create(ref), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed' });
    expect(outcome).not.toHaveProperty('revision');
    expect(await plain.readListing(ref, ctx())).toMatchObject({ found: true, revision: null });
  });

  it('refuses a create or revise without a payload instead of sending a partial listing', async () => {
    const ref = newRef();
    expect(await adapter.execute({ ...create(ref), payload: null }, ctx())).toMatchObject({
      type: 'rejected',
      code: 'missing_content',
    });
    expect(fake.listings('ebay', ref.listingId)).toEqual([]);
  });

  it('is refused by the fake marketplace itself when a listing breaks its rules', async () => {
    const content = sampleListingContent();
    const payload = adapter.buildPayload(content.item, content.variant);
    const op = create(newRef());
    expect(
      await adapter.execute({ ...op, payload: { ...payload, photoUrls: [] } }, ctx()),
    ).toMatchObject({ type: 'rejected', code: 'validation_failed' });
    expect(
      await adapter.execute({ ...op, payload: { ...payload, title: 'x'.repeat(81) } }, ctx()),
    ).toMatchObject({ type: 'rejected', code: 'validation_failed' });
  });
});
