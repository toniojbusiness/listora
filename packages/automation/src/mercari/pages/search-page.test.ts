import { describe, expect, it } from 'vitest';

import {
  cardSizes,
  firstPrice,
  groupCards,
  listingOf,
  mercariSearchUrl,
  searchData,
  type MercariCard,
} from './search-page.ts';

const site = { origin: 'https://www.mercari.com' };

const card = (overrides: Partial<MercariCard> = {}): MercariCard => ({
  id: 'm10000000001',
  brand: "Levi's",
  size: '32',
  onSale: 'false',
  name: "Levi's 501 jeans 32x30",
  price: '$28.00',
  ...overrides,
});

describe("Mercari's public search page", () => {
  it('opens the URLs its own status filters and sort make', () => {
    expect(mercariSearchUrl(site, ' levis 501 jeans ', 'sold')).toBe(
      'https://www.mercari.com/search/?keyword=levis+501+jeans&itemStatuses=2&sortBy=2',
    );
    expect(mercariSearchUrl(site, 'levis 501 jeans', 'for_sale')).toBe(
      'https://www.mercari.com/search/?keyword=levis+501+jeans&itemStatuses=1',
    );
  });

  it("groups the page's parts into cards, each with its own name and first price", () => {
    const roles = [
      'ItemContainer',
      'ItemName',
      'ProductThumbItemPrice',
      'ItemContainer',
      'ProductThumbItemPrice',
      'ItemName',
      'ItemName',
    ];
    const none = roles.map(() => null);
    const cards = groupCards(roles, {
      ids: ['m1', null, null, 'm2', null, null, null],
      brands: ["Levi's", null, null, null, null, null, null],
      sizes: ['S (4-6)', null, null, '32', null, null, null],
      onSale: ['true', null, null, 'false', null, null, null],
      texts: ['', 'First', '$20.00$40.00', '', '$30', 'Second', 'Not its name'],
    });
    expect(cards).toEqual([
      {
        id: 'm1',
        brand: "Levi's",
        size: 'S (4-6)',
        onSale: 'true',
        name: 'First',
        price: '$20.00$40.00',
      },
      { id: 'm2', brand: null, size: '32', onSale: 'false', name: 'Second', price: '$30' },
    ]);
    // Parts before any card belong to none.
    expect(
      groupCards(['ItemName'], {
        ids: none,
        brands: none,
        sizes: none,
        onSale: none,
        texts: ['x'],
      }),
    ).toEqual([]);
  });

  it('reads a sold card as a sold listing, dated by the page data, its brand and sizes', () => {
    const sold = new Date('2026-10-30T18:00:00Z');
    expect(listingOf(card(), 'sold', new Map([['m10000000001', sold]]))).toEqual({
      priceCents: 2800,
      sold: true,
      brand: "Levi's",
      productType: null,
      sizes: ['32'],
      text: "Levi's 501 jeans 32x30",
      at: sold,
    });
    // Without the page's data, it has no date.
    expect(listingOf(card(), 'sold')?.at).toBeNull();
  });

  it('leaves out the other kind, lots, and cards without a name or a price', () => {
    expect(listingOf(card({ onSale: 'true' }), 'sold')).toBeNull();
    expect(listingOf(card({ onSale: 'false' }), 'for_sale')).toBeNull();
    expect(listingOf(card({ name: "Lot of 3 Levi's 501 jeans" }), 'sold')).toBeNull();
    expect(listingOf(card({ name: "Levi's jeans bundle" }), 'sold')).toBeNull();
    expect(listingOf(card({ name: '  ' }), 'sold')).toBeNull();
    expect(listingOf(card({ price: 'Free' }), 'sold')).toBeNull();
  });

  it('reads a card for sale without a date, and one without a brand by its name', () => {
    expect(listingOf(card({ onSale: 'true', brand: null }), 'for_sale', new Map())).toMatchObject({
      sold: false,
      brand: null,
      at: null,
    });
    // A card whose on-sale flag is absent counts as the search's kind.
    expect(listingOf(card({ onSale: null }), 'for_sale')).toMatchObject({ sold: false });
  });

  it('reads the first price a card shows: the price now, not the struck-through one', () => {
    expect(firstPrice('$25.00$60.00')).toBe(2500);
    expect(firstPrice('$1,250')).toBe(125_000);
    expect(firstPrice(' $18 ')).toBe(1800);
    expect(firstPrice('Sold')).toBeNull();
    expect(firstPrice(null)).toBeNull();
  });

  it("reads a card's size and the range Mercari puts after it", () => {
    expect(cardSizes('S (4-6)')).toEqual(['S (4-6)', 'S', '4-6']);
    expect(cardSizes('L  (12-14)')).toEqual(['L (12-14)', 'L', '12-14']);
    expect(cardSizes('32')).toEqual(['32']);
    expect(cardSizes('')).toEqual([]);
    expect(cardSizes(null)).toEqual([]);
  });

  it("reads items' times and the search's count from the page's own data", () => {
    const data = searchData({
      props: {
        pageProps: {
          serverState: {
            'SearchItem:m1': { __typename: 'SearchItem', id: 'm1', updated: 1_793_000_000 },
            'SearchItem:m2': {
              id: 'm2',
              updated: 1_793_100_000,
              lastSoldAt: 1_793_050_000,
            },
            'SearchItem:m3': { id: 'm3', updated: 'yesterday' },
            'Brand:298': { id: 298, name: "Levi's" },
            ROOT_QUERY: {
              __typename: 'Query',
              'search({"criteria":{"query":"levis 501 jeans"}})': { count: 1_204 },
              'master({})': { count: 9 },
            },
          },
        },
      },
    });
    expect(data.count).toBe(1_204);
    expect(data.times.get('m1')).toEqual(new Date(1_793_000_000_000));
    // A sold item's sale time before its last change.
    expect(data.times.get('m2')).toEqual(new Date(1_793_050_000_000));
    expect(data.times.has('m3')).toBe(false);
  });

  it('reads nothing from a page without its data, or of another shape', () => {
    for (const nextData of [null, {}, { props: { pageProps: {} } }, 'text', [1, 2]]) {
      const data = searchData(nextData);
      expect(data.count).toBeNull();
      expect(data.times.size).toBe(0);
    }
  });
});
