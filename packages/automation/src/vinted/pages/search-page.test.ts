import { describe, expect, it } from 'vitest';

import {
  cardSizes,
  cardTitle,
  groupCards,
  listingOf,
  parsePrice,
  searchTotal,
  vintedSearchUrl,
} from './search-page.ts';

const site = { origin: 'https://www.vinted.com' };

describe("Vinted's public search page", () => {
  it('opens the URL its own search bar and links make', () => {
    expect(vintedSearchUrl(site, ' levis 501 jeans ')).toBe(
      'https://www.vinted.com/catalog?search_text=levis%20501%20jeans',
    );
  });

  it('groups the parts into boxes, each with its own first of each part', () => {
    const roles = [
      'product-item-id-1',
      'product-item-id-1--overlay-link',
      'product-item-id-1--description-title',
      'product-item-id-1--description-subtitle',
      'product-item-id-1--price-text',
      'product-item-id-2',
      'product-item-id-2--overlay-link',
      'product-item-id-2--price-text',
      'product-item-id-2--price-text',
      'something-else',
    ];
    const titles = roles.map((role) =>
      role.endsWith('--overlay-link') ? `Jeans ${role.slice(16, 17)}, Brand: Levi's` : null,
    );
    const texts = roles.map((role) =>
      role.endsWith('--description-title')
        ? "Levi's"
        : role.endsWith('--description-subtitle')
          ? 'W32 · Very good'
          : role.endsWith('--price-text')
            ? '$18.00'
            : '',
    );
    expect(groupCards(roles, { titles, texts })).toEqual([
      {
        label: "Jeans 1, Brand: Levi's",
        brand: "Levi's",
        subtitle: 'W32 · Very good',
        price: '$18.00',
      },
      { label: "Jeans 2, Brand: Levi's", brand: null, subtitle: null, price: '$18.00' },
    ]);
  });

  it("reads the listing's own title out of the overlay link's", () => {
    expect(
      cardTitle(
        "Levis 501 90s size 28, Brand: Levi's, Condition: Very good, Size: Other, 18.00 $, 19.60 $",
      ),
    ).toBe('Levis 501 90s size 28');
    expect(cardTitle('Wool scarf, Condition: Good, 8.00 $, 9.10 $')).toBe('Wool scarf');
    expect(cardTitle('Wool scarf, 8.00 $, 9.10 $')).toBe('Wool scarf');
    expect(cardTitle(null)).toBe('');
  });

  it('reads prices in dollars only', () => {
    expect(parsePrice('$18.00')).toBe(1800);
    expect(parsePrice(' $1,250.00 ')).toBe(125_000);
    expect(parsePrice('$7')).toBe(700);
    expect(parsePrice('18,00 €')).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  it('reads the size out of the subtitle, never the condition', () => {
    expect(cardSizes('W32 · Very good')).toEqual(['W32', '32']);
    expect(cardSizes('S / US 4-6 · New with tags')).toEqual(['S / US 4-6', 'S', 'US 4-6', '4-6']);
    expect(cardSizes('Other · Very good')).toEqual([]);
    expect(cardSizes('Very good')).toEqual([]);
    expect(cardSizes(null)).toEqual([]);
  });

  it("reads the search's count, 500+ as 500", () => {
    expect(searchTotal(['Sort by', '500+ results.'])).toBe(500);
    expect(searchTotal(['1,204 results'])).toBe(1204);
    expect(searchTotal(['1 result.'])).toBe(1);
    expect(searchTotal(['0 results.'])).toBe(0);
    expect(searchTotal(['Search results'])).toBeNull();
  });

  it('reads a box as a listing for sale, undated, and leaves out lots and boxes without a price', () => {
    const card = {
      label: "Levi's 501 jeans, Brand: Levi's, Condition: Very good, Size: W28, 25.00 $, 27.00 $",
      brand: "Levi's",
      subtitle: 'W28 · Very good',
      price: '$25.00',
    };
    expect(listingOf(card)).toEqual({
      priceCents: 2500,
      sold: false,
      brand: "Levi's",
      productType: null,
      sizes: ['W28', '28'],
      text: "Levi's 501 jeans",
      at: null,
    });
    expect(listingOf({ ...card, brand: ' ' })).toMatchObject({ brand: null });
    expect(listingOf({ ...card, label: "Lot of 3 Levi's 501 jeans, Brand: Levi's" })).toBeNull();
    expect(listingOf({ ...card, price: '25,00 €' })).toBeNull();
    expect(listingOf({ ...card, label: null })).toBeNull();
  });
});
