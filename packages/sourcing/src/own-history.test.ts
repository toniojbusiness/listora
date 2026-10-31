import { describe, expect, it } from 'vitest';

import { ownHistoryComparisons, type HistorySale } from './own-history.ts';

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
