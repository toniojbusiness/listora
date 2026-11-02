import { DEFAULT_SCAN_CALL_SETTINGS, type ScanCallInput } from '@listora/sourcing';
import { describe, expect, it } from 'vitest';

import {
  anchoredCall,
  isVintage,
  resaleRatio,
  retailAnchoredRange,
  saleToRetail,
} from './retail-anchor.ts';

const settings = { ...DEFAULT_SCAN_CALL_SETTINGS, worthListingCents: 800 };
const noFees = () => 0;
const NO_FLAGS = { visibleDamage: false, lotOrBundle: false, counterfeitProne: false };

/** A sure read of an item retailing at $100 whose web asks are $40-$60 on two sites. */
function input(overrides: Partial<ScanCallInput> = {}): ScanCallInput {
  return {
    identityConfidence: 0.9,
    flags: NO_FLAGS,
    fees: noFees,
    retail: { lowCents: 10_000, highCents: 10_000, from: 'web', site: 'fernhill.example' },
    web: {
      lowCents: 4_000,
      highCents: 6_000,
      sites: ['poshmark.com', 'depop.com'],
      reputation: 'unknown',
    },
    ...overrides,
  };
}

/** `count` sales that each went for `share` of a $100 retail price. */
function sales(count: number, share: number) {
  return Array.from({ length: count }, () => ({
    salePriceCents: Math.round(10_000 * share),
    retailCents: 10_000,
  }));
}

describe('resaleRatio', () => {
  it('is 20%-60% of retail with no sale of a known retail price', () => {
    expect(resaleRatio([])).toEqual({ low: 0.2, high: 0.6, sales: 0 });
    expect(
      resaleRatio([{ salePriceCents: 1_000 }, { salePriceCents: 1_000, retailCents: 0 }]),
    ).toEqual({ low: 0.2, high: 0.6, sales: 0 });
  });

  it("draws the seller's quartiles toward the default by the default's weight", () => {
    // Ten sales at 10% of retail: (10 * 0.1 + 5 * 0.2) / 15 and (10 * 0.1 + 5 * 0.6) / 15.
    const ratio = resaleRatio(sales(10, 0.1));
    expect(ratio.sales).toBe(10);
    expect(ratio.low).toBeCloseTo(2 / 15, 10);
    expect(ratio.high).toBeCloseTo(4 / 15, 10);
  });

  it('is never above 60% of retail, however high the seller sold, and low never tops high', () => {
    const ratio = resaleRatio(sales(50, 0.9));
    expect(ratio.high).toBe(0.6);
    expect(ratio.low).toBe(0.6);
  });

  it("holds one sale's ratio to 2%-100%, so a wrong retail price moves it little", () => {
    expect(saleToRetail(5_000, 1_000)).toBe(1);
    expect(saleToRetail(1, 100_000)).toBe(0.02);
  });
});

describe('retailAnchoredRange', () => {
  it('takes a range across models at its middle times each end of the ratio', () => {
    expect(
      retailAnchoredRange(
        { lowCents: 6_000, highCents: 10_000 },
        { low: 0.25, high: 0.5, sales: 9 },
      ),
    ).toEqual({ lowCents: 2_000, highCents: 4_000 });
  });
});

describe('isVintage', () => {
  it('reads the era or the style', () => {
    expect(isVintage({ era: 'vintage 1990s', style: null })).toBe(true);
    expect(isVintage({ era: null, style: '90s Vintage' })).toBe(true);
    expect(isVintage({ era: 'current', style: 'Y2K' })).toBe(false);
    expect(isVintage({})).toBe(false);
  });
});

describe('anchoredCall', () => {
  const sellerRatio = resaleRatio(sales(10, 0.1));

  it("holds the retail price at the ratio ahead of the web's asks", () => {
    const call = anchoredCall(input(), sellerRatio, false, settings);
    expect(call.basis).toBe('retail');
    expect(call.range).toEqual({ lowCents: 1_333, highCents: 2_667 });
    // A sure read and a ratio from 10 of the seller's sales.
    expect(call.confidence).toBe('medium');
    expect(call.call).toBe('buy');
  });

  it('is low confidence at the default ratio or with an unsure read', () => {
    expect(anchoredCall(input(), resaleRatio([]), false, settings).confidence).toBe('low');
    expect(
      anchoredCall(input({ identityConfidence: 0.7 }), sellerRatio, false, settings).confidence,
    ).toBe('low');
  });

  it("skips when even the ratio's high end pays out under the worth-listing amount", () => {
    const cheap = input({ retail: { lowCents: 2_500, highCents: 2_500, from: 'tag' } });
    expect(anchoredCall(cheap, sellerRatio, false, settings)).toMatchObject({
      basis: 'retail',
      call: 'skip',
    });
  });

  it("leaves today's call for vintage, or where sold listings go above retail", () => {
    const today = anchoredCall(input(), sellerRatio, true, settings);
    expect(today.basis).toBe('web_info');
    const above = input({
      markets: [
        {
          marketplace: 'eBay',
          sold: { count: 2, lowCents: 11_000, highCents: 13_000, windowDays: 30, level: 'model' },
        },
      ],
    });
    expect(anchoredCall(above, sellerRatio, false, settings).basis).toBe('web_info');
  });

  it("never replaces the seller's own sales", () => {
    const own = input({
      ownHistory: {
        level: 'brand',
        saleIds: ['a', 'b', 'c'],
        prices: { count: 3, lowCents: 1_500, medianCents: 2_000, highCents: 2_500 },
      },
    });
    expect(anchoredCall(own, sellerRatio, false, settings).basis).toBe('own_history');
  });
});
