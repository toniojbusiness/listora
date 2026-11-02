import { describe, expect, it } from 'vitest';

import { friendlyPrice, scanPrices } from './prices.ts';

describe('friendlyPrice', () => {
  it('rounds to whole dollars under $20, $5 steps under $100, then $10 steps', () => {
    expect(friendlyPrice(1_249, 'nearest')).toBe(1_200);
    expect(friendlyPrice(1_250, 'down')).toBe(1_200);
    expect(friendlyPrice(1_201, 'up')).toBe(1_300);
    expect(friendlyPrice(4_740, 'nearest')).toBe(4_500);
    expect(friendlyPrice(4_760, 'nearest')).toBe(5_000);
    expect(friendlyPrice(4_900, 'down')).toBe(4_500);
    expect(friendlyPrice(4_100, 'up')).toBe(4_500);
    expect(friendlyPrice(12_340, 'nearest')).toBe(12_000);
    expect(friendlyPrice(12_340, 'up')).toBe(13_000);
  });

  it('leaves a price already on its step as it is', () => {
    expect(friendlyPrice(3_500, 'down')).toBe(3_500);
    expect(friendlyPrice(3_500, 'up')).toBe(3_500);
    expect(friendlyPrice(800, 'up')).toBe(800);
  });

  it('never goes under $1', () => {
    expect(friendlyPrice(1, 'down')).toBe(100);
    expect(friendlyPrice(0, 'nearest')).toBe(100);
  });
});

describe('scanPrices', () => {
  it('lists at the realistic sale over the ratio, the fast sale the low end', () => {
    expect(
      scanPrices({ lowCents: 3_000, highCents: 5_500 }, 4_500, { saleToAsking: 0.65, sales: 30 }),
    ).toEqual({
      listAtCents: 7_000,
      realisticCents: 4_500,
      fastCents: 3_000,
    });
  });

  it('takes the 75% default without a calibration', () => {
    expect(scanPrices({ lowCents: 900, highCents: 1_500 }, 1_200, undefined)).toEqual({
      listAtCents: 1_600,
      realisticCents: 1_200,
      fastCents: 900,
    });
  });

  it("never lists under the range's high end", () => {
    // $20 over 75% is $26.67, a $30 list price; the range reaches $42, so it lists at $45.
    expect(scanPrices({ lowCents: 1_500, highCents: 4_200 }, 2_000, undefined)).toEqual({
      listAtCents: 4_500,
      realisticCents: 2_000,
      fastCents: 1_500,
    });
  });

  it('holds the realistic sale inside the range, and the three in order', () => {
    const prices = scanPrices({ lowCents: 1_950, highCents: 2_050 }, 5_000, {
      saleToAsking: 1,
      sales: 9,
    });
    expect(prices.realisticCents).toBe(2_000);
    expect(prices.fastCents).toBeLessThanOrEqual(prices.realisticCents);
    expect(prices.listAtCents).toBeGreaterThanOrEqual(prices.realisticCents);
  });
});
