import { describe, expect, it } from 'vitest';

import { median, priceStats } from './stats.ts';

describe('priceStats', () => {
  it('is the nearest-rank quartiles and the median', () => {
    expect(priceStats([4000, 1000, 3000, 2000])).toEqual({
      count: 4,
      lowCents: 1000,
      medianCents: 2500,
      highCents: 3000,
    });
    expect(priceStats([2500, 2000, 4000])).toEqual({
      count: 3,
      lowCents: 2000,
      medianCents: 2500,
      highCents: 4000,
    });
  });

  it('keeps every quartile a price a buyer paid', () => {
    const prices = [1800, 2200, 2200, 2600, 2800, 3000, 3400, 9900];
    const stats = priceStats(prices);
    expect(prices).toContain(stats?.lowCents);
    expect(prices).toContain(stats?.highCents);
    // The one outlier moves neither quartile.
    expect(stats?.highCents).toBe(3000);
  });

  it('is one price for one sale, and nothing for none', () => {
    expect(priceStats([2700])).toEqual({
      count: 1,
      lowCents: 2700,
      medianCents: 2700,
      highCents: 2700,
    });
    expect(priceStats([])).toBeUndefined();
  });
});

describe('median', () => {
  it("averages an even sample's middle values, rounded", () => {
    expect(median([1000, 2001])).toBe(1501);
    expect(median([1000, 2000, 3000])).toBe(2000);
  });
});
