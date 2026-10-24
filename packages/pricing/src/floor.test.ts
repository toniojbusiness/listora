import { describe, expect, it } from 'vitest';

import { feeTableFor, FEE_TABLES } from './fee-tables.ts';
import { estimateFeesCents } from './fees.ts';
import {
  calibrateFees,
  computeFloor,
  feeEstimator,
  MAX_FEE_CALIBRATION_RATIO,
  MIN_SALES_FOR_FEE_CALIBRATION,
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
  const sale = (salePriceCents: number, actualFeesCents: number) => ({
    salePriceCents,
    actualFeesCents,
  });

  it(`needs at least ${String(MIN_SALES_FOR_FEE_CALIBRATION)} sales`, () => {
    expect(calibrateFees(mercari, [sale(2000, 200), sale(3000, 300)])).toBeUndefined();
  });

  it('compares actual fees with the estimate for the same prices', () => {
    const calibration = calibrateFees(mercari, [sale(2000, 300), sale(3000, 450), sale(5000, 750)]);
    expect(calibration).toEqual({ sales: 3, actualFeesCents: 1500, estimatedFeesCents: 1000 });
  });

  it('scales the table estimate by the ratio, rounding up', () => {
    const calibration = calibrateFees(mercari, [sale(2000, 300), sale(3000, 450), sale(5000, 750)]);
    const fees = feeEstimator(mercari, calibration);
    expect(fees(1000)).toBe(150);
    expect(fees(1010)).toBe(152); // 101 * 1.5 = 151.5
    // Poshmark's flat fee keeps its shape when scaled.
    const posh = calibrateFees(poshmark, [sale(1000, 590), sale(1200, 590), sale(1400, 590)]);
    expect(feeEstimator(poshmark, posh)(500)).toBe(590);
  });

  it('skips refunded sales and ignores implausible ratios', () => {
    expect(
      calibrateFees(mercari, [sale(2000, 200), sale(3000, 300), sale(5000, -500)]),
    ).toBeUndefined();
    const tooHigh = (MAX_FEE_CALIBRATION_RATIO + 1) * 100;
    expect(
      calibrateFees(mercari, [sale(1000, tooHigh), sale(1000, tooHigh), sale(1000, tooHigh)]),
    ).toBeUndefined();
  });

  it('ignores sales the table estimates no fees for', () => {
    expect(calibrateFees(mercari, [sale(0, 10), sale(0, 10), sale(0, 10)])).toBeUndefined();
  });
});
