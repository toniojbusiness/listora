/**
 * eBay sale checks end to end on real Postgres, headless Chromium, and the fake eBay site: a
 * linked eBay session is checked on the same schedule as the other automated marketplaces, a
 * sale on eBay's Sold page is recorded once by its eBay order number and starts the item's
 * auto-delist, and a connection that switched to eBay's API is no longer checked this way (the
 * API's own order poll takes over).
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LocalTokenVault, SessionVault } from '@listora/connections';
import { createInventoryItem } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  ConnectionAwareAdapter,
  createEbayAssistedAdapter,
  type AdapterLookup,
} from '@listora/marketplaces';
import { sql } from 'kysely';

import { RunnerSessions } from '../adapter/runner-sessions.ts';
import { linkAutomationSession } from '../link.ts';
import { automationProfile, standInProfile, type AutomationProfile } from '../profiles.ts';
import { runSaleCheck } from '../sale-checks/job.ts';
import {
  recordSaleOrder,
  SALE_ORDER_TASK,
  type SaleOrderJobPayload,
} from '../sale-checks/orders.ts';
import { QUICK_PACING, silentLogger, stubPhotos, testRunner } from '../test-support.ts';
import { createEbayAutomationAdapter } from './adapter.ts';
import { FakeEbaySite } from './fake/fake-ebay-site.ts';

const HOUR = 3_600_000;
const SETTINGS = {
  defaultIntervalMs: 12 * HOUR,
  minIntervalMs: 2 * HOUR,
  maxIntervalMs: 24 * HOUR,
};

describe('eBay sale checks (real Postgres, headless Chromium)', () => {
  let database: MigratedDatabase;
  let site: FakeEbaySite;
  let profile: AutomationProfile;
  let adapters: AdapterLookup;
  let accountId: string;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  const { runner } = testRunner({ stepTimeoutMs: 4_000 });

  beforeAll(async () => {
    database = await createMigratedDatabase('ebay_sale_checks', { jobQueue: true, max: 8 });
    site = await FakeEbaySite.start();
    profile = { ...standInProfile(automationProfile('ebay'), site.url), pacing: QUICK_PACING };
    const sessions = new RunnerSessions({
      db: database.db,
      vault,
      runner,
      profile: (marketplace) => (marketplace === 'ebay' ? profile : undefined),
      logger: silentLogger,
    });
    const ebay = new ConnectionAwareAdapter({
      assisted: createEbayAssistedAdapter(),
      automation: createEbayAutomationAdapter({
        siteUrl: site.url,
        profile,
        sessions,
        photos: stubPhotos,
        logger: silentLogger,
      }),
    });
    adapters = (marketplace) => (marketplace === 'ebay' ? ebay : undefined);
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
    await database.close();
  });

  beforeEach(async () => {
    site.clearFaults();
    accountId = await insertAccount(database.db);
  });

  const link = () =>
    linkAutomationSession(
      database.db,
      { vault, profile },
      { accountId, marketplace: 'ebay', cookies: [site.issueSession(accountId)] },
    );

  const check = (connectionId: string) =>
    runSaleCheck(
      { db: database.db, adapters, settings: SETTINGS, logger: silentLogger },
      { accountId, connectionId },
      new AbortController().signal,
    );

  const queuedOrders = async () => {
    const { rows } = await sql<{ payload: SaleOrderJobPayload }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${SALE_ORDER_TASK})
        and payload->>'accountId' = ${accountId}
    `.execute(database.db);
    return rows.map((row) => row.payload);
  };

  it("records a sale from eBay's Sold page once, by its order number, and starts the auto-delist", async () => {
    const { connectionId } = await link();
    const itemId = site.seed({ seller: accountId, title: 'Sold jacket', priceCents: 3000 });
    const orderId = site.sell(itemId, new Date(Date.now() - HOUR));
    const item = await createInventoryItem(database.db, accountId, { title: 'Sold jacket' });
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'ebay',
        connection_id: connectionId,
        external_listing_id: itemId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await check(connectionId);
    await check(connectionId);
    const events = await database.db
      .selectFrom('inbound_event')
      .select(['source', 'marketplace', 'provider_event_id'])
      .where('account_id', '=', accountId)
      .execute();
    expect(events).toEqual([
      { source: 'poll', marketplace: 'ebay', provider_event_id: `order:${orderId}` },
    ]);
    const queued = await queuedOrders();
    expect(queued).toHaveLength(1);
    for (const payload of queued) {
      await recordSaleOrder({ db: database.db, adapters, logger: silentLogger }, payload);
    }

    const sales = await database.db
      .selectFrom('sale')
      .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
      .select(['sale.external_order_id', 'sale.detection_source', 'sale_item.listing_id'])
      .where('sale.account_id', '=', accountId)
      .execute();
    // The order number the Fulfillment API names the order by, so the API's order poll would
    // find this sale recorded already after a switch.
    expect(sales).toEqual([
      { external_order_id: orderId, detection_source: 'poll', listing_id: listing.id },
    ]);
    expect(orderId).toMatch(/^\d{2}-\d{5}-\d{5}$/);
    const runs = await database.db
      .selectFrom('delist_run')
      .select('item_id')
      .where('account_id', '=', accountId)
      .execute();
    expect(runs).toEqual([{ item_id: item.id }]);
    const schedule = await database.db
      .selectFrom('sale_check_schedule')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(schedule).toMatchObject({ last_outcome: 'succeeded', next_reason: 'scheduled' });
  });

  it('no longer checks a connection that switched to eBay’s API', async () => {
    const { connectionId } = await link();
    site.sell(site.seed({ seller: accountId, title: 'Sold tee', priceCents: 1500 }));
    // The seller connected eBay's API: the grant is stored on the same connection.
    await database.db
      .updateTable('marketplace_connection')
      .set({ mode: 'api', token_ciphertext: Buffer.from('sealed tokens') })
      .where('id', '=', connectionId)
      .execute();
    const before = site.requests.length;
    await check(connectionId);
    expect(site.requests.length).toBe(before);
    expect(
      await database.db
        .selectFrom('inbound_event')
        .select('id')
        .where('account_id', '=', accountId)
        .execute(),
    ).toEqual([]);
  });
});
