/**
 * Drift resync with the real eBay adapter against the fake eBay: a change made on eBay itself
 * (a sale, an end, eBay dropping the listing) reaches the listing row only after two matching
 * reads, a listing with an unfinished operation is left to that operation, and a read that
 * shows the row's state only refreshes `last_verified_at`.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jsonb } from '@listora/db';
import {
  createEbayAdapter,
  desiredStateForContent,
  FakeEbay,
  loadEbayConfig,
  type AdapterLookup,
  type MarketplaceAdapter,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { remoteSnapshot } from './evidence.ts';
import { runListingResync, type ListingResyncPayload } from './resync.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';

describe('listing drift resync on eBay', () => {
  let harness: EngineHarness;
  let fake: FakeEbay;
  let ebay: MarketplaceAdapter;
  let adapters: AdapterLookup;
  let connectionId: string;
  let sequence = 0;
  const signal = (): AbortSignal => AbortSignal.timeout(10_000);

  beforeAll(async () => {
    harness = await createEngineHarness('resync');
    fake = await FakeEbay.start();
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({ account_id: harness.accountId, marketplace: 'ebay', mode: 'api' })
      .returning('id')
      .executeTakeFirstOrThrow();
    connectionId = connection.id;
    const config = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: fake.url,
      EBAY_USER_CONNECTION_ID: connectionId,
    });
    if (config === undefined) throw new Error('no eBay config');
    ebay = createEbayAdapter(config, { requestTimeoutMs: 5_000 });
    adapters = (marketplace) => (marketplace === 'ebay' ? ebay : undefined);
  });

  afterAll(async () => {
    await harness.close();
    await fake.close();
  });

  const deps = () => ({ db: harness.db, adapters, logger: harness.logger, confirmDelayMs: 0 });

  /** A listing that is active on the fake eBay, as a confirmed create leaves it. */
  async function activeListing(): Promise<ListingRow> {
    sequence += 1;
    const sku = `RS-${String(sequence).padStart(6, '0')}`;
    const content = sampleListingContent();
    const ref = { id: connectionId, mode: 'api', status: 'connected' } as const;
    const outcome = await ebay.execute(
      {
        operationId: `op-${sku}`,
        kind: 'create',
        idempotencyKey: `key-${sku}`,
        attempt: 1,
        desired: desiredStateForContent('create', content),
        listing: { listingId: sku, externalListingId: null, externalSku: sku, externalUrl: null },
        payload: ebay.buildPayload(content.item, content.variant, ref),
      },
      { signal: signal(), connection: ref },
    );
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(JSON.stringify(outcome));
    }
    const listing = await harness.createListing('ebay');
    const read = await ebay.readListing(
      {
        listingId: listing.id,
        externalListingId: outcome.externalListingId,
        externalSku: sku,
        externalUrl: null,
      },
      { signal: signal(), connection: ref },
    );
    if (!read.found) throw new Error('not found');
    return harness.db
      .updateTable('marketplace_listing')
      .set({
        connection_id: connectionId,
        status: 'active',
        external_listing_id: outcome.externalListingId,
        external_sku: sku,
        remote_snapshot: jsonb(remoteSnapshot(read)),
      })
      .where('id', '=', listing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The payload the confirming run gets (the job the first run added). */
  async function pendingPayload(listingId: string): Promise<ListingResyncPayload> {
    const { rows } = await sql<{ payload: ListingResyncPayload }>`
      select job.payload from graphile_worker._private_jobs as job
      where job.key = ${`resync:${listingId}`}
    `.execute(harness.db);
    const payload = rows[0]?.payload;
    if (payload === undefined) throw new Error('no confirming job');
    return payload;
  }

  it('records a sale made on eBay only after a second read agrees', async () => {
    const listing = await activeListing();
    const payload = { accountId: harness.accountId, listingId: listing.id };
    expect(await runListingResync(deps(), payload, signal())).toBe('unchanged');

    fake.sell(listing.external_listing_id ?? '');
    expect(await runListingResync(deps(), payload, signal())).toBe('confirming');
    expect(await harness.listing(listing.id)).toMatchObject({ status: 'active' });
    const pending = await pendingPayload(listing.id);
    expect(pending).toMatchObject({ round: 1 });
    expect(await runListingResync(deps(), pending, signal())).toBe('updated');
    const updated = await harness.listing(listing.id);
    expect(updated).toMatchObject({ status: 'sold' });
    expect(updated.remote_snapshot).toMatchObject({ status: 'sold' });
    expect(updated.ended_at).toBeInstanceOf(Date);
  });

  it('ends a listing eBay dropped, and leaves one with an unfinished operation alone', async () => {
    const dropped = await activeListing();
    fake.remove(dropped.external_listing_id ?? '');
    const payload = { accountId: harness.accountId, listingId: dropped.id };
    expect(await runListingResync(deps(), payload, signal())).toBe('confirming');
    expect(await runListingResync(deps(), await pendingPayload(dropped.id), signal())).toBe(
      'updated',
    );
    expect(await harness.listing(dropped.id)).toMatchObject({ status: 'ended' });

    const busy = await activeListing();
    await harness.enqueue(busy, 'price', { priceCents: 3100, currency: 'USD' });
    fake.sell(busy.external_listing_id ?? '');
    expect(
      await runListingResync(
        deps(),
        { accountId: harness.accountId, listingId: busy.id },
        signal(),
      ),
    ).toBe('busy');
    expect(await harness.listing(busy.id)).toMatchObject({ status: 'active' });
  });

  it('does not record a read the next read contradicts', async () => {
    const listing = await activeListing();
    const payload = {
      accountId: harness.accountId,
      listingId: listing.id,
      pending: JSON.stringify({ status: 'ended', snapshot: null, revision: null }),
      round: 1,
    };
    // The earlier read said "ended", this one shows it active as the row does.
    expect(await runListingResync(deps(), payload, signal())).toBe('unchanged');
    expect(await harness.listing(listing.id)).toMatchObject({ status: 'active' });
  });
});
