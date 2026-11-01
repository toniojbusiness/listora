import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, jsonb, type Db, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import type { MarketplaceAdapter, MarketplaceCapabilities } from '@listora/marketplaces';

import { listingRefresh, loadRefreshFacts } from './schedule.ts';
import { REFRESH_PACE, runListingRefreshes, type RunLimits } from './scheduler.ts';
import { loadRefreshSettings, saveItemRefresh, saveRefreshSettings } from './settings.ts';

const HOUR = 60 * 60_000;
const NOW = new Date('2026-10-25T15:00:00.000Z'); // 11:00 in New York
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LIMITS: RunLimits = { runsPerHour: 30, runsPerDay: 200 };

/** Only the capabilities matter to the schedule: an automation adapter that refreshes. */
function adapterFor(marketplace: Marketplace, refresh: 'automation' | 'none'): MarketplaceAdapter {
  const capabilities = {
    connect: 'session',
    verifyRead: 'automation',
    refresh,
  } as MarketplaceCapabilities;
  return { id: marketplace, capabilities: () => capabilities } as unknown as MarketplaceAdapter;
}

/** The content a create posted: the item and its photos (the variant is the listing's own). */
function postedContent(itemId: string) {
  return {
    item: {
      itemId,
      sku: 'AJ-000184',
      brand: 'Pendleton',
      productName: null,
      styleNumber: null,
      upc: null,
      department: 'women',
      category: 'clothing/outerwear/coats',
      sizeLabel: 'M',
      sizeSystem: 'letter',
      colors: ['grey'],
      pattern: null,
      materials: ['wool'],
      condition: 'pre_owned_good',
      conditionNotes: null,
      flaws: [],
      measurements: [],
      photos: [
        {
          photoId: '00000000-0000-4000-8000-000000000001',
          position: 0,
          role: 'front',
          url: 'https://photos.listora.test/coat.jpg',
        },
      ],
    },
    variant: {
      title: 'Wool coat',
      description: 'A warm coat.',
      price: { amountCents: 6000, currency: 'USD' },
      categoryRef: null,
      condition: null,
      aspects: [],
      hashtags: ['coat'],
    },
  };
}

describe('the refresh schedule', () => {
  let database: MigratedDatabase;
  let db: Db;
  let sequence = 0;

  beforeAll(async () => {
    database = await createMigratedDatabase('listing_refresh', { jobQueue: true });
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  async function seller(marketplace: Marketplace = 'poshmark', readOnly = false) {
    const accountId = await insertAccount(db, 'LR');
    const connection = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace,
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        read_only: readOnly,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { accountId, connectionId: connection.id };
  }

  async function listing(
    accountId: string,
    connectionId: string,
    listedAt: Date,
    marketplace: Marketplace = 'poshmark',
  ): Promise<{ itemId: string; listingId: string }> {
    sequence += 1;
    const item = await createInventoryItem(db, accountId, {
      title: `Item ${String(sequence)}`,
      status: 'listed',
    });
    const row = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace,
        status: 'active',
        connection_id: connectionId,
        external_listing_id: `ext-${String(sequence)}`,
        listed_at: listedAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { itemId: item.id, listingId: row.id };
  }

  async function operation(
    accountId: string,
    listingId: string,
    kind: 'price' | 'refresh',
    status: 'succeeded' | 'failed' | 'queued',
    createdAt: Date,
  ) {
    sequence += 1;
    await db
      .insertInto('marketplace_operation')
      .values({
        account_id: accountId,
        listing_id: listingId,
        kind,
        idempotency_key: `op-${String(sequence)}`,
        desired: jsonb(
          kind === 'price' ? { priceCents: 4000 } : { refreshedAfter: createdAt.toISOString() },
        ),
        status,
        ...(status === 'succeeded' ? { success_evidence: 'read_back' as const } : {}),
        ...(status === 'failed' ? { error_code: 'x', error_message: 'Failed.' } : {}),
        origin: kind === 'refresh' ? 'auto_refresh' : 'user',
        created_at: createdAt,
      })
      .execute();
  }

  async function refreshesOf(accountId: string) {
    return db
      .selectFrom('marketplace_operation')
      .select(['listing_id', 'kind', 'origin', 'desired', 'status'])
      .where('account_id', '=', accountId)
      .where('kind', '=', 'refresh')
      .where('status', '=', 'queued')
      .execute();
  }

  const run = (refresh: 'automation' | 'none' = 'automation') =>
    runListingRefreshes({
      db,
      adapters: (marketplace) => adapterFor(marketplace, refresh),
      limits: () => LIMITS,
      logger: { info: () => undefined },
      now: () => NOW,
    });

  it('queues a refresh for a listing 72 hours without selling, oldest due first, read-back only', async () => {
    const { accountId, connectionId } = await seller();
    const oldest = await listing(accountId, connectionId, ago(200 * HOUR));
    const due = await listing(accountId, connectionId, ago(100 * HOUR));
    const young = await listing(accountId, connectionId, ago(48 * HOUR));
    const changed = await listing(accountId, connectionId, ago(300 * HOUR));
    await operation(accountId, changed.listingId, 'price', 'succeeded', ago(10 * HOUR));
    const stillDue = await listing(accountId, connectionId, ago(90 * HOUR));

    expect((await run()).queued).toBeGreaterThanOrEqual(REFRESH_PACE.maxPerTick);
    const queued = await refreshesOf(accountId);
    // At most `maxPerTick` per connection per run, the longest waiting first.
    expect(queued.map((op) => op.listing_id)).toEqual([oldest.listingId, due.listingId]);
    expect(queued[0]).toMatchObject({
      origin: 'auto_refresh',
      desired: { refreshedAfter: NOW.toISOString() },
    });
    expect(queued.map((op) => op.listing_id)).not.toContain(young.listingId);
    expect(queued.map((op) => op.listing_id)).not.toContain(changed.listingId);
    expect(queued.map((op) => op.listing_id)).not.toContain(stillDue.listingId);

    // Two refreshes wait already: the connection has no room until they finish.
    await run();
    expect(await refreshesOf(accountId)).toHaveLength(REFRESH_PACE.maxUnfinished);
  });

  it('waits a whole interval after a refresh that failed, as after one that worked', async () => {
    const { accountId, connectionId } = await seller();
    const failed = await listing(accountId, connectionId, ago(200 * HOUR));
    await operation(accountId, failed.listingId, 'refresh', 'failed', ago(10 * HOUR));
    const worked = await listing(accountId, connectionId, ago(200 * HOUR));
    await operation(accountId, worked.listingId, 'refresh', 'succeeded', ago(80 * HOUR));

    await run();
    expect((await refreshesOf(accountId)).map((op) => op.listing_id)).toEqual([worked.listingId]);
  });

  it("follows the item's own cadence over the account's, and queues none when off", async () => {
    const { accountId, connectionId } = await seller();
    await saveRefreshSettings(db, accountId, {
      cadence: 'off',
      customHours: null,
      quietStart: null,
      quietEnd: null,
      timeZone: 'America/New_York',
      relistToRefresh: false,
    });
    await listing(accountId, connectionId, ago(500 * HOUR));
    const daily = await listing(accountId, connectionId, ago(30 * HOUR));
    await saveItemRefresh(db, accountId, daily.itemId, { cadence: 'daily', customHours: null });

    await run();
    expect((await refreshesOf(accountId)).map((op) => op.listing_id)).toEqual([daily.listingId]);
  });

  it("queues none in the seller's quiet window", async () => {
    const { accountId, connectionId } = await seller();
    // 10:00 to 12:00 in New York holds 11:00.
    await saveRefreshSettings(db, accountId, {
      cadence: 'every_72_hours',
      customHours: null,
      quietStart: 10 * 60,
      quietEnd: 12 * 60,
      timeZone: 'America/New_York',
      relistToRefresh: false,
    });
    const { listingId } = await listing(accountId, connectionId, ago(100 * HOUR));
    await run();
    expect(await refreshesOf(accountId)).toEqual([]);

    // The listing shows its next refresh at the window's end.
    const settings = await loadRefreshSettings(db, accountId);
    const [fact] = await loadRefreshFacts(db, accountId, { listingIds: [listingId] });
    if (fact === undefined) throw new Error('no fact');
    expect(
      listingRefresh(fact, settings, { start: 600, end: 720, timeZone: 'America/New_York' }, NOW),
    ).toEqual({ state: 'scheduled', nextAt: new Date('2026-10-25T16:00:00.000Z'), lastAt: null });
  });

  it('keeps refreshes within their share of the run limits', async () => {
    const { accountId, connectionId } = await seller();
    // An hour's share: 30 runs * 0.5 / 2 runs per refresh = 7, all used in the last hour.
    for (let index = 0; index < 7; index += 1) {
      const recent = await listing(accountId, connectionId, ago(500 * HOUR));
      await operation(accountId, recent.listingId, 'refresh', 'succeeded', ago(30 * 60_000));
    }
    await listing(accountId, connectionId, ago(500 * HOUR));
    await run();
    expect(await refreshesOf(accountId)).toEqual([]);
  });

  it('never refreshes where the adapter has no refresh, or a listing with work in flight', async () => {
    const { accountId, connectionId } = await seller();
    const busy = await listing(accountId, connectionId, ago(200 * HOUR));
    await operation(accountId, busy.listingId, 'price', 'queued', ago(HOUR));
    await run('none');
    expect(await refreshesOf(accountId)).toEqual([]);
    await run();
    expect(await refreshesOf(accountId)).toEqual([]);
  });

  /** A Depop listing Listora wrote: its text and price, and the create that posted it. */
  async function writtenListing(accountId: string, connectionId: string, listedAt: Date) {
    const written = await listing(accountId, connectionId, listedAt, 'depop');
    await db
      .updateTable('marketplace_listing')
      .set({
        title: 'Wool coat',
        description: 'A warm coat.',
        price_cents: 4500,
        hashtags: ['coat'],
      })
      .where('id', '=', written.listingId)
      .execute();
    sequence += 1;
    await db
      .insertInto('marketplace_operation')
      .values({
        account_id: accountId,
        listing_id: written.listingId,
        kind: 'create',
        idempotency_key: `op-${String(sequence)}`,
        desired: jsonb({ status: 'active' }),
        content: jsonb(postedContent(written.itemId)),
        status: 'succeeded',
        success_evidence: 'read_back',
        origin: 'user',
        created_at: listedAt,
      })
      .execute();
    return written;
  }

  async function relistOn(accountId: string, relistToRefresh: boolean) {
    await saveRefreshSettings(db, accountId, {
      cadence: 'every_72_hours',
      customHours: null,
      quietStart: null,
      quietEnd: null,
      timeZone: 'America/New_York',
      relistToRefresh,
    });
  }

  it('relists Depop listings only for a seller who turned relisting on, off by default', async () => {
    const { accountId, connectionId } = await seller('depop');
    const { listingId, itemId } = await writtenListing(accountId, connectionId, ago(100 * HOUR));
    await run();
    expect(await refreshesOf(accountId)).toEqual([]);
    await relistOn(accountId, false);
    await run();
    expect(await refreshesOf(accountId)).toEqual([]);

    await relistOn(accountId, true);
    await run();
    const queued = await db
      .selectFrom('marketplace_operation')
      .select(['listing_id', 'desired', 'content'])
      .where('account_id', '=', accountId)
      .where('kind', '=', 'refresh')
      .execute();
    // The fresh copy posts the photos the listing was posted with and the listing's own text
    // and price now (a price change since is kept).
    expect(queued).toEqual([
      {
        listing_id: listingId,
        desired: { refreshedAfter: NOW.toISOString() },
        content: {
          item: postedContent(itemId).item,
          variant: {
            title: 'Wool coat',
            description: 'A warm coat.',
            price: { amountCents: 4500, currency: 'USD' },
            categoryRef: null,
            condition: null,
            aspects: [],
            hashtags: ['coat'],
          },
        },
      },
    ]);
  });

  it('never relists a listing Listora did not write, or one with an offer waiting', async () => {
    const { accountId, connectionId } = await seller('depop');
    await relistOn(accountId, true);
    // Imported: no content to post again.
    await listing(accountId, connectionId, ago(100 * HOUR), 'depop');
    const offered = await writtenListing(accountId, connectionId, ago(100 * HOUR));
    await db
      .insertInto('marketplace_offer')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace: 'depop',
        external_offer_id: `offer-${String(sequence)}`,
        listing_id: offered.listingId,
        item_id: offered.itemId,
        amount_cents: 3000,
      })
      .execute();
    await run();
    expect(await refreshesOf(accountId)).toEqual([]);

    // Once the offer is answered, the listing is relisted on schedule.
    await db
      .updateTable('marketplace_offer')
      .set({ status: 'declined', closed_at: NOW })
      .where('listing_id', '=', offered.listingId)
      .execute();
    await run();
    expect((await refreshesOf(accountId)).map((op) => op.listing_id)).toEqual([offered.listingId]);
  });

  it('never queues anything for a read-only connection, Depop or any other', async () => {
    for (const marketplace of ['depop', 'poshmark'] as const) {
      const { accountId, connectionId } = await seller(marketplace, true);
      await listing(accountId, connectionId, ago(500 * HOUR), marketplace);
      await run();
      expect(
        await db
          .selectFrom('marketplace_operation')
          .select('id')
          .where('account_id', '=', accountId)
          .execute(),
        marketplace,
      ).toEqual([]);
    }
  });

  it('queues one refresh per listing per fresh period, however many runs', async () => {
    const { accountId, connectionId } = await seller();
    await listing(accountId, connectionId, ago(200 * HOUR));
    await Promise.all([run(), run(), run()]);
    expect(await refreshesOf(accountId)).toHaveLength(1);
  });
});
