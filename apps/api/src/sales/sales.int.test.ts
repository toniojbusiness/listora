/**
 * The sales feed and the item's "Sold" banner against a real Postgres: what `listSales`,
 * `getSale`, and `getItem` show of a sale, its delist run, and a double sale. Sales are
 * recorded through `recordSale`, as the worker records detected ones; nothing runs the
 * delists here, so their results are still pending.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderCancelGuide, createMarketplaceAdapters } from '@listora/marketplaces';
import { recordSale } from '@listora/sales';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'sales.owner@example.com';
const OTHER = 'sales.other@example.com';

describe('the sales feed (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;
  let accountId: string;
  // Assisted Poshmark, Mercari, and Depop; no eBay adapter (its delists would fail visibly).
  const adapters = createMarketplaceAdapters({
    fakeMarketplaceUrl: undefined,
    ebay: undefined,
    depop: undefined,
  }).lookup;
  let order = 0;

  beforeAll(async () => {
    api = await createTestApi('sales');
    token = await api.signIn(OWNER);
    otherToken = await api.signIn(OTHER);
    accountId = (await api.tenantOf(OWNER)).accountId;
  });

  afterAll(async () => {
    await api.close();
  });

  async function listedItem(
    title: string,
    marketplaces: readonly ('ebay' | 'poshmark' | 'mercari')[],
  ) {
    const created = await api.call('createItem', { token, body: { details: { title } } });
    expect(created.status).toBe(201);
    const listings: Record<string, string> = {};
    for (const marketplace of marketplaces) {
      const row = await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: accountId,
          item_id: created.body.id,
          marketplace,
          status: 'active',
          external_url: `https://example.com/${marketplace}/${created.body.id}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      listings[marketplace] = row.id;
    }
    return { itemId: created.body.id, listings };
  }

  const sell = (
    marketplace: 'ebay' | 'poshmark' | 'mercari',
    itemId: string,
    priceCents = 4500,
  ) => {
    order += 1;
    return recordSale(
      api.db,
      {
        accountId,
        marketplace,
        externalOrderId: `order-${String(order)}`,
        soldAt: new Date('2026-10-24T18:00:00Z'),
        currency: 'USD',
        shippingChargedCents: 599,
        detectionSource: 'webhook',
        inboundEventId: null,
        shipBy: null,
        lines: [{ itemId, listingId: null, quantity: 1, priceCents }],
      },
      { adapters },
    );
  };

  it("shows the sale, the item's sold banner, and the delist results", async () => {
    const { itemId, listings } = await listedItem('Patagonia fleece', [
      'ebay',
      'poshmark',
      'mercari',
    ]);
    const recorded = await sell('ebay', itemId);
    if (recorded.type !== 'recorded') throw new Error('not recorded');

    const item = await api.call('getItem', { token, params: { itemId } });
    expect(item.status).toBe(200);
    expect(item.body.status).toBe('sold_pending_delist');
    // eBay's table: 13.6% of $45.00 ($6.12) and the $0.40 per-order fee, estimated until eBay
    // reports them. No cost, so no profit.
    expect(item.body.saleSummary).toEqual({
      saleId: recorded.saleId,
      soldOn: 'ebay',
      saleStatus: 'detected',
      feesEstimated: true,
      soldAt: '2026-10-24T18:00:00.000Z',
      salePrice: { amountCents: 4500, currency: 'USD' },
      netProceeds: { amountCents: 4500 + 599 - 652, currency: 'USD' },
    });
    const run = item.body.delistRun;
    expect(run).toMatchObject({
      saleId: recorded.saleId,
      itemId,
      soldOn: 'ebay',
      status: 'in_progress',
      statusDisplay: { tone: 'in_progress', label: 'Delisting on Mercari and Poshmark...' },
      escalated: false,
    });
    expect(run?.results).toEqual([
      expect.objectContaining({
        listingId: listings['mercari'],
        marketplace: 'mercari',
        mode: 'assisted',
        state: 'pending',
        statusDisplay: { tone: 'in_progress', label: 'Delisting...' },
        attempt: 0,
        maxAttempts: 7,
      }),
      expect.objectContaining({ listingId: listings['poshmark'], marketplace: 'poshmark' }),
    ]);
    expect(item.body.doubleSale).toBeUndefined();

    const sale = await api.call('getSale', { token, params: { saleId: recorded.saleId } });
    expect(sale.status).toBe(200);
    expect(sale.body).toMatchObject({
      id: recorded.saleId,
      marketplace: 'ebay',
      externalOrderId: `order-${String(order)}`,
      items: [
        { itemId, listingId: listings['ebay'], salePrice: { amountCents: 4500, currency: 'USD' } },
      ],
      salePrice: { amountCents: 4500, currency: 'USD' },
      shippingCharged: { amountCents: 599, currency: 'USD' },
      detectionSource: 'webhook',
      status: 'detected',
      isDoubleSale: false,
      doubleSales: [],
    });
    expect(sale.body.delistRuns).toEqual([run]);

    // Another account sees none of it.
    expect(
      (await api.call('getSale', { token: otherToken, params: { saleId: recorded.saleId } }))
        .status,
    ).toBe(404);
    expect((await api.call('listSales', { token: otherToken })).body.data).toEqual([]);
  });

  it('shows a double sale with the steps to cancel one order', async () => {
    const { itemId } = await listedItem('Coach bag', ['ebay', 'mercari']);
    const first = await sell('ebay', itemId);
    const second = await sell('mercari', itemId);
    if (first.type !== 'recorded' || second.type !== 'recorded') throw new Error('not recorded');

    const sale = await api.call('getSale', { token, params: { saleId: second.saleId } });
    expect(sale.body).toMatchObject({ isDoubleSale: true, delistRuns: [] });
    const guide = orderCancelGuide('mercari');
    expect(sale.body.doubleSales).toEqual([
      {
        taskId: expect.any(String) as string,
        saleId: second.saleId,
        itemId,
        marketplace: 'mercari',
        earlierSaleId: first.saleId,
        earlierMarketplace: 'ebay',
        title: 'Cancel the order on Mercari',
        steps: [...guide.steps],
        cancelUrl: guide.url,
        status: 'open',
        createdAt: expect.any(String) as string,
      },
    ]);
    const item = await api.call('getItem', { token, params: { itemId } });
    expect(item.body.doubleSale).toEqual(sale.body.doubleSales[0]);
    // The banner still shows the first sale's delist.
    expect(item.body.delistRun?.saleId).toBe(first.saleId);
    expect(item.body.saleSummary?.saleId).toBe(first.saleId);
  });

  it('lists sales newest first, by item and by delist status, a page at a time', async () => {
    const { itemId } = await listedItem('Nothing else to delist', ['poshmark']);
    const recorded = await sell('poshmark', itemId);
    if (recorded.type !== 'recorded') throw new Error('not recorded');

    const byItem = await api.call('listSales', { token, query: { itemId } });
    expect(byItem.body.data.map((sale) => sale.id)).toEqual([recorded.saleId]);
    expect(byItem.body.data[0]?.delistRuns[0]).toMatchObject({
      status: 'completed',
      statusDisplay: { tone: 'neutral', label: 'Not listed anywhere else' },
      results: [],
    });
    const open = await api.call('listSales', {
      token,
      query: { delistStatus: ['in_progress', 'needs_attention'] },
    });
    expect(open.body.data.map((sale) => sale.id)).not.toContain(recorded.saleId);
    expect(open.body.data.length).toBeGreaterThan(0);
    const completed = await api.call('listSales', {
      token,
      query: { delistStatus: ['completed'] },
    });
    expect(completed.body.data.map((sale) => sale.id)).toContain(recorded.saleId);

    const all = await api.call('listSales', { token });
    const firstPage = await api.call('listSales', { token, query: { limit: 2 } });
    expect(firstPage.body.data.map((sale) => sale.id)).toEqual(
      all.body.data.slice(0, 2).map((sale) => sale.id),
    );
    expect(firstPage.body.nextCursor).toBeDefined();
    const nextPage = await api.call('listSales', {
      token,
      query: { limit: 2, cursor: firstPage.body.nextCursor ?? '' },
    });
    expect(nextPage.body.data.map((sale) => sale.id)).toEqual(
      all.body.data.slice(2, 4).map((sale) => sale.id),
    );
    expect((await api.call('listSales', { token, query: { delistStatus: ['done'] } })).status).toBe(
      422,
    );
  });
});
