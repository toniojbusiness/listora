import { describe, expect, it } from 'vitest';

import { feeTableFor, FEE_TABLES } from './fee-tables.ts';
import { estimateFeesCents, type EstimatedFeeKind, type FeeTable } from './fees.ts';
import {
  calibrateFees,
  computeFloor,
  feeEstimator,
  MAX_FEE_CALIBRATION_RATIO,
  MIN_FEE_CALIBRATION_RATIO,
  MIN_SALES_FOR_FEE_CALIBRATION,
  type ObservedSale,
} from './floor.ts';

const ON = new Date('2026-10-24T12:00:00Z');
const poshmark = feeTableFor('poshmark', ON);
const mercari = feeTableFor('mercari', ON);

const floorOf = (costCents: number, shippingCents = 0, minimumProfitCents = 0) =>
  computeFloor({ costCents, shippingCents, minimumProfitCents }, feeEstimator(poshmark, undefined));

describe('computeFloor', () => {
  it('adds cost, the fees at the floor, shipping, and minimum profit exactly', () => {
    // $10 cost on Poshmark: under $15 the fee is $2.95.
    expect(floorOf(1000)).toEqual({ floorPriceCents: 1295, estimatedFeesCents: 295 });
    expect(floorOf(800, 150, 250)).toEqual({ floorPriceCents: 1495, estimatedFeesCents: 295 });
  });

  it('finds the least price across a fee threshold', () => {
    // $12.10 needed: $14.99 keeps only $12.04, and from $15 the fee is 20%.
    const floor = floorOf(1210);
    expect(floor).toEqual({ floorPriceCents: 1513, estimatedFeesCents: 303 });
    expect(1513 - estimateFeesCents(poshmark, 1513)).toBe(1210);
    for (let price = 0; price < 1513; price += 1) {
      expect(price - estimateFeesCents(poshmark, price)).toBeLessThan(1210);
    }
  });

  it('is the least price that keeps cost + shipping + minimum profit, for every table', () => {
    for (const table of FEE_TABLES) {
      const fees = feeEstimator(table, undefined);
      for (let required = 0; required <= 3_000; required += 37) {
        const floor = computeFloor(
          { costCents: required, shippingCents: 0, minimumProfitCents: 0 },
          fees,
        );
        const at = `${table.version} for ${String(required)}`;
        expect(floor.floorPriceCents, at).toBe(required + floor.estimatedFeesCents);
        expect(floor.estimatedFeesCents, at).toBe(fees(floor.floorPriceCents));
        for (let price = required; price < floor.floorPriceCents; price += 1) {
          expect(price - fees(price), `${at} at ${String(price)}`).toBeLessThan(required);
        }
      }
    }
  });

  it('handles large prices exactly', () => {
    const ebay = feeTableFor('ebay', ON);
    const floor = computeFloor(
      { costCents: 5_000_000, shippingCents: 0, minimumProfitCents: 0 },
      feeEstimator(ebay, undefined),
    );
    expect(floor.floorPriceCents).toBe(5_000_000 + floor.estimatedFeesCents);
    expect(floor.estimatedFeesCents).toBe(estimateFeesCents(ebay, floor.floorPriceCents));
  });

  it('rejects inputs that are not whole non-negative cents', () => {
    const fees = feeEstimator(mercari, undefined);
    const base = { costCents: 100, shippingCents: 0, minimumProfitCents: 0 };
    expect(() => computeFloor({ ...base, costCents: -1 }, fees)).toThrow(/costCents/);
    expect(() => computeFloor({ ...base, shippingCents: 1.5 }, fees)).toThrow(/shippingCents/);
    expect(() => computeFloor({ ...base, minimumProfitCents: Number.NaN }, fees)).toThrow(
      /minimumProfitCents/,
    );
  });

  it('fails loudly on a broken fee schedule instead of returning a wrong floor', () => {
    const base = { costCents: 1000, shippingCents: 0, minimumProfitCents: 0 };
    // Fees that fall as the price rises.
    expect(() => computeFloor(base, (price) => Math.max(0, 5000 - price))).toThrow(/decreases/);
    // Fees that grow as fast as the price never leave a payout.
    expect(() => computeFloor(base, (price) => price)).toThrow(/did not converge/);
  });
});

describe('calibrateFees', () => {
  const SOLD = new Date('2026-10-01T12:00:00Z');
  const sale = (
    salePriceCents: number,
    amountCents: number,
    options: { kind?: EstimatedFeeKind; soldAt?: Date } = {},
  ): ObservedSale => ({
    soldAt: options.soldAt ?? SOLD,
    salePriceCents,
    fees: [{ kind: options.kind ?? 'marketplace', amountCents }],
  });

  it(`needs at least ${String(MIN_SALES_FOR_FEE_CALIBRATION)} sales`, () => {
    expect(calibrateFees('mercari', [sale(2000, 200), sale(3000, 300)])).toBeUndefined();
  });

  it('compares actual fees with the estimate for the same prices', () => {
    const calibration = calibrateFees('mercari', [
      sale(2000, 300),
      sale(3000, 450),
      sale(5000, 750),
    ]);
    expect(calibration).toEqual({ sales: 3, actualFeesCents: 1500, estimatedFeesCents: 1000 });
  });

  it('adds up every fee line of a sale', () => {
    const split = (price: number): ObservedSale => ({
      soldAt: SOLD,
      salePriceCents: price,
      fees: [
        { kind: 'marketplace', amountCents: price / 10 },
        { kind: 'payment', amountCents: price / 20 },
      ],
    });
    expect(calibrateFees('mercari', [split(2000), split(3000), split(5000)])).toEqual({
      sales: 3,
      actualFeesCents: 1500,
      estimatedFeesCents: 1000,
    });
  });

  it('scales the table estimate by the ratio, rounding up', () => {
    const calibration = calibrateFees('mercari', [
      sale(2000, 300),
      sale(3000, 450),
      sale(5000, 750),
    ]);
    const fees = feeEstimator(mercari, calibration);
    expect(fees(1000)).toBe(150);
    expect(fees(1010)).toBe(152); // 101 * 1.5 = 151.5
    // Poshmark's flat fee keeps its shape when scaled.
    const posh = calibrateFees('poshmark', [sale(1000, 590), sale(1200, 590), sale(1400, 590)]);
    expect(feeEstimator(poshmark, posh)(500)).toBe(590);
  });

  it('compares each sale with the table in effect on its day, so a fee rise is not masked', () => {
    // Mercari moves from 10% to 12% on 2026-11-01.
    const raised: FeeTable = {
      ...mercari,
      version: 'mercari-us-2026-11-01',
      effectiveFrom: '2026-11-01',
      rules: [
        {
          name: 'Selling fee',
          kind: 'marketplace',
          bands: [{ fromCents: 0, fixedCents: 0, basisPoints: 1200 }],
        },
      ],
    };
    const tables = [...FEE_TABLES, raised];
    const after = new Date('2026-11-15T12:00:00Z');
    const sales = [
      sale(2000, 240, { soldAt: after }),
      sale(3000, 300),
      sale(4000, 400),
      sale(5000, 500, { soldAt: new Date('2024-06-01T12:00:00Z') }), // before every table
    ];
    // Every sale was charged exactly its own day's rate: no adjustment.
    expect(calibrateFees('mercari', sales, tables)).toEqual({
      sales: 4,
      actualFeesCents: 1440,
      estimatedFeesCents: 1440,
    });
  });

  it('uses only sales whose fee data is complete', () => {
    const good = [sale(2000, 300), sale(3000, 450), sale(5000, 750)];
    expect(calibrateFees('mercari', good)?.sales).toBe(3);
    // A refunded fee line leaves the sale out.
    const refunded: ObservedSale = {
      ...sale(4000, 600),
      fees: [
        { kind: 'marketplace', amountCents: 600 },
        { kind: 'marketplace', amountCents: -600 },
      ],
    };
    expect(calibrateFees('mercari', [...good.slice(1), refunded])).toBeUndefined();
    // So does a zero-amount placeholder line.
    const placeholder: ObservedSale = {
      ...sale(4000, 600),
      fees: [
        { kind: 'marketplace', amountCents: 600 },
        { kind: 'payment', amountCents: 0 },
      ],
    };
    expect(calibrateFees('mercari', [...good.slice(1), placeholder])).toBeUndefined();
    // And a sale missing a fee kind the table charges: Depop's is the payment fee.
    const depop = [2000, 3000, 5000].map((price) => sale(price, price / 10, { kind: 'payment' }));
    expect(calibrateFees('depop', depop)?.sales).toBe(3);
    const missingKind = depop.map((entry) => ({
      ...entry,
      fees: [{ kind: 'marketplace' as const, amountCents: entry.salePriceCents / 10 }],
    }));
    expect(calibrateFees('depop', missingKind)).toBeUndefined();
  });

  it('ignores implausibly high and implausibly low ratios', () => {
    const tooHigh = (MAX_FEE_CALIBRATION_RATIO + 1) * 100;
    expect(
      calibrateFees('mercari', [sale(1000, tooHigh), sale(1000, tooHigh), sale(1000, tooHigh)]),
    ).toBeUndefined();
    // $3.00 of fees on $30.00 sales estimated at $3.00: 1/3 is the lowest ratio used.
    const lowest = Math.round(300 * MIN_FEE_CALIBRATION_RATIO);
    expect(
      calibrateFees('mercari', [sale(3000, lowest), sale(3000, lowest), sale(3000, lowest)]),
    ).toEqual({ sales: 3, actualFeesCents: 300, estimatedFeesCents: 900 });
    expect(
      calibrateFees('mercari', [sale(3000, 99), sale(3000, 99), sale(3000, 99)]),
    ).toBeUndefined();
  });

  it('ignores sales the table estimates no fees for', () => {
    expect(calibrateFees('mercari', [sale(0, 10), sale(0, 10), sale(0, 10)])).toBeUndefined();
  });
});
