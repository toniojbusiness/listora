import { describe, expect, it } from 'vitest';

import { DEFAULT_SOURCING_COST, dollarsAndCents, itemCost } from './cost.ts';

describe('itemCost', () => {
  it('prices an item at the bins by its typical weight at the price per pound', () => {
    expect(itemCost('clothing/dresses/dresses')).toEqual({
      cents: 149,
      mode: 'bins',
      label: 'Bins cost about $1.49',
      basedOn: 'About 0.75 lb for a dress, at your $1.99 a pound',
    });
    expect(itemCost('clothing/bottoms/jeans').cents).toBe(279);
    expect(
      itemCost('clothing/outerwear/coats', { mode: 'bins', binsPricePerPoundCents: 100 }),
    ).toMatchObject({
      cents: 300,
      basedOn: 'About 3 lb for a coat, at your $1 a pound',
    });
  });

  it("falls back to the category's group, then to about a pound", () => {
    expect(itemCost('clothing/dresses/maxi').cents).toBe(149);
    expect(itemCost('shoes/sneakers')).toMatchObject({
      cents: 398,
      basedOn: 'About 2 lb for a pair of sneakers, at your $1.99 a pound',
    });
    expect(itemCost(null)).toMatchObject({
      cents: 199,
      basedOn: 'About 1 lb for an item like it, at your $1.99 a pound',
    });
    expect(itemCost('toys/plush').cents).toBe(199);
  });

  it("prices an item at a store by the kind's typical tag, or the seller's own price", () => {
    const store = { ...DEFAULT_SOURCING_COST, mode: 'store' as const };
    expect(itemCost('clothing/dresses/dresses', store)).toEqual({
      cents: 800,
      mode: 'store',
      label: 'Store price about $8',
      basedOn: 'What a thrift store usually asks for a dress',
    });
    expect(itemCost(null, store).cents).toBe(600);
    expect(itemCost('clothing/dresses/dresses', { ...store, storeItemCents: 450 })).toEqual({
      cents: 450,
      mode: 'store',
      label: 'Store price about $4.50',
      basedOn: 'Your store price per item',
    });
  });

  it('says whole dollars without cents', () => {
    expect(dollarsAndCents(800)).toBe('$8');
    expect(dollarsAndCents(149)).toBe('$1.49');
    expect(dollarsAndCents(450)).toBe('$4.50');
  });
});
