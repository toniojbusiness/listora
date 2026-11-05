/**
 * What an import takes from a Vinted item record (invented records in the shape the web API is
 * modeled with, `api.ts`), and Vinted's prices in cents.
 */
import { describe, expect, it } from 'vitest';

import { orderTime, priceCents } from './api.ts';
import { listingDetails } from './listing-details.ts';

describe('listingDetails', () => {
  it('reads the photos, brand, size, condition, category, and colours', () => {
    expect(
      listingDetails(
        {
          photos: [
            {
              url: 'https://images.example/a-thumb.jpg',
              full_size_url: 'https://images.example/a.jpg',
            },
            { url: 'https://images.example/b.jpg' },
            { full_size_url: 'ftp://images.example/c.jpg' },
            { full_size_url: 'https://images.example/a.jpg' },
          ],
          brand_title: 'Invented Co',
          size_title: 'S / US 4-6',
          status: 'New without tags',
          catalog_id: 1904,
          color1: 'Light blue',
          color2: 'Khaki',
        },
        'AJ-000184',
      ),
    ).toEqual({
      photoUrls: ['https://images.example/a.jpg', 'https://images.example/b.jpg'],
      brand: 'Invented Co',
      size: 'S / US 4-6',
      condition: 'new_without_tags',
      categoryRef: '1904',
      categoryPath: [],
      colors: ['blue'],
      originalPriceCents: null,
      sku: 'AJ-000184',
    });
  });

  it.each([
    ['New with tags', 'new_with_tags'],
    ['Very good', 'pre_owned_excellent'],
    ['Good', 'pre_owned_good'],
    ['Satisfactory', 'pre_owned_fair'],
  ])('never claims more than Vinted’s %s', (status, condition) => {
    expect(listingDetails({ status }, null).condition).toBe(condition);
  });

  it('reads the condition by its id when no label is shown, and none it does not know', () => {
    expect(listingDetails({ status_id: 6 }, null).condition).toBe('new_with_tags');
    expect(listingDetails({ status_id: 4 }, null).condition).toBe('pre_owned_fair');
    expect(listingDetails({ status: 'Mint', status_id: 99 }, null).condition).toBeNull();
  });

  it('takes "No brand" as none, and the brand from its record when there is no title', () => {
    expect(listingDetails({ brand_title: 'No brand' }, null).brand).toBeNull();
    expect(listingDetails({ brand_dto: { title: 'Invented Co' } }, null).brand).toBe('Invented Co');
  });

  it('leaves out every detail a record lacks', () => {
    expect(listingDetails({ id: 1 }, null)).toEqual({
      photoUrls: [],
      brand: null,
      size: null,
      condition: null,
      categoryRef: null,
      categoryPath: [],
      colors: [],
      originalPriceCents: null,
      sku: null,
    });
  });
});

describe('priceCents', () => {
  it('reads Vinted’s amounts in US dollars', () => {
    expect(priceCents({ amount: '18.0', currency_code: 'USD' }, undefined)).toBe(1800);
    expect(priceCents({ amount: '1250.5' }, undefined)).toBe(125_050);
    expect(priceCents('7.25', 'USD')).toBe(725);
    expect(priceCents(12, undefined)).toBe(1200);
  });

  it('refuses a price in another currency, an amount it cannot read, and none at all', () => {
    expect(() => priceCents({ amount: '18.0', currency_code: 'EUR' }, undefined)).toThrow(
      'not in US dollars',
    );
    expect(() => priceCents('18,00', undefined)).toThrow("can't read");
    expect(() => priceCents(undefined, undefined)).toThrow('without a price');
  });
});

describe('orderTime', () => {
  it('reads when the buyer paid, and refuses a time it cannot read', () => {
    expect(
      orderTime({ transaction_id: '1', date: '2026-10-31T12:00:00+01:00' }).toISOString(),
    ).toBe('2026-10-31T11:00:00.000Z');
    expect(() => orderTime({ transaction_id: '1', date: 'yesterday' })).toThrow("can't read");
  });
});
