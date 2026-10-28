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

  async function seller(marketplace: Marketplace = 'poshmark') {
    const accountId = await insertAccount(db, 'LR');
    const connection = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace,
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
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

  const run = (
    refresh: 'automation' | 'none' = 'automation',
    readOnly?: (connection: { marketplace: Marketplace }) => boolean,
  ) =>
    runListingRefreshes({
      db,
      adapters: (marketplace) => adapterFor(marketplace, refresh),
      limits: () => LIMITS,
      logger: { info: () => undefined },
      now: () => NOW,
      ...(readOnly === undefined ? {} : { readOnly }),
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

  it('refreshes a Depop listing on schedule under a normal Depop connection', async () => {
    const { accountId, connectionId } = await seller('depop');
    const { listingId } = await listing(accountId, connectionId, ago(100 * HOUR), 'depop');
    await run('automation', () => false);
    expect((await refreshesOf(accountId)).map((op) => op.listing_id)).toEqual([listingId]);
  });

  it('never queues anything for a read-only connection', async () => {
    const { accountId, connectionId } = await seller('depop');
    await listing(accountId, connectionId, ago(500 * HOUR), 'depop');
    await run('automation', (connection) => connection.marketplace === 'depop');
    // Until the read-only guard lands, every Depop session is read-only by default.
    await run();
    expect(
      await db
        .selectFrom('marketplace_operation')
        .select('id')
        .where('account_id', '=', accountId)
        .execute(),
    ).toEqual([]);
  });

  it('queues one refresh per listing per fresh period, however many runs', async () => {
    const { accountId, connectionId } = await seller();
    await listing(accountId, connectionId, ago(200 * HOUR));
    await Promise.all([run(), run(), run()]);
    expect(await refreshesOf(accountId)).toHaveLength(1);
  });
});
