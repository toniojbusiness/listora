import { describe, expect, it } from 'vitest';

import {
  ownHistoryByMarketplace,
  ownHistoryComparisons,
  type HistorySale,
  type OwnHistoryItem,
  type OwnSale,
} from './own-history.ts';

const JEANS = 'clothing/bottoms/jeans';
const TOPS = 'clothing/tops/blouses';

let next = 0;
function sale(brand: string | null, category: string | null, salePriceCents: number): HistorySale {
  next += 1;
  return { id: `s${String(next)}`, brand, category, salePriceCents };
}

describe('ownHistoryComparisons', () => {
  const history = [
    sale('Levi’s', JEANS, 2_000),
    sale('LEVI', JEANS, 2_400),
    sale("Levi's", JEANS, 1_600),
    sale('Levis', TOPS, 900),
    sale('Zara', JEANS, 1_100),
    sale(null, JEANS, 1_300),
  ];

  it('uses the same brand and category when there are enough of them', () => {
    const found = ownHistoryComparisons({ brand: "Levi's", category: JEANS }, history);
    expect(found?.level).toBe('brand_and_category');
    expect(found?.saleIds).toHaveLength(3);
    expect(found?.prices).toEqual({
      count: 3,
      lowCents: 1_800,
      medianCents: 2_000,
      highCents: 2_200,
    });
  });

  it('loosens to the brand, then the category, when a tighter match is too thin', () => {
    expect(ownHistoryComparisons({ brand: 'Levis', category: TOPS }, history)?.level).toBe('brand');
    expect(ownHistoryComparisons({ brand: 'Gap', category: JEANS }, history)?.level).toBe(
      'category',
    );
  });

  it('falls back to the tightest thin match when no level has enough', () => {
    const found = ownHistoryComparisons({ brand: 'Zara', category: TOPS }, history);
    expect(found?.level).toBe('brand');
    expect(found?.prices.count).toBe(1);
  });

  it('finds nothing without a brand or category, or with no match', () => {
    expect(ownHistoryComparisons({ brand: null, category: null }, history)).toBeUndefined();
    expect(
      ownHistoryComparisons({ brand: 'Gap', category: 'shoes/boots' }, history),
    ).toBeUndefined();
    expect(ownHistoryComparisons({ brand: 'Levis', category: JEANS }, [])).toBeUndefined();
  });

  it('takes the minimum number of comparisons as an option', () => {
    const found = ownHistoryComparisons({ brand: 'Zara', category: JEANS }, history, {
      minComparisons: 1,
    });
    expect(found?.level).toBe('brand_and_category');
  });
});

describe('ownHistoryByMarketplace', () => {
  // Invented sales; no real shop's data.
  const LEGGINGS = 'clothing/bottoms/leggings';
  const own = (overrides: Partial<OwnSale> = {}): OwnSale => {
    next += 1;
    return {
      id: `s${String(next)}`,
      itemId: `sold-${String(next)}`,
      marketplace: 'depop',
      brand: 'Lululemon',
      category: LEGGINGS,
      sizeLabel: '6',
      salePriceCents: 2800,
      ...overrides,
    };
  };
  const item: OwnHistoryItem = { itemId: 'item-1', brand: 'LULULEMON', category: LEGGINGS };

  it('ranges each marketplace in the fixed order, at its tightest level with two', () => {
    const sales = [
      own({ marketplace: 'mercari', salePriceCents: 2000 }),
      own({ salePriceCents: 2200 }),
      own({ salePriceCents: 3000 }),
      own({ salePriceCents: 2800 }),
      own({ marketplace: 'mercari', salePriceCents: 2600 }),
      // eBay has one pair of leggings, so its brand's sales show instead.
      own({ marketplace: 'ebay', salePriceCents: 1900 }),
      own({ marketplace: 'ebay', category: 'shoes/sneakers', salePriceCents: 4100 }),
      // Not the brand: never shown.
      own({ marketplace: 'poshmark', brand: 'Athleta' }),
      own({ marketplace: 'poshmark', brand: 'Athleta' }),
    ];
    expect(ownHistoryByMarketplace(item, sales)).toEqual([
      {
        marketplace: 'ebay',
        level: 'brand',
        prices: { count: 2, lowCents: 2450, medianCents: 3000, highCents: 3550 },
      },
      {
        marketplace: 'depop',
        level: 'brand_and_category',
        prices: { count: 3, lowCents: 2500, medianCents: 2800, highCents: 2900 },
      },
      {
        marketplace: 'mercari',
        level: 'brand_and_category',
        prices: { count: 2, lowCents: 2150, medianCents: 2300, highCents: 2450 },
      },
    ]);
  });

  it("needs two of the brand's sales, never counts the item's own, and needs a brand", () => {
    expect(ownHistoryByMarketplace(item, [own()])).toEqual([]);
    expect(ownHistoryByMarketplace(item, [own(), own({ itemId: 'item-1' })])).toEqual([]);
    expect(ownHistoryByMarketplace({ ...item, brand: null }, [own(), own()])).toEqual([]);
  });
});
