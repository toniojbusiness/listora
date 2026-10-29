/**
 * The Reports screen against a real Postgres (docs/features/reports.md): `getYearReport` reads
 * the year's sales that stand in the seller's time zone by month and by marketplace, with haul
 * shares as cost of goods, refunds excluded, and every number it cannot compute reliably left
 * out; `exportSales` and `exportInventory` write the same money as CSV; only the account's own
 * rows.
 */
import { createInventoryItem, type FeeKind, type Marketplace, type SaleStatus } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'reports.owner@example.com';
const OTHER = 'reports.other@example.com';
const NEW_YORK = 'America/New_York';
const YEAR = { year: 2026, timeZone: NEW_YORK };

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

/** The cells of an RFC 4180 file, without its byte order mark. */
function parseCsv(content: string): string[][] {
  expect(content.startsWith('﻿')).toBe(true);
  expect(content.endsWith('\r\n')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = content.slice(1);
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else cell += char;
  }
  return rows;
}

/** The rows as objects keyed by the header's column names. */
function records(content: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(content);
  return rows.map((cells) =>
    Object.fromEntries((header ?? []).map((name, index) => [name, cells[index] ?? ''])),
  );
}

describe('the reports (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let accountId: string;
  let otherAccountId: string;
  let order = 0;

  beforeAll(async () => {
    api = await createTestApi('reports');
    token = await api.signIn(OWNER);
    accountId = (await api.tenantOf(OWNER)).accountId;
    await api.signIn(OTHER);
    otherAccountId = (await api.tenantOf(OTHER)).accountId;
  });

  afterAll(async () => {
    await api.close();
  });

  async function item(details: {
    title?: string;
    costCents?: number | null;
    status?: 'draft' | 'ready' | 'listed' | 'sold';
    account?: string;
  }) {
    const row = await createInventoryItem(api.db, details.account ?? accountId, {
      title: details.title ?? 'Item',
      cost_cents: details.costCents ?? null,
      status: details.status ?? 'sold',
    });
    return row;
  }

  /** A sale written as the intake leaves it, with the given fee lines. */
  async function sale(options: {
    marketplace: Marketplace;
    soldAt: string;
    lines: { itemId: string; priceCents: number }[];
    shippingChargedCents?: number;
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

  it('reports an empty year: twelve zero months and no marketplaces', async () => {
    const response = await api.call('getYearReport', {
      token,
      query: { year: 2020, timeZone: 'UTC' },
    });
    expect(response.status).toBe(200);
    expect(response.body.year).toBe(2020);
    expect(response.body.months).toHaveLength(12);
    expect(response.body.total).toEqual({
      salesCount: 0,
      itemsSold: 0,
      revenue: usd(0),
      shipping: usd(0),
      fees: usd(0),
      feesUnknownCount: 0,
      costOfGoods: usd(0),
      missingCostCount: 0,
      netProfit: usd(0),
    });
    expect(response.body.marketplaces).toEqual([]);
  });

  it('refuses a year outside 2000 to 2100 and an unknown time zone', async () => {
    const early = await api.call('getYearReport', {
      token,
      query: { year: 1999, timeZone: NEW_YORK },
    });
    expect(early.status).toBe(422);
    const zone = await api.call('exportSales', {
      token,
      query: { year: 2026, timeZone: 'Mars/Olympus' },
    });
    expect(zone.status).toBe(422);
    expect(zone.body).toMatchObject({ error: { code: 'validation_failed' } });
    const inventoryZone = await api.call('exportInventory', {
      token,
      query: { timeZone: 'Mars/Olympus' },
    });
    expect(inventoryZone.status).toBe(422);
  });

  describe('with a year of sales', () => {
    let haulIds: string[];

    beforeAll(async () => {
      // A $10 haul of 3: 1000 = 3 x 333 + 1, so the first to join costs $3.34, the others $3.33.
      haulIds = [
        (await item({ title: 'Haul shirt one' })).id,
        (await item({ title: 'Haul shirt two', status: 'listed' })).id,
        (await item({ title: '=HYPERLINK("https://example.com")' })).id,
      ];
      const haul = await api.call('createHaul', {
        token,
        body: { total: usd(1_000), itemCount: 3, itemIds: haulIds },
      });
      expect(haul.status).toBe(201);
      const [first, second, third] = haulIds;
      if (first === undefined || second === undefined || third === undefined) throw new Error();

      // January 31 at 11:30 pm in New York (February 1 in UTC): eBay, its own fees and label.
      await sale({
        marketplace: 'ebay',
        soldAt: '2026-02-01T04:30:00Z',
        lines: [{ itemId: first, priceCents: 2000 }],
        fees: [
          { kind: 'marketplace', amountCents: 260 },
          { kind: 'shipping_label', amountCents: 500 },
        ],
      });
      // March: a Depop bundle of a haul item and an item with its own cost.
      const jacket = (await item({ title: 'Wool jacket', costCents: 1200 })).id;
      await sale({
        marketplace: 'depop',
        soldAt: '2026-03-03T17:00:00Z',
        lines: [
          { itemId: third, priceCents: 1000 },
          { itemId: jacket, priceCents: 3000 },
        ],
        shippingChargedCents: 499,
        fees: [{ kind: 'marketplace', amountCents: 400 }],
      });
      // April: a sale refunded on return and one canceled: they count nowhere.
      const returned = (await item({ title: 'Returned boots', costCents: 900 })).id;
      await sale({
        marketplace: 'mercari',
        soldAt: '2026-04-10T17:00:00Z',
        lines: [{ itemId: returned, priceCents: 5000 }],
        status: 'returned',
        fees: [{ kind: 'marketplace', amountCents: 500 }],
      });
      const canceled = (await item({ title: 'Canceled scarf', costCents: 100 })).id;
      await sale({
        marketplace: 'ebay',
        soldAt: '2026-04-11T17:00:00Z',
        lines: [{ itemId: canceled, priceCents: 700 }],
        status: 'canceled',
      });
      // May: Poshmark, whose fees are still the fee table's estimate.
      const dress = (await item({ title: 'Silk dress', costCents: 800 })).id;
      await sale({
        marketplace: 'poshmark',
        soldAt: '2026-05-05T17:00:00Z',
        lines: [{ itemId: dress, priceCents: 4000 }],
        fees: [{ kind: 'marketplace', amountCents: 800, estimated: true }],
      });
      // June: Mercari, an item with no cost entered.
      const hat = (await item({ title: 'Bucket hat' })).id;
      await sale({
        marketplace: 'mercari',
        soldAt: '2026-06-06T17:00:00Z',
        lines: [{ itemId: hat, priceCents: 1500 }],
        fees: [{ kind: 'marketplace', amountCents: 150 }],
      });
      // New Year's Eve 2025 in New York (2026 in UTC): last year's.
      const lastYear = (await item({ title: 'Last year', costCents: 100 })).id;
      await sale({
        marketplace: 'ebay',
        soldAt: '2026-01-01T04:00:00Z',
        lines: [{ itemId: lastYear, priceCents: 9900 }],
        fees: [{ kind: 'marketplace', amountCents: 10 }],
      });
      // Another account's sale in the same year.
      const theirs = (await item({ title: 'Not mine', costCents: 1, account: otherAccountId })).id;
      await sale({
        marketplace: 'ebay',
        soldAt: '2026-07-07T17:00:00Z',
        lines: [{ itemId: theirs, priceCents: 77_700 }],
        fees: [{ kind: 'marketplace', amountCents: 10 }],
        account: otherAccountId,
      });
    });

    it('splits the year by month, with haul shares as cost of goods', async () => {
      const response = await api.call('getYearReport', { token, query: YEAR });
      expect(response.status).toBe(200);
      const months = response.body.months;
      expect(months.map((month) => month.month)).toEqual(
        Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`),
      );
      // January: 2000 - 260 fees - 500 label - 334 (the haul's first share) = 906.
      expect(months[0]?.totals).toEqual({
        salesCount: 1,
        itemsSold: 1,
        revenue: usd(2000),
        shipping: usd(500),
        fees: usd(260),
        feesUnknownCount: 0,
        costOfGoods: usd(334),
        missingCostCount: 0,
        netProfit: usd(906),
      });
      // March: 1000 + 3000 + 499 shipping - 400 fees - (333 + 1200) = 2566.
      expect(months[2]?.totals).toMatchObject({
        salesCount: 1,
        itemsSold: 2,
        revenue: usd(4499),
        fees: usd(400),
        costOfGoods: usd(1533),
        netProfit: usd(2566),
      });
      // April's returned and canceled sales count nowhere.
      expect(months[3]?.totals).toMatchObject({ salesCount: 0, revenue: usd(0) });
    });

    it('leaves out fees, cost, and profit wherever they are not known, and says why', async () => {
      const { body } = await api.call('getYearReport', { token, query: YEAR });
      const may = body.months[4]?.totals;
      expect(may).toMatchObject({ revenue: usd(4000), costOfGoods: usd(800), feesUnknownCount: 1 });
      expect(may).not.toHaveProperty('fees');
      expect(may).not.toHaveProperty('netProfit');
      const june = body.months[5]?.totals;
      expect(june).toMatchObject({ fees: usd(150), missingCostCount: 1 });
      expect(june).not.toHaveProperty('costOfGoods');
      expect(june).not.toHaveProperty('netProfit');

      expect(body.total).toEqual({
        salesCount: 4,
        itemsSold: 5,
        revenue: usd(2000 + 4499 + 4000 + 1500),
        shipping: usd(500),
        feesUnknownCount: 1,
        missingCostCount: 1,
      });
    });

    it('lists the marketplaces with a sale in their fixed order, with their own totals', async () => {
      const { body } = await api.call('getYearReport', { token, query: YEAR });
      expect(body.marketplaces.map((row) => row.marketplace)).toEqual([
        'ebay',
        'depop',
        'poshmark',
        'mercari',
      ]);
      expect(body.marketplaces[0]?.totals).toMatchObject({ itemsSold: 1, netProfit: usd(906) });
      expect(body.marketplaces[1]?.totals).toMatchObject({ itemsSold: 2, netProfit: usd(2566) });
      // Mercari's refunded sale is not there: only the June hat.
      expect(body.marketplaces[3]?.totals).toMatchObject({ salesCount: 1, revenue: usd(1500) });
    });

    it("exports the year's sales as CSV with the same money, refunds excluded", async () => {
      const response = await api.call('exportSales', { token, query: YEAR });
      expect(response.status).toBe(200);
      expect(response.body.fileName).toBe('listora-sales-2026.csv');
      expect(response.body.rowCount).toBe(5);
      const rows = records(response.body.content);
      expect(rows.map((row) => row['Title'])).toEqual([
        'Haul shirt one',
        `'=HYPERLINK("https://example.com")`,
        'Wool jacket',
        'Silk dress',
        'Bucket hat',
      ]);
      const { 'Order number': orderNumber, SKU: sku, ...first } = rows[0] ?? {};
      expect(orderNumber).toMatch(/^order-\d+$/);
      expect(sku).toMatch(/^[A-Z]+-\d{6}$/);
      expect(first).toEqual({
        'Sold on': '2026-01-31',
        Marketplace: 'eBay',
        Title: 'Haul shirt one',
        Brand: '',
        Category: '',
        'Sale price': '20.00',
        'Shipping charged': '0.00',
        Fees: '2.60',
        'Fees from': 'eBay',
        'Shipping cost': '5.00',
        'Cost of goods': '3.34',
        'Cost basis': 'Share of a $10.00 haul of 3',
        Profit: '9.06',
      });
      // The bundle's 4.99 shipping and 4.00 fee split by price: 1.25 and 3.74, 1.00 and 3.00.
      expect(rows[1]).toMatchObject({
        'Shipping charged': '1.25',
        Fees: '1.00',
        'Cost of goods': '3.33',
        'Cost basis': 'Share of a $10.00 haul of 3',
        Profit: '6.92',
      });
      expect(rows[2]).toMatchObject({
        'Shipping charged': '3.74',
        Fees: '3.00',
        'Cost basis': 'Own cost',
        Profit: '18.74',
      });
      expect(rows[3]).toMatchObject({ Fees: '', 'Fees from': 'Estimate, not final', Profit: '' });
      expect(rows[4]).toMatchObject({
        'Cost of goods': '',
        'Cost basis': 'No cost entered',
        Profit: '',
      });
      // The profits there add up to the months' known profit.
      expect(9.06 + 6.92 + 18.74).toBeCloseTo((906 + 2566) / 100, 2);
    });

    it('exports the inventory as CSV by SKU, only the account own items', async () => {
      const response = await api.call('exportInventory', { token, query: { timeZone: NEW_YORK } });
      expect(response.status).toBe(200);
      expect(response.body.fileName).toMatch(/^listora-inventory-\d{4}-\d{2}-\d{2}\.csv$/);
      const rows = records(response.body.content);
      expect(response.body.rowCount).toBe(rows.length);
      const skus = rows.map((row) => row['SKU'] ?? '');
      expect(skus).toEqual([...skus].sort());
      expect(rows.map((row) => row['Title'])).not.toContain('Not mine');
      const listed = rows.find((row) => row['Title'] === 'Haul shirt two');
      expect(listed).toMatchObject({
        Status: 'Listed',
        Quantity: '1',
        Cost: '3.33',
        'Cost basis': 'Share of a $10.00 haul of 3',
        'List price': '',
      });
      expect(listed?.['Added on']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rows.find((row) => row['Title'] === 'Bucket hat')).toMatchObject({
        Status: 'Sold',
        Cost: '',
        'Cost basis': 'No cost entered',
      });
    });

    it("never shows another account's sales", async () => {
      const otherToken = await api.signIn(OTHER);
      const { body } = await api.call('getYearReport', { token: otherToken, query: YEAR });
      expect(body.total).toMatchObject({ salesCount: 1, revenue: usd(77_700) });
      const csv = await api.call('exportSales', { token: otherToken, query: YEAR });
      expect(records(csv.body.content).map((row) => row['Title'])).toEqual(['Not mine']);
    });
  });
});
