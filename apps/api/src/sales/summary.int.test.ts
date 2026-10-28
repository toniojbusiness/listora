/**
 * The seller's sales in total and per marketplace (`getSalesSummary`), and the sales feed's
 * order (`listSales`, newest sold first), against a real Postgres. Sales are recorded through
 * `recordSale`, as the worker records detected ones (a sales history read records many at once,
 * oldest last).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMarketplaceAdapters } from '@listora/marketplaces';
import { changeSale, recordSale } from '@listora/sales';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'summary.owner@example.com';
const OTHER = 'summary.other@example.com';
const DAY = 86_400_000;

describe("the seller's sales in total and per marketplace (real Postgres)", () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;
  let accountId: string;
  const adapters = createMarketplaceAdapters({
    fakeMarketplaceUrl: undefined,
    ebay: undefined,
    depop: undefined,
  }).lookup;
  let order = 0;

  beforeAll(async () => {
    api = await createTestApi('sales_summary');
    token = await api.signIn(OWNER);
    otherToken = await api.signIn(OTHER);
    accountId = (await api.tenantOf(OWNER)).accountId;
  });

  afterAll(async () => {
    await api.close();
  });

  async function item(title: string): Promise<string> {
    const created = await api.call('createItem', { token, body: { details: { title } } });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  /** A sale of the items (a bundle when several), as a sale check records one. */
  async function sold(
    marketplace: 'depop' | 'poshmark' | 'mercari',
    soldAt: Date,
    lines: readonly { itemId: string; priceCents: number }[],
    shippingChargedCents = 0,
  ): Promise<string> {
    order += 1;
    const sale = await recordSale(
      api.db,
      {
        accountId,
        marketplace,
        externalOrderId: `summary-${String(order)}`,
        soldAt,
        currency: 'USD',
        shippingChargedCents,
        detectionSource: 'history',
        inboundEventId: null,
        shipBy: null,
        lines: lines.map((line) => ({ ...line, listingId: null, quantity: 1 })),
      },
      { adapters },
    );
    if (sale.type !== 'recorded') throw new Error(`not recorded: ${sale.type}`);
    return sale.saleId;
  }

  it('shows nothing before the first sale', async () => {
    const empty = await api.call('getSalesSummary', { token: otherToken });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      total: { salesCount: 0, itemsSold: 0, revenue: { amountCents: 0, currency: 'USD' } },
      marketplaces: [],
    });
  });

  it('adds up every sale that stands, in total and per marketplace in the fixed order', async () => {
    await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'ebay',
        mode: 'api',
        external_user_id: 'summary-seller',
        display_name: 'summary_seller',
        status: 'connected',
      })
      .execute();
    const now = Date.now();
    // A sales history recorded at once: the oldest sale last.
    const recent = await sold('mercari', new Date(now - DAY), [
      { itemId: await item('Wool scarf'), priceCents: 2000 },
    ]);
    await sold(
      'poshmark',
      new Date(now - 3 * DAY),
      [
        { itemId: await item('Band tee'), priceCents: 1200 },
        { itemId: await item('Mini skirt'), priceCents: 2000 },
      ],
      799,
    );
    const first = await sold('depop', new Date(now - 30 * DAY), [
      { itemId: await item('Denim jacket'), priceCents: 3800 },
    ]);
    const canceled = await sold('depop', new Date(now - 2 * DAY), [
      { itemId: await item('Silk top'), priceCents: 9900 },
    ]);
    await changeSale(api.db, { accountId, saleId: canceled, action: 'cancel', userId: null });

    const summary = await api.call('getSalesSummary', { token });
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      total: {
        salesCount: 3,
        itemsSold: 4,
        // The sale prices plus the shipping the buyer paid; the canceled sale counts nowhere.
        revenue: { amountCents: 3800 + 1200 + 2000 + 799 + 2000, currency: 'USD' },
      },
      // eBay is connected without a sale; never ranked, always this order.
      marketplaces: [
        {
          marketplace: 'ebay',
          salesCount: 0,
          itemsSold: 0,
          revenue: { amountCents: 0, currency: 'USD' },
        },
        {
          marketplace: 'depop',
          salesCount: 1,
          itemsSold: 1,
          revenue: { amountCents: 3800, currency: 'USD' },
        },
        {
          marketplace: 'poshmark',
          salesCount: 1,
          itemsSold: 2,
          revenue: { amountCents: 3999, currency: 'USD' },
        },
        {
          marketplace: 'mercari',
          salesCount: 1,
          itemsSold: 1,
          revenue: { amountCents: 2000, currency: 'USD' },
        },
      ],
      firstSoldAt: expect.any(String) as unknown,
    });
    const firstSale = await api.call('getSale', { token, params: { saleId: first } });
    expect(summary.body.firstSoldAt).toBe(firstSale.body.soldAt);
    // Another account's sales are not in it.
    expect((await api.call('getSalesSummary', { token: otherToken })).body.total.salesCount).toBe(
      0,
    );

    // The feed lists them by when they sold, newest first, whatever order they were recorded in,
    // and pages through them in that order.
    const all = await api.call('listSales', { token });
    expect(all.body.data.map((sale) => sale.id)[0]).toBe(recent);
    const soldTimes = all.body.data.map((sale) => Date.parse(sale.soldAt));
    expect(soldTimes).toEqual([...soldTimes].sort((a, b) => b - a));
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.call('listSales', {
        token,
        query: { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
      });
      pages.push(...page.body.data.map((sale) => sale.id));
      cursor = page.body.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toEqual(all.body.data.map((sale) => sale.id));
    expect((await api.call('listSales', { token, query: { cursor: 'not-a-cursor' } })).status).toBe(
      400,
    );
  });
});
