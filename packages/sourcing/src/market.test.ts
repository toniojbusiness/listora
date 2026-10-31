import { describe, expect, it } from 'vitest';

import {
  marketDemand,
  marketStats,
  withoutOutliers,
  type MarketListing,
  type MarketTarget,
} from './market.ts';

const now = new Date('2026-10-31T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/** A listing for sale, as Depop's public search shows one (it shows no sold ones). */
function listing(overrides: Partial<MarketListing>): MarketListing {
  return {
    priceCents: 2500,
    sold: false,
    brand: "Levi's",
    productType: 'jeans',
    sizes: ['W32'],
    text: "Levi's 501 straight jeans, light wash",
    at: null,
    ...overrides,
  };
}

const target: MarketTarget = {
  brand: "Levi's",
  productTypes: ['jeans'],
  typeWords: ['jeans'],
  model: '501',
  sizeLabel: 'W32',
};

describe('marketStats', () => {
  it('never matches on the brand alone: the item type must match too', () => {
    const jackets = Array.from({ length: 8 }, (_, index) =>
      listing({ productType: 'jackets', text: "Levi's trucker jacket", priceCents: 4000 + index }),
    );
    const stats = marketStats(jackets, target, now);
    expect(stats).toEqual({ level: null, read: { sold: 0, forSale: 8 } });
  });

  it('matches the tightest level with enough listings: the model and size, then looser', () => {
    const exact = Array.from({ length: 5 }, (_, index) =>
      listing({ priceCents: 3000 + index * 100 }),
    );
    const otherModel = Array.from({ length: 6 }, () =>
      listing({ text: "Levi's 550 relaxed jeans", priceCents: 1500 }),
    );
    expect(marketStats([...exact, ...otherModel], target, now).level).toBe('model_and_size');
    expect(marketStats([...exact.slice(0, 2), ...otherModel], target, now).level).toBe(
      'type_and_size',
    );
    const loose = marketStats(
      [...exact, ...otherModel],
      { ...target, model: null, sizeLabel: null },
      now,
    );
    expect(loose.level).toBe('type');
    expect(loose.forSale?.count).toBe(11);
    expect(loose.sold).toBeUndefined();
  });

  it('falls back to the tightest level with any match when none has enough', () => {
    const stats = marketStats([listing({}), listing({ sizes: ['W30'] })], target, now);
    expect(stats.level).toBe('model_and_size');
    expect(stats.forSale?.count).toBe(1);
  });

  it('reads the brand by its key and the type by its words when a listing names no type', () => {
    const stats = marketStats(
      Array.from({ length: 5 }, () =>
        listing({ brand: 'LEVIS', productType: null, text: 'vintage 501 jean' }),
      ),
      target,
      now,
    );
    expect(stats.level).toBe('model_and_size');
  });

  it('gives asking quartiles with outliers left out', () => {
    const forSale = [2000, 2200, 2500, 2600, 2800, 3000, 50_000].map((priceCents) =>
      listing({ priceCents }),
    );
    expect(marketStats(forSale, target, now).forSale).toEqual({
      count: 6,
      lowCents: 2275,
      medianCents: 2550,
      highCents: 2750,
    });
  });

  it('counts sold listings apart where a marketplace shows them, and matches on them first', () => {
    const sold = [2000, 2100, 2200, 2300, 2400].map((priceCents, index) =>
      listing({ priceCents, sold: true, at: daysAgo(index * 10) }),
    );
    const stats = marketStats([...sold, listing({ sold: false, sizes: ['W40'] })], target, now);
    expect(stats.level).toBe('model_and_size');
    expect(stats.sold).toMatchObject({ count: 5, lowCents: 2100, highCents: 2300, windowDays: 40 });
    expect(stats.forSale).toBeUndefined();
  });

  it('leaves out free and broken prices', () => {
    const stats = marketStats(
      [listing({ priceCents: 0 }), listing({ priceCents: 1.5 })],
      target,
      now,
    );
    expect(stats.level).toBeNull();
  });
});

describe('marketDemand', () => {
  it('reads the household pace against live supply', () => {
    expect(marketDemand(4, 30, 'Depop')).toEqual({
      demand: 'strong',
      label: 'Sells for you, little competition',
      basedOn: 'Your 4 sales like it in the last 90 days; 30 for sale on Depop now',
    });
    expect(marketDemand(1, 900, 'Depop')).toMatchObject({
      demand: 'crowded',
      label: 'Crowded on Depop',
    });
    expect(marketDemand(0, 120, 'Depop')).toEqual({
      demand: 'steady',
      basedOn: 'Your 0 sales like it in the last 90 days; 120 for sale on Depop now',
    });
    expect(marketDemand(5, null, 'Depop').demand).toBe('unknown');
  });
});

describe('withoutOutliers', () => {
  it('keeps every price under five', () => {
    expect(withoutOutliers([100, 100_000])).toEqual([100, 100_000]);
  });
});
