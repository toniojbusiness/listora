/**
 * A scheduled refresh on the engine (docs/features/listing-refresh.md): sent once, confirmed only
 * by a read-back that shows it, and failed visibly, with a Retry, after its few attempts when the
 * marketplace never shows it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  useMarketplaceFeatures,
  type AdapterContext,
  type MarketplaceAdapter,
  type OperationRequest,
  type Outcome,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { InvalidOperationError } from './errors.ts';
import { REFRESH_MAX_ATTEMPTS } from './policy.ts';
import { FAST_POLICY, createEngineHarness, type EngineHarness } from './test-support.ts';

const SETTLED = ['succeeded', 'failed', 'canceled', 'needs_user_action'] as const;

/**
 * A marketplace whose refresh is a repost (as Depop's is): a fresh copy from the refresh's
 * content, then the old listing ended, answering with the copy's id.
 */
function reposting(inner: MarketplaceAdapter): MarketplaceAdapter {
  const adapter: MarketplaceAdapter = {
    id: inner.id,
    capabilities: (connection) => ({ ...inner.capabilities(connection), refreshBy: 'repost' }),
    buildPayload: (item, variant, connection) => inner.buildPayload(item, variant, connection),
    validate: (payload, connection) => inner.validate(payload, connection),
    readListing: (ref, ctx) => inner.readListing(ref, ctx),
    healthCheck: (ctx) => inner.healthCheck(ctx),
    async execute(op: OperationRequest, ctx: AdapterContext): Promise<Outcome> {
      if (op.kind !== 'refresh') return inner.execute(op, ctx);
      if (op.payload === null) {
        return { type: 'rejected', code: 'missing_content', message: 'No content to post.' };
      }
      const copy = await inner.execute(
        {
          ...op,
          kind: 'create',
          idempotencyKey: `${op.idempotencyKey}:copy`,
          listing: { ...op.listing, externalListingId: null },
          desired: { status: 'active' },
        },
        ctx,
      );
      if (copy.type !== 'confirmed') return copy;
      await inner.execute(
        {
          ...op,
          kind: 'end',
          idempotencyKey: `${op.idempotencyKey}:end`,
          desired: { status: 'ended' },
          payload: null,
        },
        ctx,
      );
      return copy;
    },
  };
  return adapter;
}

describe('refresh operations (real Postgres, fake marketplace)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('refresh');
  });

  afterAll(async () => {
    await harness.close();
    expect(harness.fatalErrors).toEqual([]);
  });

  async function liveListing() {
    const listing = await harness.createListing('ebay');
    const create = await harness.enqueue(listing, 'create', {
      title: 'Wool coat',
      priceCents: 6000,
    });
    await harness.waitForStatus(create.id, SETTLED);
    return harness.listing(listing.id);
  }

  it('refreshes in place, and succeeds only once the read shows the refresh', async () => {
    const worker = await harness.startWorker({ policy: FAST_POLICY });
    try {
      const listing = await liveListing();
      const before = harness.fake.requests.length;
      const refresh = await harness.enqueue(
        listing,
        'refresh',
        { refreshedAfter: new Date(Date.now() - 1000).toISOString() },
        { origin: 'auto_refresh' },
      );
      const done = await harness.waitForStatus(refresh.id, SETTLED);
      expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back' });
      // One refresh sent; no create, end, or relist: never a delete and repost.
      const writes = harness.fake.requests
        .slice(before)
        .filter((request) => request.action !== 'read');
      expect(writes.map(({ action, listingId }) => ({ action, listingId }))).toEqual([
        { action: 'refresh', listingId: listing.external_listing_id },
      ]);
      // The same listing, still live.
      expect(await harness.listing(listing.id)).toMatchObject({
        status: 'active',
        external_listing_id: listing.external_listing_id,
      });
    } finally {
      await worker.stop();
    }
  });

  it('moves the listing to the fresh copy of a repost, once the read shows the copy', async () => {
    const ebay = harness.adapters('ebay');
    if (ebay === undefined) throw new Error('no eBay adapter');
    const adapter = reposting(ebay);
    const worker = await harness.startWorker({
      policy: FAST_POLICY,
      adapters: (marketplace) => (marketplace === 'ebay' ? adapter : harness.adapters(marketplace)),
    });
    try {
      const listing = await liveListing();
      const refresh = await harness.enqueue(
        listing,
        'refresh',
        { refreshedAfter: new Date(Date.now() - 1000).toISOString() },
        { origin: 'auto_refresh', content: sampleListingContent() },
      );
      const done = await harness.waitForStatus(refresh.id, SETTLED);
      expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back' });
      // The listing now names the copy, still live; the old listing was ended.
      const moved = await harness.listing(listing.id);
      expect(moved).toMatchObject({ status: 'active', pending_external_listing_id: null });
      expect(moved.external_listing_id).not.toBe(listing.external_listing_id);
      expect(moved.external_listing_id).toEqual(expect.any(String));
      const old = await adapter.readListing(
        {
          listingId: listing.id,
          externalListingId: listing.external_listing_id,
          externalSku: listing.external_sku,
          externalUrl: null,
        },
        { signal: AbortSignal.timeout(5_000), connection: null },
      );
      expect(old).toMatchObject({ found: true, status: 'ended' });
    } finally {
      await worker.stop();
    }
  });

  it('fails visibly after its few attempts when the marketplace never shows the refresh', async () => {
    const worker = await harness.startWorker({ policy: FAST_POLICY });
    try {
      const listing = await liveListing();
      // A refresh the marketplace can't show: asked to read as fresh from tomorrow.
      const refresh = await harness.enqueue(
        listing,
        'refresh',
        { refreshedAfter: new Date(Date.now() + 86_400_000).toISOString() },
        { origin: 'auto_refresh' },
      );
      const before = harness.fake.requests.length;
      const done = await harness.waitForStatus(refresh.id, SETTLED, 30_000);
      expect(done).toMatchObject({ status: 'failed', success_evidence: null });
      expect(done.error_message).toContain('refresh');
      // Its few attempts, each send read back: at most two shares, not seven.
      const sends = harness.fake.requests
        .slice(before)
        .filter((request) => request.action === 'refresh');
      expect(sends.length).toBeGreaterThanOrEqual(1);
      expect(sends.length).toBeLessThan(REFRESH_MAX_ATTEMPTS);
    } finally {
      await worker.stop();
    }
  });

  it('asks only for the refresh: no other field, and no refresh on another kind', async () => {
    const listing = await harness.createListing('ebay');
    await expect(
      harness.enqueue(listing, 'refresh', {
        refreshedAfter: new Date().toISOString(),
        priceCents: 100,
      }),
    ).rejects.toThrow(InvalidOperationError);
    await expect(
      harness.enqueue(listing, 'price', {
        priceCents: 100,
        refreshedAfter: new Date().toISOString(),
      }),
    ).rejects.toThrow(InvalidOperationError);
    await expect(harness.enqueue(listing, 'refresh', { refreshedAfter: 'soon' })).rejects.toThrow(
      InvalidOperationError,
    );
  });

  it('records a refresh that ran in Test mode in the owner’s log (test-mode.md)', async () => {
    const worker = await harness.startWorker({ policy: FAST_POLICY });
    useMarketplaceFeatures('verified');
    try {
      const listing = await liveListing();
      await harness.db
        .updateTable('account')
        .set({ test_mode: true })
        .where('id', '=', harness.accountId)
        .execute();
      const refresh = await harness.enqueue(
        listing,
        'refresh',
        { refreshedAfter: new Date(Date.now() - 1000).toISOString() },
        { origin: 'auto_refresh' },
      );
      await harness.waitForStatus(refresh.id, SETTLED);
      const runs = await harness.db
        .selectFrom('feature_test_run')
        .select(['marketplace', 'feature', 'outcome', 'subject_id'])
        .where('account_id', '=', harness.accountId)
        .execute();
      // eBay's refresh has not passed live: the run is a test. The create before it is not.
      expect(runs).toEqual([
        {
          marketplace: 'ebay',
          feature: 'listing_refresh',
          outcome: 'passed',
          subject_id: refresh.id,
        },
      ]);
    } finally {
      useMarketplaceFeatures('all');
      await harness.db
        .updateTable('account')
        .set({ test_mode: false })
        .where('id', '=', harness.accountId)
        .execute();
      await worker.stop();
    }
  });
});
