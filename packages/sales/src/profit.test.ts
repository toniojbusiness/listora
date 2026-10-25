import { describe, expect, it } from 'vitest';

import { saleMoney } from './money.ts';
import {
  bucketStart,
  bucketStarts,
  periodDays,
  profitGranularity,
  profitReport,
  type ProfitFeeRow,
  type ProfitItemRow,
} from './profit.ts';

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

function item(overrides: Partial<ProfitItemRow> & { saleId: string }): ProfitItemRow {
  return {
    marketplace: 'ebay',
    soldOn: '2026-10-10',
    shippingChargedCents: 0,
    shippingCostCents: null,
    saleItemId: `${overrides.saleId}-1`,
    salePriceCents: 0,
    costCents: null,
    brand: null,
    category: null,
    daysToSell: 0,
    ...overrides,
  };
}

function fee(overrides: Partial<ProfitFeeRow> & { saleId: string }): ProfitFeeRow {
  return {
    saleItemId: null,
    shippingLabel: false,
    amountCents: 0,
    estimated: false,
    ...overrides,
  };
}

describe('the profit summary', () => {
  it('adds up revenue, fees, shipping, and cost of goods to the net profit', () => {
    const report = profitReport({
      period: OCTOBER,
      items: [
        item({
          saleId: 'a',
          salePriceCents: 4500,
          shippingChargedCents: 599,
          shippingCostCents: 450,
          costCents: 1200,
          daysToSell: 10,
        }),
        item({ saleId: 'b', salePriceCents: 2000, costCents: 500, daysToSell: 3 }),
      ],
      fees: [
        fee({ saleId: 'a', amountCents: 612 }),
        fee({ saleId: 'a', amountCents: 830, shippingLabel: true }),
        fee({ saleId: 'b', amountCents: 260 }),
      ],
      listedItems: 6,
    });
    // Revenue 4500 + 599 + 2000 = 7099; fees 612 + 260 = 872; shipping 830 + 450 = 1280;
    // cost 1700; profit 7099 - 872 - 1280 - 1700 = 3247; ROI 3247 / 1700 = 191.0%.
    expect(report.summary).toEqual({
      revenueCents: 7099,
      feesCents: 872,
      shippingCents: 1280,
      costOfGoodsCents: 1700,
      netProfitCents: 3247,
      salesCount: 2,
      itemsSold: 2,
      roiBasisPoints: 19100,
      missingCostCount: 0,
      averageSalePriceCents: 3250,
      averageProfitPerItemCents: 1624,
      averageDaysToSell: 7,
      // 2 sold of 2 + 6 listed.
      sellThroughBasisPoints: 2500,
      feesEstimated: false,
    });
  });

  it('agrees with each sale’s own money to the cent, bundles included', () => {
    const items = [
      item({
        saleId: 'bundle',
        saleItemId: 'b1',
        salePriceCents: 1000,
        shippingChargedCents: 701,
        shippingCostCents: 333,
        costCents: 100,
      }),
      item({ saleId: 'bundle', saleItemId: 'b2', salePriceCents: 2000, costCents: 300 }),
      item({ saleId: 'bundle', saleItemId: 'b3', salePriceCents: 3001, costCents: 0 }),
    ].map((row) => ({ ...row, shippingChargedCents: 701, shippingCostCents: 333 }));
    const fees = [
      fee({ saleId: 'bundle', amountCents: 799 }),
      fee({ saleId: 'bundle', amountCents: 411, shippingLabel: true }),
      fee({ saleId: 'bundle', saleItemId: 'b2', amountCents: 55 }),
      fee({ saleId: 'bundle', saleItemId: 'b3', amountCents: 17, shippingLabel: true }),
    ];
    const report = profitReport({ period: OCTOBER, items, fees, listedItems: 0 });

    const money = saleMoney({
      shippingChargedCents: 701,
      shippingCostCents: 333,
      items: items.map((row) => ({
        saleItemId: row.saleItemId,
        itemId: row.saleItemId,
        salePriceCents: row.salePriceCents,
        costCents: row.costCents,
      })),
      fees: fees.map((line) => ({
        saleItemId: line.saleItemId,
        amountCents: line.amountCents,
        source: 'actual' as const,
      })),
    });
    expect(report.summary.netProfitCents).toBe(money.profitCents);
    expect(report.summary.revenueCents).toBe(money.salePriceCents + money.shippingChargedCents);
    expect(report.summary.feesCents + report.summary.shippingCents).toBe(
      money.feesCents + money.shippingCostCents,
    );
    // Each item's profit (here, its brand's) is its share on the sale screen.
    const byBrand = profitReport({
      period: OCTOBER,
      items: items.map((row) => ({ ...row, brand: row.saleItemId })),
      fees,
      listedItems: 0,
    });
    for (const group of [...byBrand.brands.best, ...byBrand.brands.worst]) {
      expect(group.netProfitCents).toBe(money.items.get(group.key)?.profitCents);
    }
  });

  it('counts an item without a cost as zero cost and says how many there are', () => {
    const report = profitReport({
      period: OCTOBER,
      items: [
        item({ saleId: 'a', salePriceCents: 3000, costCents: null }),
        item({ saleId: 'b', salePriceCents: 1000, costCents: 400 }),
      ],
      fees: [],
      listedItems: 0,
    });
    expect(report.summary).toMatchObject({
      costOfGoodsCents: 400,
      netProfitCents: 3600,
      missingCostCount: 1,
      roiBasisPoints: 90000,
    });
  });

  it('has no ROI for a zero cost of goods and no averages when nothing sold', () => {
    const free = profitReport({
      period: OCTOBER,
      items: [item({ saleId: 'a', salePriceCents: 1500, costCents: 0 })],
      fees: [],
      listedItems: 0,
    });
    expect(free.summary.roiBasisPoints).toBeNull();
    expect(free.summary.sellThroughBasisPoints).toBe(10_000);

    const empty = profitReport({ period: OCTOBER, items: [], fees: [], listedItems: 0 });
    expect(empty.summary).toEqual({
      revenueCents: 0,
      feesCents: 0,
      shippingCents: 0,
      costOfGoodsCents: 0,
      netProfitCents: 0,
      salesCount: 0,
      itemsSold: 0,
      roiBasisPoints: null,
      missingCostCount: 0,
      averageSalePriceCents: null,
      averageProfitPerItemCents: null,
      averageDaysToSell: null,
      sellThroughBasisPoints: null,
      feesEstimated: false,
    });
    expect(empty.series).toHaveLength(31);
    expect(empty.series.every((bucket) => bucket.itemsSold === 0)).toBe(true);
    expect(empty.marketplaces).toEqual([]);
    expect(empty.brands).toEqual({ best: [], worst: [] });
  });

  it('reports a loss as a negative profit and ROI', () => {
    const report = profitReport({
      period: OCTOBER,
      items: [item({ saleId: 'a', salePriceCents: 1000, costCents: 1500 })],
      fees: [fee({ saleId: 'a', amountCents: 133 })],
      listedItems: 0,
    });
    expect(report.summary.netProfitCents).toBe(-633);
    expect(report.summary.roiBasisPoints).toBe(-4220);
    expect(report.summary.averageProfitPerItemCents).toBe(-633);
  });

  it('marks the numbers as estimates while any fee line is', () => {
    const report = profitReport({
      period: OCTOBER,
      items: [item({ saleId: 'a', salePriceCents: 1000 })],
      fees: [fee({ saleId: 'a', amountCents: 133, estimated: true })],
      listedItems: 0,
    });
    expect(report.summary.feesEstimated).toBe(true);
  });
});

describe('the series', () => {
  it('chooses days up to a month, weeks up to half a year, then months', () => {
    expect(profitGranularity({ from: '2026-10-01', to: '2026-10-31' })).toBe('day');
    expect(profitGranularity({ from: '2026-10-01', to: '2026-11-01' })).toBe('week');
    expect(profitGranularity({ from: '2026-01-01', to: '2026-07-03' })).toBe('week');
    expect(profitGranularity({ from: '2026-01-01', to: '2026-07-04' })).toBe('month');
    expect(periodDays({ from: '2026-01-01', to: '2026-12-31' })).toBe(365);
    expect(periodDays({ from: '2026-10-25', to: '2026-10-25' })).toBe(1);
  });

  it('starts weeks on Monday, and the first bucket on the period’s first day', () => {
    // 2026-10-01 is a Thursday.
    expect(bucketStarts({ from: '2026-10-01', to: '2026-10-20' }, 'week')).toEqual([
      '2026-10-01',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(bucketStart('2026-10-03', 'week', '2026-10-01')).toBe('2026-10-01');
    expect(bucketStart('2026-10-11', 'week', '2026-10-01')).toBe('2026-10-05');
    expect(bucketStart('2026-10-12', 'week', '2026-10-01')).toBe('2026-10-12');
  });

  it('buckets months across a year end', () => {
    expect(bucketStarts({ from: '2025-11-15', to: '2026-02-01' }, 'month')).toEqual([
      '2025-11-15',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
    expect(bucketStart('2026-01-31', 'month', '2025-11-15')).toBe('2026-01-01');
  });

  it('puts each sold item in its day and keeps empty days', () => {
    const report = profitReport({
      period: { from: '2026-10-01', to: '2026-10-03' },
      items: [
        item({ saleId: 'a', soldOn: '2026-10-01', salePriceCents: 1000, costCents: 200 }),
        item({ saleId: 'b', soldOn: '2026-10-03', salePriceCents: 500, costCents: 100 }),
        item({ saleId: 'c', soldOn: '2026-10-03', salePriceCents: 700, costCents: 100 }),
      ],
      fees: [],
      listedItems: 0,
    });
    expect(report.granularity).toBe('day');
    expect(report.series).toEqual([
      { start: '2026-10-01', revenueCents: 1000, netProfitCents: 800, itemsSold: 1 },
      { start: '2026-10-02', revenueCents: 0, netProfitCents: 0, itemsSold: 0 },
      { start: '2026-10-03', revenueCents: 1200, netProfitCents: 1000, itemsSold: 2 },
    ]);
  });
});

describe('the breakdowns', () => {
  it('lists the seller’s own marketplaces in the fixed order, whatever their results', () => {
    const report = profitReport({
      period: OCTOBER,
      items: [
        item({ saleId: 'm', marketplace: 'mercari', salePriceCents: 9000, costCents: 100 }),
        item({ saleId: 'e', marketplace: 'ebay', salePriceCents: 100, costCents: 100 }),
        item({ saleId: 'd', marketplace: 'depop', salePriceCents: 5000, costCents: 100 }),
      ],
      fees: [],
      listedItems: 0,
    });
    expect(report.marketplaces.map((row) => row.marketplace)).toEqual(['ebay', 'depop', 'mercari']);
    expect(report.marketplaces[0]).toEqual({
      marketplace: 'ebay',
      revenueCents: 100,
      feesCents: 0,
      shippingCents: 0,
      costOfGoodsCents: 100,
      netProfitCents: 0,
      salesCount: 1,
      itemsSold: 1,
    });
  });

  it('ranks the best five and the worst five of the rest by net profit, never both', () => {
    const brands = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const report = profitReport({
      period: OCTOBER,
      items: brands.map((brand, index) =>
        item({
          saleId: brand,
          brand,
          salePriceCents: 1000 * (index + 1),
          costCents: 500,
          daysToSell: index,
        }),
      ),
      fees: [],
      listedItems: 0,
    });
    expect(report.brands.best.map((group) => group.key)).toEqual(['G', 'F', 'E', 'D', 'C']);
    expect(report.brands.worst.map((group) => group.key)).toEqual(['A', 'B']);
    expect(report.brands.best[0]).toEqual({
      key: 'G',
      itemsSold: 1,
      revenueCents: 7000,
      netProfitCents: 6500,
      roiBasisPoints: 130000,
      averageDaysToSell: 6,
    });
  });

  it('groups brands ignoring case and spaces, and leaves out items without one', () => {
    const report = profitReport({
      period: OCTOBER,
      items: [
        item({ saleId: 'a', brand: "Levi's", salePriceCents: 1000, costCents: 0 }),
        item({ saleId: 'b', brand: " levi's ", salePriceCents: 2000, costCents: 0 }),
        item({ saleId: 'c', brand: null, salePriceCents: 9000, costCents: 0 }),
        item({ saleId: 'd', brand: '  ', salePriceCents: 9000, costCents: 0 }),
        item({ saleId: 'e', category: 'shoes/boots', salePriceCents: 100, costCents: 0 }),
      ],
      fees: [],
      listedItems: 0,
    });
    expect(report.brands.best).toEqual([
      {
        key: "Levi's",
        itemsSold: 2,
        revenueCents: 3000,
        netProfitCents: 3000,
        roiBasisPoints: null,
        averageDaysToSell: 0,
      },
    ]);
    expect(report.brands.worst).toEqual([]);
    expect(report.categories.best.map((group) => group.key)).toEqual(['shoes/boots']);
  });
});
