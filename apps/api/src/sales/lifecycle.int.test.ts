/**
 * "Mark sold" and the sale lifecycle end to end (docs/features/sales.md): a manual sale goes
 * through the same intake as a detected one, so its auto-delist ends the eBay listing on the
 * fake eBay through a real operation worker; fees are estimated and profit shown; a cancel never
 * relists by itself, and relists only where the seller chooses, through the operation engine.
 */
import { createLogger } from '@listora/shared';
import {
  createMarketplaceAdapters,
  FakeEbay,
  loadEbayConfig,
  type EbayConfig,
} from '@listora/marketplaces';
import { startOperationWorker, type OperationWorker, type RetryPolicy } from '@listora/operations';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, type SuccessBody, type TestApi } from '../test-support.ts';

const OWNER = 'sale.owner@example.com';
const STRANGER = 'sale.stranger@example.com';

const FAST_POLICY: RetryPolicy = {
  delaysMs: [20, 30, 40, 50, 60, 70],
  jitter: 0,
  random: () => 0.5,
};

const DETAILS = {
  title: "Levi's Trucker Denim Jacket",
  description: 'Classic trucker jacket in medium wash.',
  brand: "Levi's",
  department: 'men',
  category: 'clothing/outerwear/denim_jackets',
  sizeLabel: 'M',
  sizeSystem: 'letter',
  colors: ['blue'],
  condition: 'pre_owned_excellent',
  listPrice: { amountCents: 4500, currency: 'USD' },
  cost: { amountCents: 1200, currency: 'USD' },
} as const;

const VARIANT = {
  title: "Levi's Trucker Denim Jacket Men's M Blue",
  description: 'Classic trucker jacket in medium wash.',
  price: { amountCents: 4500, currency: 'USD' },
} as const;

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('mark sold and the sale lifecycle (real Postgres, fake eBay, operation worker)', () => {
  let fake: FakeEbay;
  let api: TestApi;
  let worker: OperationWorker | undefined;
  let token: string;
  let tenant: Tenant;
  let seed = 0;

  beforeAll(async () => {
    fake = await FakeEbay.start({ allowHttpPictures: true });
    api = await createTestApi('sale_lifecycle', {
      connections: {
        adapters: createMarketplaceAdapters({
          fakeMarketplaceUrl: undefined,
          ebay: ebayConfig({}),
          depop: undefined,
        }),
        oauth: {},
        sealer: undefined,
      },
    });
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    const connection = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'ebay',
        mode: 'api',
        external_user_id: 'listora_dev_seller',
        display_name: 'listora_dev_seller',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    worker = await startOperationWorker({
      connectionString: api.databaseUrl,
      db: api.db,
      adapters: createMarketplaceAdapters({
        fakeMarketplaceUrl: undefined,
        ebay: ebayConfig({ EBAY_USER_CONNECTION_ID: connection.id }),
        depop: undefined,
      }).lookup,
      logger: createLogger({ service: 'sale-lifecycle-test', level: 'silent' }),
      policy: FAST_POLICY,
      pollIntervalMs: 20,
      onFatalError: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await worker?.stop();
    await api.close();
    await fake.close();
  });

  function ebayConfig(extra: Record<string, string>): EbayConfig {
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: fake.url, ...extra });
    if (config === undefined) throw new Error('no eBay configuration');
    return config;
  }

  async function jpeg(): Promise<Uint8Array> {
    seed += 1;
    return new Uint8Array(
      await sharp({
        create: {
          width: 640,
          height: 480,
          channels: 3,
          background: { r: seed % 256, g: 90, b: 60 },
        },
      })
        .jpeg({ quality: 80 })
        .toBuffer(),
    );
  }

  async function item(details: object = DETAILS): Promise<SuccessBody<'createItem'>> {
    const created = await api.call('createItem', { token, body: { details } });
    expect(created.status).toBe(201);
    return created.body;
  }

  /** An item live on eBay (confirmed by the fake) and on Poshmark (assisted, as the seller listed it). */
  async function listedEverywhere() {
    const created = await item();
    for (const role of ['front', 'back'] as const) {
      const uploadFileId = await api.uploads.add(tenant, { bytes: await jpeg() });
      const added = await api.call('addItemPhoto', {
        token,
        params: { itemId: created.id },
        body: { uploadFileId, role, width: 640, height: 480 },
      });
      expect(added.status).toBe(201);
    }
    await api.photoJobs.runAll();
    const draft = await api.call('createListing', {
      token,
      params: { itemId: created.id },
      body: { marketplace: 'ebay', variant: VARIANT },
    });
    expect(draft.status).toBe(201);
    expect(
      (await api.call('publishListing', { token, params: { listingId: draft.body.id } })).status,
    ).toBe(202);
    const ebay = await settled(draft.body.id);
    expect(ebay.statusDisplay.label).toBe('Active (confirmed by eBay)');
    const poshmark = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: created.id,
        marketplace: 'poshmark',
        status: 'active',
        external_url: `https://poshmark.com/listing/${created.id}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { itemId: created.id, ebayListingId: draft.body.id, poshmarkListingId: poshmark.id };
  }

  async function settled(listingId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const listing = await api.call('getListing', { token, params: { listingId } });
      const status = listing.body.latestOperation?.status;
      if (status === 'succeeded' || status === 'failed' || status === 'needs_user_action') {
        return listing.body;
      }
      if (Date.now() > deadline) throw new Error(`still ${listing.body.statusDisplay.label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function runCompleted(saleId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sale = await api.call('getSale', { token, params: { saleId } });
      const results = sale.body.delistRuns.flatMap((run) => run.results);
      if (results.every((result) => result.state !== 'pending' && result.state !== 'verifying')) {
        return sale.body;
      }
      if (Date.now() > deadline) throw new Error('the delists did not settle');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const operationKinds = async (listingId: string) =>
    (
      await api.db
        .selectFrom('marketplace_operation')
        .select(['kind', 'status'])
        .where('listing_id', '=', listingId)
        .orderBy('created_at')
        .execute()
    ).map((op) => `${op.kind}:${op.status}`);

  it('marks sold on Poshmark: the eBay listing is delisted, fees are estimated, profit shown', async () => {
    const { itemId, ebayListingId, poshmarkListingId } = await listedEverywhere();
    const sold = await api.call('createSale', {
      token,
      body: {
        marketplace: 'poshmark',
        items: [{ itemId, salePrice: usd(4000) }],
        shippingCharged: usd(0),
        soldAt: '2026-10-25T09:00:00.000Z',
      },
    });
    expect(sold.status).toBe(201);
    // Poshmark's table: 20% of $40.00. Payout 3200, minus the $12.00 cost: profit 2000 (166.67%).
    expect(sold.body).toMatchObject({
      marketplace: 'poshmark',
      detectionSource: 'manual',
      status: 'detected',
      availableActions: ['confirm', 'mark_shipped', 'cancel'],
      items: [
        {
          itemId,
          sku: expect.stringMatching(/^[A-Z]+-\d{6}$/) as string,
          title: DETAILS.title,
          listingId: poshmarkListingId,
          salePrice: usd(4000),
          cost: usd(1200),
          fees: usd(800),
          netProceeds: usd(3200),
          profit: usd(2000),
          roiBasisPoints: 16667,
        },
      ],
      fees: [
        {
          type: 'marketplace',
          amount: usd(800),
          source: 'estimated',
          description: 'Commission',
          feeTableVersion: 'poshmark-us-2026-10-24',
        },
      ],
      feesEstimated: true,
      netProceeds: usd(3200),
      profit: usd(2000),
      cost: usd(1200),
      roiBasisPoints: 16667,
      isDoubleSale: false,
    });
    // The same intake as a detected sale: an inbound event, and a delist of every other listing.
    const event = await api.db
      .selectFrom('inbound_event')
      .select(['source', 'result'])
      .where('account_id', '=', tenant.accountId)
      .where('marketplace', '=', 'poshmark')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ source: 'manual', result: 'processed' });
    expect(sold.body.delistRuns).toHaveLength(1);
    expect(sold.body.delistRuns[0]?.results.map((result) => result.listingId)).toEqual([
      ebayListingId,
    ]);

    const done = await runCompleted(sold.body.id);
    expect(done.delistRuns[0]?.results[0]).toMatchObject({
      marketplace: 'ebay',
      state: 'delisted',
      statusDisplay: { label: 'Delisted (confirmed by eBay)' },
    });
    const ebay = await api.call('getListing', { token, params: { listingId: ebayListingId } });
    expect(fake.listing(ebay.body.externalListingId ?? '')).toMatchObject({ status: 'Ended' });

    const shown = await api.call('getItem', { token, params: { itemId } });
    expect(shown.body.saleSummary).toMatchObject({
      saleId: sold.body.id,
      soldOn: 'poshmark',
      feesEstimated: true,
      profit: usd(2000),
      roiBasisPoints: 16667,
    });
    // A sold item is not relisted from its screen.
    const actions = shown.body.listings.flatMap((listing) =>
      listing.availableActions.map((available) => available.action),
    );
    expect(actions).not.toContain('relist');
    expect(actions).not.toContain('publish');
  });

  it('confirms, ships with the label cost, and refuses steps the status does not allow', async () => {
    const created = await item();
    const sold = await api.call('createSale', {
      token,
      body: { marketplace: 'mercari', items: [{ itemId: created.id, salePrice: usd(3000) }] },
    });
    expect(sold.status).toBe(201);
    const saleId = sold.body.id;
    // No other listing: nothing to delist, and the item is simply sold.
    expect((await api.call('getItem', { token, params: { itemId: created.id } })).body.status).toBe(
      'sold',
    );

    const returnedEarly = await api.call('recordSaleReturn', { token, params: { saleId } });
    expect(returnedEarly.status).toBe(409);
    expect(returnedEarly.error.code).toBe('invalid_state_transition');

    const confirmed = await api.call('confirmSale', { token, params: { saleId } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: 'confirmed',
      availableActions: ['mark_shipped', 'cancel', 'record_return'],
    });
    expect(confirmed.body.confirmedAt).toEqual(expect.any(String));

    const shipped = await api.call('markSaleShipped', {
      token,
      params: { saleId },
      body: { shippingCost: usd(650) },
    });
    expect(shipped.status).toBe(200);
    // Mercari 10% of $30.00: payout 2700, minus the $6.50 label and the $12.00 cost.
    expect(shipped.body).toMatchObject({
      status: 'shipped',
      availableActions: ['record_return'],
      shippingCost: usd(650),
      netProceeds: usd(2700),
      profit: usd(2700 - 650 - 1200),
    });
    expect((await api.call('getItem', { token, params: { itemId: created.id } })).body.status).toBe(
      'shipped',
    );

    const canceled = await api.call('cancelSale', { token, params: { saleId } });
    expect(canceled.status).toBe(409);
    const negative = await api.call('markSaleShipped', {
      token,
      params: { saleId },
      body: { shippingCost: usd(-1) },
    });
    expect(negative.status).toBe(422);
  });

  it('cancels without relisting anything, then relists on eBay only when the seller chooses', async () => {
    const { itemId, ebayListingId, poshmarkListingId } = await listedEverywhere();
    const sold = await api.call('createSale', {
      token,
      body: { marketplace: 'poshmark', items: [{ itemId, salePrice: usd(4500) }] },
    });
    expect(sold.status).toBe(201);
    await runCompleted(sold.body.id);
    const before = await operationKinds(ebayListingId);

    const canceled = await api.call('cancelSale', { token, params: { saleId: sold.body.id } });
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
    expect(canceled.body.canceledAt).toEqual(expect.any(String));
    // Listora asks, and relists nothing by itself.
    expect(canceled.body.items[0]?.relist).toEqual({
      decision: 'pending',
      options: [
        {
          listingId: ebayListingId,
          marketplace: 'ebay',
          mode: 'api',
          statusDisplay: expect.objectContaining({
            label: 'Delisted (confirmed by eBay)',
          }) as object,
          canRelist: true,
        },
        {
          listingId: poshmarkListingId,
          marketplace: 'poshmark',
          mode: 'assisted',
          statusDisplay: expect.any(Object) as object,
          canRelist: false,
        },
      ],
    });
    expect(await operationKinds(ebayListingId)).toEqual(before);
    const shown = await api.call('getItem', { token, params: { itemId } });
    // Its Poshmark listing, where the order was canceled, was never delisted: still listed.
    expect(shown.body.status).toBe('listed');
    expect(shown.body.saleSummary).toBeUndefined();
    expect(shown.body.relistPrompt).toEqual({
      saleId: sold.body.id,
      saleStatus: 'canceled',
      soldOn: 'poshmark',
    });

    // Only a listing offered for relisting can be chosen.
    const refused = await api.call('decideSaleRelist', {
      token,
      params: { saleId: sold.body.id },
      body: { items: [{ itemId, listingIds: [poshmarkListingId] }] },
    });
    expect(refused.status).toBe(422);
    expect(await operationKinds(ebayListingId)).toEqual(before);

    const relisted = await api.call('decideSaleRelist', {
      token,
      params: { saleId: sold.body.id },
      body: { items: [{ itemId, listingIds: [ebayListingId] }] },
    });
    expect(relisted.status).toBe(200);
    expect(relisted.body.items[0]?.relist).toMatchObject({ decision: 'relisted' });
    expect(relisted.body.items[0]?.relist?.options.every((option) => !option.canRelist)).toBe(true);
    const live = await settled(ebayListingId);
    expect(live).toMatchObject({
      status: 'active',
      statusDisplay: { label: 'Active (confirmed by eBay)' },
      latestOperation: { kind: 'relist', status: 'succeeded' },
    });
    const after = await api.call('getItem', { token, params: { itemId } });
    expect(after.body.status).toBe('listed');
    expect(after.body.relistPrompt).toBeUndefined();

    // The answer is given once.
    const again = await api.call('decideSaleRelist', {
      token,
      params: { saleId: sold.body.id },
      body: { items: [{ itemId, listingIds: [] }] },
    });
    expect(again.status).toBe(409);
  });

  it('records a return, stops delists that never reached a marketplace, and can decline to relist', async () => {
    const created = await item();
    // An assisted Mercari listing: its delist waits for the seller.
    const mercari = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: created.id,
        marketplace: 'mercari',
        status: 'active',
        external_url: 'https://www.mercari.com/us/item/m1/',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const sold = await api.call('createSale', {
      token,
      body: { marketplace: 'depop', items: [{ itemId: created.id, salePrice: usd(2500) }] },
    });
    expect(sold.status).toBe(201);
    expect(
      (await api.call('confirmSale', { token, params: { saleId: sold.body.id } })).status,
    ).toBe(200);
    // The worker hands the delist to the seller first; a return while it runs would race it.
    await runCompleted(sold.body.id);

    const returned = await api.call('recordSaleReturn', {
      token,
      params: { saleId: sold.body.id },
    });
    expect(returned.status).toBe(200);
    expect(returned.body.status).toBe('returned');
    // Canceled at once, or, when the worker was running the delist's step at that moment, by
    // that step as it finds the sale no longer stands.
    let delist = returned.body.delistRuns[0]?.results[0];
    for (let tries = 0; delist?.state !== 'canceled' && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const sale = await api.call('getSale', { token, params: { saleId: sold.body.id } });
      delist = sale.body.delistRuns[0]?.results[0];
    }
    expect(delist).toMatchObject({ listingId: mercari.id, state: 'canceled' });
    const task = await api.db
      .selectFrom('user_task')
      .select('status')
      .where('listing_id', '=', mercari.id)
      .executeTakeFirst();
    expect(task?.status ?? 'dismissed').toBe('dismissed');
    // The Mercari listing was never delisted, so the item is still listed there.
    expect((await api.call('getItem', { token, params: { itemId: created.id } })).body.status).toBe(
      'listed',
    );

    const declined = await api.call('decideSaleRelist', {
      token,
      params: { saleId: sold.body.id },
      body: { items: [{ itemId: created.id, listingIds: [] }] },
    });
    expect(declined.status).toBe(200);
    expect(declined.body.items[0]?.relist?.decision).toBe('declined');
    expect(
      (await api.call('getItem', { token, params: { itemId: created.id } })).body.relistPrompt,
    ).toBeUndefined();
  });

  it('records a bundle as one order with one delist run per item and the money split by price', async () => {
    const first = await item();
    const second = await item({ ...DETAILS, title: 'Coach Tabby bag', cost: usd(3000) });
    const sold = await api.call('createSale', {
      token,
      body: {
        marketplace: 'mercari',
        externalOrderId: 'm-bundle-1',
        items: [
          { itemId: first.id, salePrice: usd(2000) },
          { itemId: second.id, salePrice: usd(6000) },
        ],
        shippingCharged: usd(800),
      },
    });
    expect(sold.status).toBe(201);
    // Mercari 10% of $80.00 ($8.00), split 1:3 like the shipping charged.
    expect(sold.body).toMatchObject({
      externalOrderId: 'm-bundle-1',
      salePrice: usd(8000),
      netProceeds: usd(8000 + 800 - 800),
      profit: usd(8000 - 4200),
      items: [
        { itemId: first.id, fees: usd(200), netProceeds: usd(2000), profit: usd(800) },
        { itemId: second.id, fees: usd(600), netProceeds: usd(6000), profit: usd(3000) },
      ],
    });
    expect(sold.body.delistRuns.map((run) => run.itemId).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    // The same order again is refused; a replay of the same request answers the same.
    const again = await api.call('createSale', {
      token,
      body: {
        marketplace: 'mercari',
        externalOrderId: 'm-bundle-1',
        items: [{ itemId: first.id, salePrice: usd(1) }],
      },
    });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe('already_exists');
  });

  it('refuses a line it cannot record, and another account’s sales and items', async () => {
    const created = await item();
    const other = await item();
    const twice = await api.call('createSale', {
      token,
      body: {
        marketplace: 'ebay',
        items: [
          { itemId: created.id, salePrice: usd(100) },
          { itemId: created.id, salePrice: usd(100) },
        ],
      },
    });
    expect(twice.status).toBe(422);
    const listing = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: other.id,
        marketplace: 'ebay',
        status: 'ended',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const wrongListing = await api.call('createSale', {
      token,
      body: {
        marketplace: 'ebay',
        items: [{ itemId: created.id, listingId: listing.id, salePrice: usd(100) }],
      },
    });
    expect(wrongListing.status).toBe(422);
    const future = await api.call('createSale', {
      token,
      body: {
        marketplace: 'ebay',
        soldAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        items: [{ itemId: created.id, salePrice: usd(100) }],
      },
    });
    expect(future.status).toBe(422);

    const strangerToken = await api.signIn(STRANGER);
    const theirs = await api.call('createSale', {
      token: strangerToken,
      body: { marketplace: 'ebay', items: [{ itemId: created.id, salePrice: usd(100) }] },
    });
    expect(theirs.status).toBe(404);
    const mine = await api.call('createSale', {
      token,
      body: { marketplace: 'ebay', items: [{ itemId: created.id, salePrice: usd(100) }] },
    });
    expect(mine.status).toBe(201);
    expect(
      (await api.call('cancelSale', { token: strangerToken, params: { saleId: mine.body.id } }))
        .status,
    ).toBe(404);
  });
});
