/**
 * `listSales` in each order against a real Postgres: sales recorded through `recordSale`, as the
 * worker records detected ones, with fee lines and costs written directly.
 */
import type { SaleSort } from '@listora/api-contract';
import { saleSortValues } from '@listora/api-contract';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { recordSale } from '@listora/sales';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'sales.sort@example.com';

describe('listSales sorted (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let accountId: string;
  const adapters = createMarketplaceAdapters({
    fakeMarketplaceUrl: undefined,
    ebay: undefined,
    depop: undefined,
  }).lookup;
  const ids: Record<string, string> = {};

  interface Seeded {
    name: string;
    soldAt: string;
    /** Each item's sale price and cost (null: not known). */
    lines: { priceCents: number; costCents: number | null }[];
    shippingChargedCents?: number;
    shippingCostCents?: number;
    /** No fee lines when absent: the sale has no profit yet. */
    feesCents?: number;
    canceled?: boolean;
  }

  // Recorded in this order. s6 sold at the same time as s2 and was recorded after it.
  const sales: Seeded[] = [
    {
      name: 's1',
      soldAt: '2026-10-20T12:00:00Z',
      lines: [{ priceCents: 4000, costCents: 1000 }],
      shippingChargedCents: 500,
      feesCents: 400,
    },
    {
      name: 's2',
      soldAt: '2026-10-22T12:00:00Z',
      lines: [{ priceCents: 2000, costCents: 500 }],
      shippingCostCents: 200,
      feesCents: 300,
    },
    {
      name: 's3',
      soldAt: '2026-10-21T12:00:00Z',
      lines: [
        { priceCents: 1500, costCents: 100 },
        { priceCents: 1500, costCents: 100 },
      ],
    },
    {
      name: 's4',
      soldAt: '2026-10-23T12:00:00Z',
      lines: [{ priceCents: 4000, costCents: null }],
      feesCents: 100,
    },
    {
      name: 's5',
      soldAt: '2026-10-19T12:00:00Z',
      lines: [{ priceCents: 6000, costCents: 100 }],
      feesCents: 100,
      canceled: true,
    },
    {
      name: 's6',
      soldAt: '2026-10-22T12:00:00Z',
      lines: [{ priceCents: 1000, costCents: 0 }],
      feesCents: 50,
    },
  ];

  beforeAll(async () => {
    api = await createTestApi('sales_sort');
    token = await api.signIn(OWNER);
    accountId = (await api.tenantOf(OWNER)).accountId;
    for (const seeded of sales) {
      const itemIds: string[] = [];
      for (const line of seeded.lines) {
        const created = await api.call('createItem', {
          token,
          body: {
            details: {
              title: `${seeded.name} item`,
              ...(line.costCents === null
                ? {}
                : { cost: { amountCents: line.costCents, currency: 'USD' } }),
            },
          },
        });
        itemIds.push(created.body.id);
      }
      const result = await recordSale(
        api.db,
        {
          accountId,
          marketplace: 'poshmark',
          externalOrderId: `order-${seeded.name}`,
          soldAt: new Date(seeded.soldAt),
          currency: 'USD',
          shippingChargedCents: seeded.shippingChargedCents ?? 0,
          detectionSource: 'webhook',
          inboundEventId: null,
          shipBy: null,
          lines: seeded.lines.map((line, index) => ({
            itemId: itemIds[index] ?? '',
            listingId: null,
            quantity: 1,
            priceCents: line.priceCents,
          })),
        },
        { adapters },
      );
      if (result.type !== 'recorded') throw new Error(`sale ${seeded.name} was not recorded`);
      ids[seeded.name] = result.saleId;
      // Recording estimates the fees; the test sets them itself.
      await api.db.deleteFrom('fee_line').where('sale_id', '=', result.saleId).execute();
      if (seeded.feesCents !== undefined) {
        await api.db
          .insertInto('fee_line')
          .values({
            account_id: accountId,
            sale_id: result.saleId,
            kind: 'marketplace',
            amount_cents: seeded.feesCents,
            source: 'actual',
          })
          .execute();
      }
      await api.db
        .updateTable('sale')
        .set({
          shipping_cost_cents: seeded.shippingCostCents ?? null,
          ...(seeded.canceled === true ? { status: 'canceled', canceled_at: new Date() } : {}),
        })
        .where('id', '=', result.saleId)
        .execute();
    }
  });

  afterAll(async () => {
    await api.close();
  });

  const names = (body: { data: { id: string }[] }) =>
    body.data.map((sale) => Object.keys(ids).find((name) => ids[name] === sale.id));

  const list = (query: Record<string, string | number | readonly string[]>) =>
    api.call('listSales', { token, query });

  /** Every page of `sort`, two at a time. */
  const allPages = async (sort: SaleSort, filters: Record<string, string> = {}) => {
    const seen: (string | undefined)[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await list({ ...filters, sort, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      seen.push(...names(response.body));
      cursor = response.body.nextCursor;
      if (cursor === undefined) return seen;
    }
    throw new Error('more pages than sales');
  };

  const expected: Record<SaleSort, string[]> = {
    // s6 and s2 sold at once: the one recorded last first.
    sold_newest: ['s4', 's6', 's2', 's3', 's1', 's5'],
    sold_oldest: ['s5', 's1', 's3', 's6', 's2', 's4'],
    // s4 and s1 both sold for $40: the newest sold first.
    price_high: ['s5', 's4', 's1', 's3', 's2', 's6'],
    price_low: ['s6', 's2', 's3', 's4', 's1', 's5'],
    // $40 + $5 - $4 - $10, $20 - $3 - $2 - $5, $10 - $0.50; then without a profit (no fees yet,
    // a cost not known, canceled), newest sold first.
    profit_high: ['s1', 's2', 's6', 's4', 's3', 's5'],
  };

  it('defaults to newest sold first', async () => {
    expect(names((await list({})).body)).toEqual(expected.sold_newest);
  });

  it.each(saleSortValues)('sorts by %s, the same over pages as on one', async (sort) => {
    expect(names((await list({ sort })).body)).toEqual(expected[sort]);
    expect(await allPages(sort)).toEqual(expected[sort]);
  });

  it('sorts by the profit each sale shows', async () => {
    const response = await list({ sort: 'profit_high' });
    expect(
      response.body.data.map((sale) =>
        sale.status === 'canceled' ? undefined : sale.profit?.amountCents,
      ),
    ).toEqual([3100, 1000, 950, undefined, undefined, undefined]);
  });

  it('sorts only the sales the filters leave', async () => {
    expect(await allPages('price_high', { status: 'detected' })).toEqual([
      's4',
      's1',
      's3',
      's2',
      's6',
    ]);
  });

  it('refuses a cursor from another sort with 400', async () => {
    const byPrice = await list({ sort: 'price_high', limit: 2 });
    const cursor = byPrice.body.nextCursor ?? '';
    for (const query of [{ cursor }, { sort: 'profit_high', cursor }]) {
      const response = await list(query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(response.error.code).toBe('invalid_request');
    }
  });
});
