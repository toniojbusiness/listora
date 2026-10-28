import { describe, expect, it } from 'vitest';

import { listingDetails } from './listing-details.ts';

/** The edit data of an invented listing, in the shape Depop's `edit-listing` gives it. */
function edit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'example-seller-wide-leg-jeans-0a1b',
    status: 'STATUS_ONSALE',
    description: 'Wide leg jeans',
    categories: ['Womenswear', 'Bottoms'],
    category_name: 'Bottoms',
    gender: 'female',
    is_kids: false,
    group: 'bottoms',
    product_type: 'jeans',
    brand: 'example-denim-co',
    brand_name: 'Example Denim Co.',
    condition: 'used_excellent',
    colour: ['blue', 'navy'],
    pricing: price('original_price', { original_price: amount('30.00') }),
    pictures: [],
    ...overrides,
  };
}

function amount(value: string): Record<string, unknown> {
  return { total_price: value, price_breakdown: { price: { amount: value } } };
}

function price(finalKey: string, prices: Record<string, unknown>): Record<string, unknown> {
  return { final_price_key: finalKey, currency: 'USD', currency_name: 'USD', ...prices };
}

const details = (overrides?: Record<string, unknown>) => listingDetails(edit(overrides), {}, null);

describe('listingDetails (Depop)', () => {
  it("names its category by Depop's ids, beside the names the listing shows", () => {
    // The names stop at two levels here; the ids name the product type.
    expect(details()).toMatchObject({
      categoryRef: 'womenswear/bottoms/jeans',
      categoryPath: ['Womenswear', 'Bottoms'],
    });
    expect(
      details({ categories: ['Menswear', 'Outerwear'], gender: 'male', group: 'coats-jackets' })
        .categoryRef,
    ).toBe('menswear/coats-jackets/jeans');
  });

  it("takes the department from the names when there's no gender, and kids' from is_kids", () => {
    expect(details({ gender: undefined, categories: ['Menswear', 'Bottoms'] }).categoryRef).toBe(
      'menswear/bottoms/jeans',
    );
    expect(details({ is_kids: true }).categoryRef).toBe('kidswear/bottoms/jeans');
  });

  it('names its category by the names the listing shows without the ids', () => {
    const shown = { categories: ['Womenswear', 'Tops', 'T-shirts'] };
    expect(details({ ...shown, product_type: undefined }).categoryRef).toBe(
      'Womenswear > Tops > T-shirts',
    );
    expect(details({ ...shown, group: undefined }).categoryRef).toBe(
      'Womenswear > Tops > T-shirts',
    );
    expect(details({ ...shown, gender: undefined, categories: ['Somewhere'] }).categoryRef).toBe(
      'Somewhere',
    );
    expect(details({ categories: [], gender: undefined }).categoryRef).toBeNull();
  });

  it("takes the brand's name before Depop's slug of it, and Other as no brand", () => {
    expect(details().brand).toBe('Example Denim Co.');
    expect(details({ brand_name: undefined }).brand).toBe('example-denim-co');
    expect(details({ brand: 'unbranded', brand_name: 'Other' }).brand).toBeNull();
  });

  it('reads its colours in Listora’s terms, the ones Listora knows', () => {
    expect(details().colors).toEqual(['blue', 'navy']);
    expect(details({ colour: ['grey', 'multi', 'burgundy', 'khaki'] }).colors).toEqual([
      'gray',
      'multicolor',
      'red',
    ]);
    expect(details({ colour: undefined }).colors).toEqual([]);
  });

  it('keeps the price before a markdown', () => {
    const reduced = price('discounted_price', {
      is_reduced: true,
      discount_percentage: 40,
      original_price: amount('25.00'),
      discounted_price: amount('15.00'),
    });
    expect(details({ pricing: reduced }).originalPriceCents).toBe(2500);
    expect(details().originalPriceCents).toBeNull();
    // A "reduced" price that isn't lower, or one Listora can't read, is no markdown.
    const higher = price('discounted_price', {
      original_price: amount('10.00'),
      discounted_price: amount('12.00'),
    });
    expect(details({ pricing: higher }).originalPriceCents).toBeNull();
    const unreadable = price('discounted_price', {
      original_price: amount('ten'),
      discounted_price: amount('8.00'),
    });
    expect(details({ pricing: unreadable }).originalPriceCents).toBeNull();
  });
});
