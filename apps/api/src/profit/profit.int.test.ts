/**
 * The profit dashboard against a real Postgres (docs/features/profit.md): `getProfit` reads the
 * period's sales that stand in the seller's time zone, splits each order's money as the sale
 * screen does, ranks brands and categories, lists marketplaces in their fixed order, and
 * counts dead stock today; only the account's own rows.
 */
import { createInventoryItem, type FeeKind, type Marketplace, type SaleStatus } from '@listora/db';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { recordSale } from '@listora/sales';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'profit.owner@example.com';
const OTHER = 'profit.other@example.com';
const NEW_YORK = 'America/New_York';
const OCTOBER = { from: '2026-10-01', to: '2026-10-31', timeZone: NEW_YORK };

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });
const DAY_MS = 86_400_000;

describe('the profit dashboard (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let accountId: string;
  let order = 0;

  beforeAll(async () => {
    api = await createTestApi('profit');
    token = await api.signIn(OWNER);
    accountId = (await api.tenantOf(OWNER)).accountId;
  });

  afterAll(async () => {
    await api.close();
  });

  async function item(details: {
    brand?: string;
    category?: string;
    costCents?: number | null;
    status?: 'draft' | 'ready' | 'listed' | 'sold' | 'archived';
    createdAt?: Date;
    purchaseDate?: string;
    title?: string;
    account?: string;
  }) {
    const row = await createInventoryItem(api.db, details.account ?? accountId, {
      title: details.title ?? 'Item',
      brand: details.brand ?? null,
      category: details.category ?? null,
      cost_cents: details.costCents ?? null,
      status: details.status ?? 'sold',
      ...(details.status === 'archived' ? { pre_archive_status: 'ready' as const } : {}),
      ...(details.createdAt === undefined ? {} : { created_at: details.createdAt }),
      purchase_date: details.purchaseDate ?? null,
    });
    return row;
  }

  /** A sale written as the intake leaves it, with the given fee lines. */
  async function sale(options: {
    marketplace: Marketplace;
    soldAt: string;
    lines: { itemId: string; priceCents: number }[];
    shippingChargedCents?: number;
    shippingCostCents?: number;
    status?: SaleStatus;
    fees?: { kind: FeeKind; amountCents: number; line?: number; estimated?: boolean }[];
    account?: string;
  }) {
    const account = options.account ?? accountId;
    const status = options.status ?? 'confirmed';
    const soldAt = new Date(options.soldAt);
    order += 1;
    const row = await api.db
      .insertInto('sale')
      .values({
        account_id: account,
        marketplace: options.marketplace,
        external_order_id: `order-${String(order)}`,
        sold_at: soldAt,
        shipping_charged_cents: options.shippingChargedCents ?? 0,
        shipping_cost_cents: options.shippingCostCents ?? null,
        detection_source: 'manual',
        status,
        ...(status === 'detected' ? {} : { confirmed_at: soldAt }),
        ...(status === 'canceled' ? { canceled_at: soldAt } : {}),
        ...(status === 'returned' ? { returned_at: soldAt } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const saleItems = await api.db
      .insertInto('sale_item')
      .values(
        options.lines.map((line) => ({
          account_id: account,
          sale_id: row.id,
          marketplace: options.marketplace,
          item_id: line.itemId,
          sale_price_cents: line.priceCents,
        })),
      )
      .returning('id')
      .execute();
    for (const fee of options.fees ?? []) {
      await api.db
        .insertInto('fee_line')
        .values({
          account_id: account,
          sale_id: row.id,
          sale_item_id: fee.line === undefined ? null : (saleItems[fee.line]?.id ?? null),
          kind: fee.kind,
          amount_cents: fee.amountCents,
          source: fee.estimated === true ? 'estimated' : 'actual',
        })
        .execute();
    }
    return row.id;
  }

  async function listedOn(itemId: string, listedAt: string) {
    await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: itemId,
        marketplace: 'poshmark',
        status: 'sold',
        listed_at: new Date(listedAt),
        external_url: `https://example.com/poshmark/${itemId}`,
      })
      .execute();
  }

  function today(zone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(api.clock.now));
    return parts;
  }

  function daysAgo(days: number): string {
    return new Date(Date.parse(`${today(NEW_YORK)}T00:00:00Z`) - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
  }

  it('reports an empty period with zero totals, empty days, and no averages', async () => {
    const response = await api.call('getProfit', {
      token,
      query: { from: '2020-02-01', to: '2020-02-07', timeZone: 'UTC' },
    });
    expect(response.status).toBe(200);
    expect(response.body.period).toEqual({
      from: '2020-02-01',
      to: '2020-02-07',
      timeZone: 'UTC',
      granularity: 'day',
    });
    expect(response.body.summary).toEqual({
      revenue: usd(0),
      fees: usd(0),
      shipping: usd(0),
      costOfGoods: usd(0),
      netProfit: usd(0),
      salesCount: 0,
      itemsSold: 0,
      missingCostCount: 0,
      feesEstimated: false,
    });
    expect(response.body.series).toHaveLength(7);
    expect(response.body.marketplaces).toEqual([]);
    expect(response.body.brands).toEqual({ best: [], worst: [] });
  });

  describe('with sales in October', () => {
    let jacket: string;

    beforeAll(async () => {
      // A Levi's jacket listed on Oct 1 and sold on eBay on Oct 11 with actual fees and a
      // label eBay deducted.
      jacket = (
        await item({ brand: "Levi's", category: 'clothing/outerwear/jackets', costCents: 1200 })
      ).id;
      await listedOn(jacket, '2026-10-01T16:00:00Z');
      await sale({
        marketplace: 'ebay',
        soldAt: '2026-10-11T16:00:00Z',
        lines: [{ itemId: jacket, priceCents: 4500 }],
        shippingChargedCents: 599,
        fees: [
          { kind: 'marketplace', amountCents: 612 },
          { kind: 'shipping_label', amountCents: 830 },
        ],
      });
      // A Nike bundle on Mercari on Oct 20: one item without a cost, a label bought outside
      // the payout, and estimated fees.
      const sneakers = await item({ brand: 'Nike', category: 'shoes/sneakers', costCents: 500 });
      const hoodie = await item({
        brand: 'nike',
        category: 'clothing/tops/hoodies_sweatshirts',
        costCents: null,
        createdAt: new Date('2026-10-10T16:00:00Z'),
      });
      await sale({
        marketplace: 'mercari',
        soldAt: '2026-10-20T16:00:00Z',
        lines: [
          { itemId: sneakers.id, priceCents: 3000 },
          { itemId: hoodie.id, priceCents: 1000 },
        ],
        shippingCostCents: 700,
        fees: [{ kind: 'marketplace', amountCents: 400, estimated: true }],
      });
      // Sold at 22:00 on Oct 31 in New York, which is already November in UTC.
      const scarf = await item({ brand: 'Gap', category: 'accessories/scarves', costCents: 100 });
      await sale({
        marketplace: 'depop',
        soldAt: '2026-11-01T02:00:00Z',
        lines: [{ itemId: scarf.id, priceCents: 900 }],
      });
      // Not counted: a canceled and a returned sale, a sale in September, another account's.
      for (const status of ['canceled', 'returned'] as const) {
        const undone = await item({ brand: 'Zara', costCents: 100 });
        await sale({
          marketplace: 'ebay',
          soldAt: '2026-10-15T16:00:00Z',
          lines: [{ itemId: undone.id, priceCents: 99_900 }],
          status,
        });
      }
      const september = await item({ brand: 'Gap', costCents: 100 });
      await sale({
        marketplace: 'ebay',
        soldAt: '2026-09-30T16:00:00Z',
        lines: [{ itemId: september.id, priceCents: 50_000 }],
      });
      await api.signIn(OTHER);
      const other = (await api.tenantOf(OTHER)).accountId;
      const theirs = await item({ account: other, brand: 'Gap', costCents: 100 });
      await sale({
        account: other,
        marketplace: 'ebay',
        soldAt: '2026-10-12T16:00:00Z',
        lines: [{ itemId: theirs.id, priceCents: 70_000 }],
      });
      // Listed now, added by the period's end: sell-through's unsold side.
      for (const createdAt of ['2026-10-05T12:00:00Z', '2026-09-01T12:00:00Z']) {
        await item({ status: 'listed', createdAt: new Date(createdAt), costCents: 300 });
      }
    });

    it('totals the period’s sales that stand, in the seller’s time zone', async () => {
      const response = await api.call('getProfit', { token, query: OCTOBER });
      expect(response.status).toBe(200);
      // Revenue 4500 + 599 + 3000 + 1000 + 900 = 9999; fees 612 + 400 = 1012; shipping
      // 830 + 700 = 1530; cost 1200 + 500 + 100 = 1800; profit 9999 - 1012 - 1530 - 1800 =
      // 5657; ROI 5657 / 1800 = 314.28%.
      expect(response.body.summary).toEqual({
        revenue: usd(9999),
        fees: usd(1012),
        shipping: usd(1530),
        costOfGoods: usd(1800),
        netProfit: usd(5657),
        roiBasisPoints: 31428,
        salesCount: 3,
        itemsSold: 4,
        missingCostCount: 1,
        averageSalePrice: usd(2350),
        averageProfitPerItem: usd(1414),
        // The sneakers and the scarf were added after they sold (as when a seller records an
        // old sale) and count as zero days, so the average depends on today's date.
        averageDaysToSell: expect.any(Number) as number,
        // 4 sold of 4 + 2 listed.
        sellThroughBasisPoints: 6667,
        feesEstimated: true,
      });
      expect(response.body.series).toHaveLength(31);
      expect(response.body.series[10]).toEqual({
        start: '2026-10-11',
        revenue: usd(5099),
        netProfit: usd(5099 - 612 - 830 - 1200),
        itemsSold: 1,
      });
      expect(response.body.series[30]).toMatchObject({ start: '2026-10-31', itemsSold: 1 });

      const utc = await api.call('getProfit', { token, query: { ...OCTOBER, timeZone: 'UTC' } });
      expect(utc.body.summary.itemsSold).toBe(3);
    });

    it('lists the marketplaces in their fixed order with the seller’s own totals', async () => {
      const response = await api.call('getProfit', { token, query: OCTOBER });
      expect(response.body.marketplaces.map((row) => row.marketplace)).toEqual([
        'ebay',
        'depop',
        'mercari',
      ]);
      // The bundle's $7.00 label and $4.00 fee split 3:1 by price.
      expect(response.body.marketplaces[2]).toEqual({
        marketplace: 'mercari',
        salesCount: 1,
        itemsSold: 2,
        revenue: usd(4000),
        fees: usd(400),
        shipping: usd(700),
        costOfGoods: usd(500),
        netProfit: usd(2400),
      });
    });

    it('ranks brands and categories by net profit, matching brands ignoring case', async () => {
      const response = await api.call('getProfit', { token, query: OCTOBER });
      const { brands, categories } = response.body;
      // Levi's 5099 - 612 - 830 - 1200 = 2457; Nike 4000 - 400 - 700 - 500 = 2400; Gap 800.
      expect(brands.best.map((group) => [group.key, group.itemsSold])).toEqual([
        ["Levi's", 1],
        ['Nike', 2],
        ['Gap', 1],
      ]);
      expect(brands.worst).toEqual([]);
      expect(brands.best[0]).toEqual({
        key: "Levi's",
        itemsSold: 1,
        revenue: usd(5099),
        netProfit: usd(2457),
        roiBasisPoints: 20475,
        averageDaysToSell: 10,
      });
      expect(categories.best.map((group) => group.key)).toEqual([
        'clothing/outerwear/jackets',
        'shoes/sneakers',
        'accessories/scarves',
        'clothing/tops/hoodies_sweatshirts',
      ]);
      // The hoodie was added on Oct 10 and sold on Oct 20, never listed through Listora.
      expect(categories.best[3]?.averageDaysToSell).toBe(10);
    });

    it('agrees with the sale screen to the cent', async () => {
      const bag = await item({ brand: 'Coach', costCents: 2500 });
      const recorded = await recordSale(
        api.db,
        {
          accountId,
          marketplace: 'poshmark',
          externalOrderId: 'posh-1',
          soldAt: new Date('2026-08-15T16:00:00Z'),
          currency: 'USD',
          shippingChargedCents: 0,
          detectionSource: 'manual',
          inboundEventId: null,
          shipBy: null,
          lines: [{ itemId: bag.id, listingId: null, quantity: 1, priceCents: 8900 }],
        },
        {
          adapters: createMarketplaceAdapters({
            fakeMarketplaceUrl: undefined,
            ebay: undefined,
            depop: undefined,
          }).lookup,
        },
      );
      if (recorded.type !== 'recorded') throw new Error('not recorded');
      const saleView = await api.call('getSale', { token, params: { saleId: recorded.saleId } });
      const report = await api.call('getProfit', {
        token,
        query: { from: '2026-08-15', to: '2026-08-15', timeZone: NEW_YORK },
      });
      expect(saleView.body.profit).toBeDefined();
      expect(report.body.summary.netProfit).toEqual(saleView.body.profit);
      expect(report.body.summary.feesEstimated).toBe(true);
    });
  });

  it('counts dead stock today by purchase date or, without one, when added', async () => {
    await item({ status: 'listed', purchaseDate: daysAgo(100), costCents: 700, title: 'Old coat' });
    await item({ status: 'ready', purchaseDate: daysAgo(70), costCents: null, title: 'Old hat' });
    await item({ status: 'draft', purchaseDate: daysAgo(10), costCents: 900 });
    await item({ status: 'listed', purchaseDate: daysAgo(60), costCents: 900 });
    await item({ status: 'archived', purchaseDate: daysAgo(400), costCents: 900 });
    await item({ status: 'sold', purchaseDate: daysAgo(400), costCents: 900 });

    const response = await api.call('getProfit', {
      token,
      query: { from: '2026-10-01', to: '2026-10-31', timeZone: NEW_YORK },
    });
    const { deadStock } = response.body;
    // The two items listed above were added on Oct 5 and Sep 1; their age counts from then.
    const addedOver60 = [Date.parse('2026-10-05'), Date.parse('2026-09-01')].filter(
      (added) => Date.parse(today(NEW_YORK)) - added > 60 * DAY_MS,
    ).length;
    expect(deadStock.over90Days.itemCount).toBeGreaterThanOrEqual(1);
    expect(deadStock.over60Days).toEqual({
      itemCount: 2 + addedOver60,
      cost: usd(700 + 300 * addedOver60),
      missingCostCount: 1,
    });
    expect(deadStock.oldest[0]).toMatchObject({
      title: 'Old coat',
      ageDays: 100,
      status: 'listed',
    });
    expect(deadStock.oldest.find((row) => row.title === 'Old hat')).toMatchObject({
      ageDays: 70,
      status: 'ready',
    });
    expect(deadStock.oldest.find((row) => row.title === 'Old hat')?.cost).toBeUndefined();
  });

  it('refuses an unknown time zone, a backwards period, and one that is too long', async () => {
    const zone = await api.call('getProfit', {
      token,
      query: { ...OCTOBER, timeZone: 'Mars/Olympus_Mons' },
    });
    expect(zone.status).toBe(422);
    expect(zone.error.fieldErrors?.[0]?.field).toBe('timeZone');

    const backwards = await api.call('getProfit', {
      token,
      query: { from: '2026-10-31', to: '2026-10-01', timeZone: NEW_YORK },
    });
    expect(backwards.status).toBe(422);

    const long = await api.call('getProfit', {
      token,
      query: { from: '2000-01-01', to: '2026-10-01', timeZone: NEW_YORK },
    });
    expect(long.status).toBe(422);

    const malformed = await api.call('getProfit', {
      token,
      query: { from: 'yesterday', to: '2026-10-01', timeZone: NEW_YORK },
    });
    expect(malformed.status).toBe(422);
  });

  it('needs a signed-in user', async () => {
    const response = await api.call('getProfit', { query: OCTOBER });
    expect(response.status).toBe(401);
  });
});
