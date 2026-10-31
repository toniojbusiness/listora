import { describe, expect, it } from 'vitest';

import { isSimilarSale, ownHistoryFor, type OwnHistoryItem, type OwnSale } from './own-history.ts';

// Invented sales; no real shop's data.
const LEGGINGS = 'clothing/bottoms/leggings';
const sale = (overrides: Partial<OwnSale> = {}): OwnSale => ({
  itemId: 'sold-1',
  marketplace: 'depop',
  brand: 'Lululemon',
  category: LEGGINGS,
  sizeLabel: '6',
  salePriceCents: 2800,
  ...overrides,
});
const item: OwnHistoryItem = { itemId: 'item-1', brand: 'lululemon', category: LEGGINGS };

describe('isSimilarSale', () => {
  it('matches the same brand by key and the same category', () => {
    expect(isSimilarSale(item, sale())).toBe(true);
    expect(isSimilarSale(item, sale({ brand: 'LULULEMON ' }))).toBe(true);
    expect(isSimilarSale(item, sale({ brand: 'Lulus' }))).toBe(false);
    expect(isSimilarSale(item, sale({ category: 'clothing/tops/tank_tops' }))).toBe(false);
    expect(isSimilarSale(item, sale({ category: null }))).toBe(false);
  });

  it('matches any category for an item without one, and never the item itself', () => {
    expect(isSimilarSale({ ...item, category: null }, sale({ category: null }))).toBe(true);
    expect(isSimilarSale({ ...item, category: null }, sale({ category: 'shoes/sneakers' }))).toBe(
      true,
    );
    expect(isSimilarSale(item, sale({ itemId: 'item-1' }))).toBe(false);
  });

  it('never matches for an item without a brand', () => {
    expect(isSimilarSale({ ...item, brand: null }, sale())).toBe(false);
    expect(isSimilarSale({ ...item, brand: ' ' }, sale({ brand: ' ' }))).toBe(false);
  });
});

describe('ownHistoryFor', () => {
  it('ranges the similar sales per marketplace in the fixed marketplace order', () => {
    const sales = [
      sale({ marketplace: 'mercari', salePriceCents: 2000 }),
      sale({ salePriceCents: 2200 }),
      sale({ salePriceCents: 3000 }),
      sale({ salePriceCents: 2800 }),
      sale({ marketplace: 'mercari', salePriceCents: 2600 }),
      sale({ marketplace: 'ebay', salePriceCents: 1900 }),
      sale({ marketplace: 'ebay', salePriceCents: 2100 }),
      // Not similar: another brand, another category.
      sale({ brand: 'Athleta', salePriceCents: 9000 }),
      sale({ category: 'clothing/tops/tank_tops', salePriceCents: 9000 }),
    ];
    expect(ownHistoryFor(item, sales)).toEqual([
      {
        marketplace: 'ebay',
        stats: { count: 2, lowCents: 1900, medianCents: 2000, highCents: 2100 },
      },
      {
        marketplace: 'depop',
        stats: { count: 3, lowCents: 2200, medianCents: 2800, highCents: 3000 },
      },
      {
        marketplace: 'mercari',
        stats: { count: 2, lowCents: 2000, medianCents: 2300, highCents: 2600 },
      },
    ]);
  });

  it('leaves out a marketplace with a single similar sale, and an item without any', () => {
    expect(ownHistoryFor(item, [sale(), sale({ marketplace: 'poshmark' }), sale()])).toEqual([
      {
        marketplace: 'depop',
        stats: { count: 2, lowCents: 2800, medianCents: 2800, highCents: 2800 },
      },
    ]);
    expect(ownHistoryFor(item, [sale()])).toEqual([]);
    expect(ownHistoryFor({ ...item, brand: null }, [sale(), sale()])).toEqual([]);
  });
});
