import { describe, expect, it } from 'vitest';

import {
  calibratedAiEstimate,
  calibratedWebAsks,
  DEFAULT_PRICE_CALIBRATION_SETTINGS,
  priceCalibration,
} from './calibration.ts';
import type { HistorySale } from './own-history.ts';

function sale(id: string, salePriceCents: number, askingPriceCents: number | null): HistorySale {
  return {
    id,
    brand: 'Fernhill',
    category: 'clothing/bottoms/jeans',
    salePriceCents,
    askingPriceCents,
  };
}

describe('priceCalibration', () => {
  it('is the default with no sales that have an asking price', () => {
    expect(priceCalibration([])).toEqual({ saleToAsking: 0.75, sales: 0 });
    expect(priceCalibration([sale('a', 1_000, null), sale('b', 1_000, 0)])).toEqual({
      saleToAsking: 0.75,
      sales: 0,
    });
  });

  it("draws the seller's median ratio toward the default by the default's weight", () => {
    // Ten sales at 60% of their ask: (10 * 0.6 + 5 * 0.75) / 15 = 0.65.
    const sales = Array.from({ length: 10 }, (_, index) => sale(`s${String(index)}`, 600, 1_000));
    const calibration = priceCalibration(sales);
    expect(calibration.sales).toBe(10);
    expect(calibration.saleToAsking).toBeCloseTo(0.65, 10);
  });

  it('takes the median, so one odd sale moves it little, and holds each ratio to its range', () => {
    const sales = [
      sale('a', 800, 1_000),
      sale('b', 800, 1_000),
      sale('c', 900, 1_000),
      // A bundle sold for more than one item asked, and a typo'd ask.
      sale('d', 5_000, 1_000),
      sale('e', 100, 100_000),
    ];
    const settings = { ...DEFAULT_PRICE_CALIBRATION_SETTINGS, priorSales: 0 };
    expect(priceCalibration(sales, settings).saleToAsking).toBeCloseTo(0.8, 10);
    expect(priceCalibration([sale('d', 5_000, 1_000)], settings).saleToAsking).toBe(1);
    expect(priceCalibration([sale('e', 100, 100_000)], settings).saleToAsking).toBe(0.3);
    expect(
      priceCalibration([sale('a', 600, 1_000), sale('b', 800, 1_000)], settings).saleToAsking,
    ).toBeCloseTo(0.7, 10);
  });
});

describe('calibrated prices', () => {
  const calibration = { saleToAsking: 0.5, sales: 20 };

  it('scales the AI estimate once and the web asks twice, in whole cents, never to zero', () => {
    expect(
      calibratedAiEstimate({ lowCents: 1_001, midCents: 2_000, highCents: 3_000 }, calibration),
    ).toEqual({ lowCents: 501, midCents: 1_000, highCents: 1_500 });
    expect(
      calibratedWebAsks({ lowCents: 2_000, highCents: 4_000, sites: ['ebay.com'] }, calibration),
    ).toEqual({ lowCents: 500, highCents: 1_000, sites: ['ebay.com'] });
    expect(calibratedWebAsks({ lowCents: 1, highCents: 2 }, calibration)).toEqual({
      lowCents: 1,
      highCents: 1,
    });
  });
});
