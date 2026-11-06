/**
 * Vinted's sale checks and auto-delist end to end (Vinted plan M6), on real Postgres, headless
 * Chromium, and the fake Vinted site: a check reads the seller's sold orders from Vinted's web
 * API the way the phone does (the sale check's steps, with the adapter's read in between), each
 * new paid order becomes a sale that delists its items everywhere else, a bundle (one order,
 * several items) delists each of them, an accepted offer the buyer has not paid for is no sale,
 * Vinted's shipping reaches the sale, and an order Vinted cancels or refunds after payment no
 * longer stands: canceled before it shipped, returned after, its unsent delists stopped, its
 * items back, and the seller asked whether to relist. No traffic goes to Vinted.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LocalTokenVault, SessionVault } from '@listora/connections';
import { createInventoryItem } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  ConnectionAwareAdapter,
  createVintedAdapter,
  type AdapterLookup,
} from '@listora/marketplaces';
import { PUSH_TASK } from '@listora/push';
import { recordSale } from '@listora/sales';

import { assistedAdapter } from '../fake-site/fake-site-adapter.ts';
import { linkAutomationSession } from '../link.ts';
import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import {
  prepareSaleCheck,
  recordSaleCheckFailure,
  recordSaleCheckOrders,
  startSaleCheckRun,
} from '../sale-checks/job.ts';
import {
  recordSaleOrder,
  SALE_ORDER_TASK,
  type SaleOrderJobPayload,
} from '../sale-checks/orders.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from './adapter.ts';
import {
  FakeVintedSite,
  type FakeVintedItem,
  type FakeVintedOrder,
} from './fake/fake-vinted-site.ts';

const HOUR = 3_600_000;
const SETTINGS = {
  defaultIntervalMs: 12 * HOUR,
  minIntervalMs: 2 * HOUR,
  maxIntervalMs: 24 * HOUR,
  alertAfterFailures: 2,
  overdueMs: 6 * HOUR,
};

/** An invented item the fake seller sold on Vinted. */
const soldItem = (id: string, title: string, priceCents: number): FakeVintedItem => ({
  id,
  title,
  description: `An invented description of ${title}.`,
  priceCents,
  state: 'sold',
  brand: null,
  size: null,
  condition: 'Very good',
  catalogId: null,
  colors: [],
  photos: [`vinted-${id}`],
});

describe('Vinted sale checks and auto-delist (real Postgres, headless Chromium)', () => {
  let database: MigratedDatabase;
  let site: FakeVintedSite;
  let runner: PlaywrightBrowserRunner;
  let adapters: AdapterLookup;
  let accountId: string;
  let connectionId: string;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  const profile = {
    ...automationProfile('vinted'),
    pacing: QUICK_PACING,
    cookieDomains: ['127.0.0.1'],
  };

  beforeAll(async () => {
    database = await createMigratedDatabase('vinted_sale_checks', { jobQueue: true, max: 8 });
    site = await FakeVintedSite.start(0);
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: 3_000,
    });
    const sessions = new FakeSiteSessions(
      { issueSession: () => site.issueSession('vinted-test-shop') },
      runner,
      { ...profile, origins: [site.url], apiOrigins: [site.url] },
    );
    const vinted = new ConnectionAwareAdapter({
      assisted: createVintedAdapter(),
      automation: createVintedAutomationAdapter({
        siteUrl: site.url,
        profile,
        sessions,
        photos: stubPhotos,
        logger: silentLogger,
      }),
    });
    const mercari = assistedAdapter('mercari');
    adapters = (marketplace) =>
      marketplace === 'vinted' ? vinted : marketplace === 'mercari' ? mercari : undefined;
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
    await database.close();
  });

  beforeEach(async () => {
    accountId = await insertAccount(database.db);
    ({ connectionId } = await linkAutomationSession(
      database.db,
      { vault, profile },
      { accountId, marketplace: 'vinted', cookies: [site.issueSession('vinted-test-shop')] },
    ));
    // Linked yesterday: what sold since is the sale check's, not the sales history.
    await database.db
      .updateTable('sale_check_schedule')
      .set({ history_until: new Date(Date.now() - 24 * HOUR) })
      .where('connection_id', '=', connectionId)
      .execute();
  });

  afterEach(async () => {
    site.items = [];
    site.orders = [];
    await sql`delete from graphile_worker._private_jobs`.execute(database.db);
  });

  /**
   * One sale check, as the phone runs it (phone/work.ts): prepared and started on the server,
   * the orders read through the seller's session, recorded on the server. Then the worker
   * records the sale of each order handed over.
   */
  async function check(): Promise<void> {
    const deps = { db: database.db, adapters, settings: SETTINGS, logger: silentLogger };
    const prepared = await prepareSaleCheck(deps, { accountId, connectionId });
    if (prepared === null) throw new Error('no sale check to run');
    const started = await startSaleCheckRun(database.db, prepared, 'phone');
    try {
      const orders = await prepared.adapter.listOrdersSince(prepared.since, {
        signal: new AbortController().signal,
        connection: prepared.connection,
      });
      await recordSaleCheckOrders(deps, started, orders);
    } catch (error) {
      await recordSaleCheckFailure(deps, started, error);
      throw error;
    }
    for (const payload of await saleOrderJobs()) {
      await recordSaleOrder({ db: database.db, adapters, logger: silentLogger }, payload);
    }
  }

  const saleOrderJobs = async () => {
    const { rows } = await sql<{ payload: SaleOrderJobPayload }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${SALE_ORDER_TASK})
    `.execute(database.db);
    return rows.map((row) => row.payload).filter((payload) => payload.accountId === accountId);
  };

  const pushes = async () => {
    const { rows } = await sql<{
      payload: { accountId: string; category: string; title: string; body: string };
    }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${PUSH_TASK})
    `.execute(database.db);
    return rows.map((row) => row.payload).filter((push) => push.accountId === accountId);
  };

  const sales = () =>
    database.db
      .selectFrom('sale')
      .select(['id', 'external_order_id', 'status', 'detection_source'])
      .where('account_id', '=', accountId)
      .orderBy('external_order_id')
      .execute();

  const itemStatus = async (itemId: string) =>
    (
      await database.db
        .selectFrom('inventory_item')
        .select('status')
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow()
    ).status;

  /** An item Listora listed on Vinted (as `vintedId`) and on Mercari, both live. */
  async function listedItem(title: string, vintedId: string) {
    const item = await createInventoryItem(database.db, accountId, { title });
    await database.db
      .insertInto('marketplace_listing')
      .values([
        {
          account_id: accountId,
          item_id: item.id,
          marketplace: 'vinted',
          connection_id: connectionId,
          external_listing_id: vintedId,
          status: 'active',
        },
        {
          account_id: accountId,
          item_id: item.id,
          marketplace: 'mercari',
          external_listing_id: `m-${vintedId}`,
          status: 'active',
        },
      ])
      .execute();
    await database.db
      .updateTable('inventory_item')
      .set({ status: 'listed' })
      .where('id', '=', item.id)
      .execute();
    return item.id;
  }

  /** The delists auto-delist started on the item's other listings, by marketplace. */
  const delists = (itemId: string) =>
    database.db
      .selectFrom('marketplace_operation as op')
      .innerJoin('marketplace_listing as listing', 'listing.id', 'op.listing_id')
      .select(['listing.marketplace', 'op.kind', 'op.status'])
      .where('op.account_id', '=', accountId)
      .where('listing.item_id', '=', itemId)
      .where('op.origin', '=', 'auto_delist')
      .execute();

  const order = (id: string, extra: Partial<FakeVintedOrder>): FakeVintedOrder => ({
    id,
    paidAt: new Date(Date.now() - HOUR),
    state: 'in_progress',
    itemIds: [],
    priceCents: 0,
    title: `Invented order ${id}`,
    ...extra,
  });

  it('records a bundle as one sale that delists each of its items elsewhere, then ships it', async () => {
    const jacket = await listedItem('Invented denim jacket', '7601');
    const tee = await listedItem('Invented tee', '7602');
    site.items = [
      soldItem('7601', 'Invented denim jacket', 3000),
      soldItem('7602', 'Invented tee', 1200),
    ];
    site.orders = [order('9601', { itemIds: ['7601', '7602'], priceCents: 4000 })];

    await check();
    const [sale] = await sales();
    expect(sale).toMatchObject({ external_order_id: '9601', status: 'detected' });
    const lines = await database.db
      .selectFrom('sale_item')
      .select(['item_id', 'sale_price_cents'])
      .where('sale_id', '=', sale?.id ?? '')
      .orderBy('sale_price_cents', 'desc')
      .execute();
    // Each item at its own price in the bundle.
    expect(lines).toEqual([
      { item_id: jacket, sale_price_cents: 3000 },
      { item_id: tee, sale_price_cents: 1200 },
    ]);
    // Each item delists on Mercari; the Vinted listings that sold are never touched.
    for (const itemId of [jacket, tee]) {
      expect(await delists(itemId)).toEqual([
        { marketplace: 'mercari', kind: 'end', status: 'queued' },
      ]);
      expect(await itemStatus(itemId)).toBe('sold_pending_delist');
    }
    const runs = await database.db
      .selectFrom('delist_run')
      .select('item_id')
      .where('sale_id', '=', sale?.id ?? '')
      .execute();
    expect(runs).toHaveLength(2);
    expect((await pushes()).map((push) => push.category)).toContain('item_sold');

    // Vinted says the parcel is on its way: the sale is shipped. A completed order stays so.
    site.orders = [order('9601', { itemIds: ['7601', '7602'], progress: 'shipped' })];
    await check();
    expect((await sales())[0]?.status).toBe('shipped');
    site.orders = [order('9601', { itemIds: ['7601', '7602'], state: 'completed' })];
    await check();
    expect((await sales()).map((one) => one.status)).toEqual(['shipped']);
  });

  it('delists the Vinted listing (Hide, from the phone) when the item sells elsewhere', async () => {
    const itemId = await listedItem('Invented corduroy shirt', '8101');
    await recordSale(
      database.db,
      {
        accountId,
        marketplace: 'mercari',
        externalOrderId: 'mercari-order-8101',
        soldAt: new Date(),
        currency: 'USD',
        shippingChargedCents: 0,
        detectionSource: 'manual',
        inboundEventId: null,
        shipBy: null,
        lines: [{ externalListingId: 'm-8101', externalSku: null, quantity: 1, priceCents: 2000 }],
      },
      { adapters },
    );
    // Vinted's delist is an end (Hide, never a delete), run on the seller's iPhone.
    expect(await delists(itemId)).toEqual([
      { marketplace: 'vinted', kind: 'end', status: 'queued' },
    ]);
  });

  it('records no sale of an accepted offer until the buyer pays for it', async () => {
    const itemId = await listedItem('Invented scarf', '7701');
    site.items = [soldItem('7701', 'Invented scarf', 900)];
    site.orders = [order('9701', { itemIds: ['7701'], progress: 'unpaid' })];

    await check();
    expect(await sales()).toEqual([]);
    expect(await delists(itemId)).toEqual([]);
    expect(await itemStatus(itemId)).toBe('listed');

    site.orders = [order('9701', { itemIds: ['7701'], progress: 'to_ship' })];
    await check();
    expect(await sales()).toMatchObject([{ external_order_id: '9701', status: 'detected' }]);
    expect(await delists(itemId)).toHaveLength(1);
  });

  it('cancels the sale of an order Vinted canceled after payment: its delists stop, the item is back, and the seller is asked', async () => {
    const itemId = await listedItem('Invented bomber jacket', '7801');
    site.items = [soldItem('7801', 'Invented bomber jacket', 5000)];
    site.orders = [order('9801', { itemIds: ['7801'] })];
    await check();
    expect(await delists(itemId)).toEqual([
      { marketplace: 'mercari', kind: 'end', status: 'queued' },
    ]);

    // Not sent in time: Vinted canceled it and refunded the buyer.
    site.orders = [order('9801', { itemIds: ['7801'], state: 'canceled' })];
    await check();
    expect(await sales()).toMatchObject([{ external_order_id: '9801', status: 'canceled' }]);
    // The Mercari delist had not reached Mercari: it stops, and any task of it is dismissed.
    expect(await delists(itemId)).toEqual([
      { marketplace: 'mercari', kind: 'end', status: 'canceled' },
    ]);
    const tasks = await database.db
      .selectFrom('user_task')
      .select(['kind', 'status'])
      .where('account_id', '=', accountId)
      .where('item_id', '=', itemId)
      .where('kind', '=', 'delist_manually')
      .execute();
    expect(tasks.every((task) => task.status === 'dismissed')).toBe(true);
    // Its listings are still live in Listora, so it is listed again; Listora never relists.
    expect(await itemStatus(itemId)).toBe('listed');
    const line = await database.db
      .selectFrom('sale_item')
      .select('relist_decision')
      .where('item_id', '=', itemId)
      .executeTakeFirstOrThrow();
    expect(line.relist_decision).toBe('pending');
    const told = (await pushes()).filter((push) => push.category === 'sale_canceled');
    expect(told).toEqual([
      expect.objectContaining({
        title: 'Order canceled on Vinted',
        body: 'Vinted canceled the order of Invented bomber jacket, so it no longer counts as sold. Open it to choose whether to relist it, and where.',
      }),
    ]);

    // Read canceled again: nothing changes, and the seller is not told twice.
    await check();
    expect((await sales()).map((one) => one.status)).toEqual(['canceled']);
    expect((await pushes()).filter((push) => push.category === 'sale_canceled')).toHaveLength(1);
  });

  it('records a refund after the order shipped as a return', async () => {
    const itemId = await listedItem('Invented trench coat', '7901');
    site.items = [soldItem('7901', 'Invented trench coat', 7000)];
    site.orders = [order('9901', { itemIds: ['7901'], progress: 'delivered' })];
    await check();
    expect(await sales()).toMatchObject([{ status: 'shipped' }]);

    // The buyer reported a problem within Vinted's 2 days, and Vinted refunded them.
    site.orders = [order('9901', { itemIds: ['7901'], statusText: 'Refunded to the buyer' })];
    await check();
    expect(await sales()).toMatchObject([{ status: 'returned' }]);
    expect(
      (await pushes())
        .filter((push) => push.category === 'sale_canceled')
        .map((push) => push.title),
    ).toEqual(['Order refunded on Vinted']);
    expect(itemId).toBeTypeOf('string');
  });

  it('never records an order canceled before Listora recorded its sale', async () => {
    site.items = [soldItem('8001', 'Invented beanie', 800)];
    // Canceled before any check saw it paid: no sale, no event.
    site.orders = [order('8051', { itemIds: ['8001'], state: 'canceled' })];
    await check();
    expect(await sales()).toEqual([]);

    // Handed over by a check, then canceled before the worker recorded it: it never becomes one.
    const deps = { db: database.db, adapters, settings: SETTINGS, logger: silentLogger };
    site.orders = [order('8052', { itemIds: ['8001'] })];
    const prepared = await prepareSaleCheck(deps, { accountId, connectionId });
    if (prepared === null) throw new Error('no sale check to run');
    const orders = await prepared.adapter.listOrdersSince(prepared.since, {
      signal: new AbortController().signal,
      connection: prepared.connection,
    });
    await recordSaleCheckOrders(
      deps,
      await startSaleCheckRun(database.db, prepared, 'phone'),
      orders,
    );
    const pending = await saleOrderJobs();
    expect(pending).toHaveLength(1);
    site.orders = [order('8052', { itemIds: ['8001'], state: 'canceled' })];
    await check();
    expect(await sales()).toEqual([]);
    const event = await database.db
      .selectFrom('inbound_event')
      .select(['result', 'error_message'])
      .where('account_id', '=', accountId)
      .where('provider_event_id', '=', 'order:8052')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ result: 'ignored', error_message: 'Vinted canceled this order.' });
  });
});
