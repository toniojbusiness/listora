/**
 * Poshmark's public search page, read from invented results in the shape its pages embed them
 * (`$_search.gridData.data`, search-page.ts): what is counted, and what never is.
 */
import { describe, expect, it } from 'vitest';

import { PageChangedError } from '../../runner/errors.ts';
import { PoshmarkSite } from '../site.ts';
import { poshmarkSearchFromData, poshmarkSearchUrl, productTypeOf } from './search-page.ts';

/** One invented result, as a search page embeds it (only the fields read, and a few others). */
function result(overrides: Record<string, unknown> = {}) {
  return {
    id: '6a0000000000000000000001',
    title: "Levi's 501 Jeans Size 28",
    brand: "Levi's",
    price_amount: { val: '34.0', currency_code: 'USD', currency_symbol: '$' },
    size: '28',
    inventory: {
      status: 'available',
      status_changed_at: '2026-10-09T19:00:28-07:00',
      multi_item: false,
      size_quantities: [{ size_id: '28', size_obj: { id: '28', display: '28' } }],
    },
    department: { id: 'd1', display: 'Women' },
    category_v2: { id: 'c1', display: 'Jeans' },
    creator_username: 'invented_seller',
    like_count: 5,
    ...overrides,
  };
}

const sold = (at: string, overrides: Record<string, unknown> = {}) =>
  result({
    inventory: {
      status: 'sold_out',
      status_changed_at: at,
      size_quantities: [{ size_obj: { display: '28' } }],
    },
    ...overrides,
  });

describe("Poshmark's search page", () => {
  const site = new PoshmarkSite('https://poshmark.com');

  it('opens the search as its search box does, and its sold filter', () => {
    expect(poshmarkSearchUrl(site, ' levis 501 jeans ', 'for_sale')).toBe(
      'https://poshmark.com/search?query=levis+501+jeans&type=listings&src=dir',
    );
    expect(poshmarkSearchUrl(site, 'levis 501 jeans', 'sold')).toBe(
      'https://poshmark.com/search?query=levis+501+jeans&type=listings&src=dir&availability=sold_out',
    );
  });

  it("reads each result's price, brand, type, sizes, and title, and the search's count", () => {
    const found = poshmarkSearchFromData(
      [result({ inventory: { ...result().inventory, status: 'reserved' } })],
      97_581,
      'for_sale',
    );
    expect(found).toEqual({
      listings: [
        {
          priceCents: 3400,
          sold: false,
          brand: "Levi's",
          productType: 'Women/Jeans',
          sizes: ['28'],
          text: "Levi's 501 Jeans Size 28",
          at: null,
        },
      ],
      total: 97_581,
      shown: 1,
    });
  });

  it('dates a sold listing by the day it sold', () => {
    const found = poshmarkSearchFromData(
      [sold('2026-10-29T09:56:37-07:00', { size: 'W28 L30' })],
      264_413,
      'sold',
    );
    expect(found.listings).toEqual([
      expect.objectContaining({
        sold: true,
        sizes: ['W28 L30', '28'],
        at: new Date('2026-10-29T16:56:37Z'),
      }),
    ]);
  });

  it('never counts lots, many-size listings, other currencies, free, or the other page', () => {
    const found = poshmarkSearchFromData(
      [
        result({ title: "Lot of 3 Levi's 501 Jeans" }),
        result({ inventory: { status: 'available', multi_item: true } }),
        result({ price_amount: { val: '30.0', currency_code: 'CAD' } }),
        result({ price_amount: { val: '0.0', currency_code: 'USD' } }),
        result({ inventory: { status: 'not_for_sale' } }),
        sold('2026-10-29T09:56:37-07:00'),
      ],
      null,
      'for_sale',
    );
    expect(found).toEqual({ listings: [], total: null, shown: 6 });
    const soldPage = poshmarkSearchFromData(
      [result(), sold('not a time'), sold('2026-10-20T10:00:00-07:00')],
      12,
      'sold',
    );
    expect(soldPage.listings).toHaveLength(1);
  });

  it('matches no brand or type a listing leaves out', () => {
    const found = poshmarkSearchFromData(
      [result({ brand: null, department: null })],
      1,
      'for_sale',
    );
    expect(found.listings[0]).toMatchObject({ brand: '', productType: null });
    expect(productTypeOf({ department: { display: 'Men' }, category_v2: { display: ' ' } })).toBe(
      null,
    );
  });

  it('fails a page whose data is not the results Listora knows', () => {
    expect(() => poshmarkSearchFromData(null, null, 'sold')).toThrow(PageChangedError);
    expect(() => poshmarkSearchFromData([{ title: 'no price' }], 3, 'sold')).toThrow(
      /no longer has the price_amount/,
    );
  });
});
