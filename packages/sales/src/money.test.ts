import { describe, expect, it } from 'vitest';

import { saleMoney, splitByWeight } from './money.ts';

describe('a sale’s money', () => {
  it('pays out the price plus shipping minus fees, and profits that minus cost', () => {
    const money = saleMoney({
      shippingChargedCents: 599,
      shippingCostCents: 450,
      items: [{ saleItemId: 's1', itemId: 'i1', salePriceCents: 4500, costCents: 1200 }],
      fees: [
        { saleItemId: null, amountCents: 612, source: 'actual' },
        { saleItemId: null, amountCents: 40, source: 'actual' },
      ],
    });
    // 4500 + 599 - 652 = 4447; 4447 - 450 - 1200 = 2797; 2797 / 1200 = 233.08%.
    expect(money).toMatchObject({
      salePriceCents: 4500,
      feesCents: 652,
      netProceedsCents: 4447,
      profitCents: 2797,
      roiBasisPoints: 23308,
      feesEstimated: false,
    });
    expect(money.items.get('i1')).toEqual({
      salePriceCents: 4500,
      shippingChargedCents: 599,
      feesCents: 652,
      shippingCostCents: 450,
      costCents: 1200,
      netProceedsCents: 4447,
      profitCents: 2797,
      roiBasisPoints: 23308,
    });
  });

  it('marks the payout and profit as estimates while any fee is estimated', () => {
    const money = saleMoney({
      shippingChargedCents: 0,
      shippingCostCents: null,
      items: [{ saleItemId: 's1', itemId: 'i1', salePriceCents: 2000, costCents: 500 }],
      fees: [
        { saleItemId: null, amountCents: 200, source: 'estimated' },
        { saleItemId: null, amountCents: 50, source: 'actual' },
      ],
    });
    expect(money).toMatchObject({ netProceedsCents: 1750, profitCents: 1250, feesEstimated: true });
  });

  it('knows no payout before fees, and no profit or ROI without a cost', () => {
    const noFees = saleMoney({
      shippingChargedCents: 500,
      shippingCostCents: null,
      items: [{ saleItemId: 's1', itemId: 'i1', salePriceCents: 2000, costCents: 500 }],
      fees: [],
    });
    expect(noFees).toMatchObject({
      netProceedsCents: null,
      profitCents: null,
      roiBasisPoints: null,
    });

    const noCost = saleMoney({
      shippingChargedCents: 0,
      shippingCostCents: null,
      items: [{ saleItemId: 's1', itemId: 'i1', salePriceCents: 2000, costCents: null }],
      fees: [{ saleItemId: null, amountCents: 200, source: 'actual' }],
    });
    expect(noCost).toMatchObject({ netProceedsCents: 1800, profitCents: null, costCents: null });

    const freeItem = saleMoney({
      shippingChargedCents: 0,
      shippingCostCents: null,
      items: [{ saleItemId: 's1', itemId: 'i1', salePriceCents: 2000, costCents: 0 }],
      fees: [{ saleItemId: null, amountCents: 200, source: 'actual' }],
    });
    expect(freeItem).toMatchObject({ profitCents: 1800, roiBasisPoints: null });
  });

  it('reports a loss as a negative profit and ROI', () => {
    const money = saleMoney({
      shippingChargedCents: 0,
      shippingCostCents: 800,
      items: [{ saleItemId: 's1', itemId: 'i1', salePriceCents: 1000, costCents: 1500 }],
      fees: [{ saleItemId: null, amountCents: 100, source: 'actual' }],
    });
    expect(money).toMatchObject({ profitCents: -1400, roiBasisPoints: -9333 });
  });

  it('splits a bundle’s order-level amounts by price, keeps item fees per item, and adds up', () => {
    const money = saleMoney({
      shippingChargedCents: 1000,
      shippingCostCents: 700,
      items: [
        { saleItemId: 's1', itemId: 'i1', salePriceCents: 2000, costCents: 400 },
        { saleItemId: 's2', itemId: 'i2', salePriceCents: 1000, costCents: 300 },
      ],
      fees: [
        { saleItemId: null, amountCents: 301, source: 'actual' },
        { saleItemId: 's2', amountCents: 50, source: 'actual' },
      ],
    });
    const first = money.items.get('i1');
    const second = money.items.get('i2');
    // Shipping 1000 → 667 / 333; the order fee 301 → 201 / 100; the label 700 → 467 / 233.
    expect(first).toMatchObject({
      shippingChargedCents: 667,
      feesCents: 201,
      shippingCostCents: 467,
    });
    expect(second).toMatchObject({
      shippingChargedCents: 333,
      feesCents: 150,
      shippingCostCents: 233,
    });
    expect((first?.profitCents ?? 0) + (second?.profitCents ?? 0)).toBe(money.profitCents);
    expect(money).toMatchObject({
      salePriceCents: 3000,
      feesCents: 351,
      netProceedsCents: 3649,
      costCents: 700,
      profitCents: 2249,
    });
  });
});

describe('splitting an amount by weight', () => {
  it('adds up exactly, giving leftover cents to the largest remainders first', () => {
    expect(splitByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitByWeight(10, [3, 7])).toEqual([3, 7]);
    expect(splitByWeight(-5, [1, 1])).toEqual([-3, -2]);
    expect(splitByWeight(7, [0, 0])).toEqual([4, 3]);
    expect(splitByWeight(0, [5, 5])).toEqual([0, 0]);
    expect(splitByWeight(9, [])).toEqual([]);
  });
});
