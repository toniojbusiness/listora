import { describe, expect, it } from 'vitest';

import { saleMoney } from './money.ts';
import type { ProfitFeeRow, ProfitItemRow } from './profit.ts';
import { yearDays, yearReport } from './reports.ts';

function item(overrides: Partial<ProfitItemRow> & { saleId: string }): ProfitItemRow {
  return {
    marketplace: 'ebay',
    soldOn: '2026-03-10',
    shippingChargedCents: 0,
    shippingCostCents: null,
    saleItemId: `${overrides.saleId}-1`,
    salePriceCents: 0,
    costCents: 0,
    brand: null,
    category: null,
    daysToSell: 0,
    ...overrides,
  };
}

function fee(overrides: Partial<ProfitFeeRow> & { saleId: string }): ProfitFeeRow {
  return { saleItemId: null, shippingLabel: false, amountCents: 0, estimated: false, ...overrides };
}

describe('the year report', () => {
  it('has every month of the year, empty ones included', () => {
    const report = yearReport({ year: 2026, items: [], fees: [] });
    expect(report.months.map((month) => month.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(report.months[0]).toEqual({
      month: '2026-01',
      salesCount: 0,
      itemsSold: 0,
      revenueCents: 0,
      shippingCents: 0,
      feesCents: 0,
      feesUnknownCount: 0,
      costOfGoodsCents: 0,
      missingCostCount: 0,
      netProfitCents: 0,
    });
    expect(report.marketplaces).toEqual([]);
    expect(yearDays(2026)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('adds each month and marketplace up to the year, with the lines adding up', () => {
    const report = yearReport({
      year: 2026,
      items: [
        item({
          saleId: 'a',
          marketplace: 'poshmark',
          soldOn: '2026-01-31',
          salePriceCents: 4500,
          shippingChargedCents: 599,
          shippingCostCents: 450,
          costCents: 1200,
        }),
        item({ saleId: 'b', marketplace: 'ebay', soldOn: '2026-02-01', salePriceCents: 2000 }),
        item({ saleId: 'c', marketplace: 'poshmark', soldOn: '2026-02-14', salePriceCents: 1000 }),
      ],
      fees: [
        fee({ saleId: 'a', amountCents: 612 }),
        fee({ saleId: 'a', amountCents: 830, shippingLabel: true }),
        fee({ saleId: 'b', amountCents: 260 }),
        fee({ saleId: 'c', amountCents: 200 }),
      ],
    });
    expect(report.total).toEqual({
      salesCount: 3,
      itemsSold: 3,
      revenueCents: 8099,
      shippingCents: 1280,
      feesCents: 1072,
      feesUnknownCount: 0,
      costOfGoodsCents: 1200,
      missingCostCount: 0,
      // 8099 - 1072 - 1280 - 1200.
      netProfitCents: 4547,
    });
    expect(report.months[0]).toMatchObject({
      itemsSold: 1,
      netProfitCents: 5099 - 612 - 1280 - 1200,
    });
    expect(report.months[1]).toMatchObject({ itemsSold: 2, netProfitCents: 3000 - 460 });
    // The fixed order, eBay first, and only marketplaces with a sale.
    expect(report.marketplaces.map((row) => [row.marketplace, row.revenueCents])).toEqual([
      ['ebay', 2000],
      ['poshmark', 6099],
    ]);
  });

  it('hides fees and profit while a sale has estimated fees or none, and says how many', () => {
    const report = yearReport({
      year: 2026,
      items: [
        item({ saleId: 'actual', soldOn: '2026-04-01', salePriceCents: 1000 }),
        item({ saleId: 'estimated', soldOn: '2026-05-01', salePriceCents: 1000 }),
        item({ saleId: 'none', soldOn: '2026-05-02', salePriceCents: 1000 }),
      ],
      fees: [
        fee({ saleId: 'actual', amountCents: 130 }),
        fee({ saleId: 'estimated', amountCents: 130, estimated: true }),
      ],
    });
    expect(report.total).toMatchObject({
      revenueCents: 3000,
      feesCents: null,
      feesUnknownCount: 2,
      netProfitCents: null,
    });
    // A month with only the marketplace's fees still has its own.
    expect(report.months[3]).toMatchObject({ feesCents: 130, netProfitCents: 870 });
    expect(report.months[4]).toMatchObject({ feesCents: null, feesUnknownCount: 2 });
  });

  it('hides cost of goods and profit while an item has no cost, and says how many', () => {
    const report = yearReport({
      year: 2026,
      items: [
        item({ saleId: 'a', salePriceCents: 1000, costCents: 300 }),
        item({ saleId: 'b', salePriceCents: 1000, costCents: null }),
      ],
      fees: [fee({ saleId: 'a', amountCents: 10 }), fee({ saleId: 'b', amountCents: 10 })],
    });
    expect(report.total).toMatchObject({
      feesCents: 20,
      costOfGoodsCents: null,
      missingCostCount: 1,
      netProfitCents: null,
    });
  });

  it("splits a bundle's order amounts by price, so its items equal the sale's own money", () => {
    const lines = [
      { saleItemId: 'x-1', priceCents: 1001 },
      { saleItemId: 'x-2', priceCents: 2002 },
    ];
    const report = yearReport({
      year: 2026,
      items: lines.map((line, index) =>
        item({
          saleId: 'x',
          saleItemId: line.saleItemId,
          salePriceCents: line.priceCents,
          shippingChargedCents: 701,
          shippingCostCents: 333,
          costCents: 167 - index,
        }),
      ),
      fees: [fee({ saleId: 'x', amountCents: 409 })],
    });
    const money = saleMoney({
      shippingChargedCents: 701,
      shippingCostCents: 333,
      items: lines.map((line, index) => ({
        saleItemId: line.saleItemId,
        itemId: `item-${String(index)}`,
        salePriceCents: line.priceCents,
        costCents: 167 - index,
      })),
      fees: [{ saleItemId: null, amountCents: 409, source: 'actual' }],
    });
    expect(report.total.netProfitCents).toBe(money.profitCents);
    expect(report.total.netProfitCents).not.toBeNull();
  });
});
