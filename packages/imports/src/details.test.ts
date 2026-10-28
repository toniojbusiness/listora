import { describe, expect, it } from 'vitest';

import type { ListedListing } from '@listora/marketplaces';

import { importedItem, importedListingColumns, sizeSystem, titleFrom } from './details.ts';

function listed(
  overrides: Partial<ListedListing> = {},
  details: Partial<ListedListing['details']> = {},
): ListedListing {
  return {
    found: true,
    externalListingId: 'listing-1',
    externalUrl: 'https://example.test/listing-1',
    status: 'active',
    title: null,
    description: 'Floral maxi dress, worn once.\nFits like a small.',
    priceCents: 3400,
    currency: 'USD',
    revision: 1,
    refreshedAt: null,
    ...overrides,
    details: {
      photoUrls: [],
      brand: 'Free People',
      size: 'S',
      condition: 'pre_owned_excellent',
      categoryRef: null,
      categoryPath: [],
      colors: [],
      originalPriceCents: null,
      sku: null,
      ...details,
    },
  };
}

describe('importedItem', () => {
  it("takes a Depop listing's details, its title from its first line, and Listora's category", () => {
    const item = importedItem(
      'depop',
      listed(
        { description: 'Floral maxi dress, worn once.\nFits like a small.\n\n#boho #maxi' },
        {
          categoryRef: 'Women > Dresses > Casual dresses',
          categoryPath: ['Women', 'Dresses', 'Casual dresses'],
        },
      ),
    );
    expect(item).toEqual({
      title: 'Floral maxi dress, worn once.',
      description: 'Floral maxi dress, worn once.\nFits like a small.',
      brand: 'Free People',
      category: 'clothing/dresses/dresses',
      department: 'women',
      sizeLabel: 'S',
      sizeSystem: 'letter',
      condition: 'pre_owned_excellent',
      colors: [],
      listPriceCents: 3400,
      fromListing: [
        'title',
        'description',
        'brand',
        'category',
        'department',
        'sizeLabel',
        'sizeSystem',
        'condition',
        'listPriceCents',
      ],
    });
  });

  it("maps Poshmark's and Mercari's categories onto Listora's", () => {
    const poshmark = importedItem(
      'poshmark',
      listed(
        { title: 'Skinny jeans' },
        { categoryRef: 'Women/Jeans/Skinny', categoryPath: ['Women', 'Jeans', 'Skinny'] },
      ),
    );
    expect([poshmark.category, poshmark.department]).toEqual(['clothing/bottoms/jeans', 'women']);
    const mercari = importedItem(
      'mercari',
      listed(
        { title: 'Graphic tee' },
        { categoryRef: 'Men > Tops > T-shirts', categoryPath: ['Men', 'Tops', 'T-shirts'] },
      ),
    );
    expect([mercari.category, mercari.department]).toEqual(['clothing/tops/t_shirts', 'men']);
  });

  it.each([
    // Mercari's categories as the captain's own listings show them (read 2026-10-27).
    ['mercari', 'Women > Sweaters > Cardigan', 'clothing/tops/cardigans', 'women'],
    ['mercari', 'Women > Shorts > Denim', 'clothing/bottoms/shorts', 'women'],
    ['mercari', 'Women > Jeans > Straight leg', 'clothing/bottoms/jeans', 'women'],
    ['mercari', 'Women > Skirts > Maxi', 'clothing/bottoms/skirts', 'women'],
    [
      'mercari',
      'Women > Athletic apparel > Athletic Dresses',
      'clothing/activewear/other',
      'women',
    ],
    ['mercari', 'Women > Tops & blouses > Blouse', 'clothing/tops/blouses', 'women'],
    ['mercari', 'Women > Dresses > Above knee, mini', 'clothing/dresses/dresses', 'women'],
    ['depop', 'Men > Bottoms > Jeans', 'clothing/bottoms/jeans', 'men'],
    ['depop', 'Women > Footwear > Boots', 'shoes/boots', 'women'],
    // Depop's ids, as its listings' edit data names their category (shapes from a real shop,
    // whose names stop at two levels or name categories the sell form no longer has).
    ['depop', 'womenswear/bottoms/jeans', 'clothing/bottoms/jeans', 'women'],
    ['depop', 'womenswear/bottoms/trousers', 'clothing/bottoms/pants', 'women'],
    ['depop', 'womenswear/dresses/dresses', 'clothing/dresses/dresses', 'women'],
    ['depop', 'womenswear/coats-jackets/jackets', 'clothing/outerwear/jackets', 'women'],
    ['depop', 'menswear/coats-jackets/coats', 'clothing/outerwear/coats', 'men'],
    ['depop', 'womenswear/tops/jumpers', 'clothing/tops/sweaters', 'women'],
    ['depop', 'womenswear/tops/vests-tanks-camis', 'clothing/tops/tank_tops', 'women'],
    ['depop', 'womenswear/nightwear/pajamas', 'clothing/sleep_lounge/pajamas', 'women'],
    [
      'depop',
      'womenswear/jumpsuit-and-playsuit/jumpsuit',
      'clothing/dresses/jumpsuits_rompers',
      'women',
    ],
    [
      'depop',
      'womenswear/jumpsuit-and-playsuit/dungarees-overalls',
      'clothing/dresses/jumpsuits_rompers',
      'women',
    ],
    ['poshmark', 'Women/Dresses/Long Sleeve', 'clothing/dresses/dresses', 'women'],
    ['poshmark', 'Men/Shirts/Tees - Short Sleeve', 'clothing/tops/t_shirts', 'men'],
    ['poshmark', 'Women/Shoes/Ankle Boots & Booties', 'shoes/boots', 'women'],
  ] as const)("places %s %s in Listora's %s", (marketplace, ref, category, department) => {
    const item = importedItem(marketplace, listed({ title: 'Item' }, { categoryRef: ref }));
    expect([item.category, item.department]).toEqual([category, department]);
  });

  it('leaves out what the listing does not say, and a category Listora does not know', () => {
    const item = importedItem(
      'mercari',
      listed(
        { title: 'Mystery box', priceCents: null },
        { brand: null, size: null, condition: null, categoryRef: 'Nowhere > At all' },
      ),
    );
    expect(item).toMatchObject({ category: null, department: null, brand: null, sizeLabel: null });
    expect(item.fromListing).toEqual(['title', 'description']);
  });

  it("keeps the listing's own text without Listora's SKU line, and its category as the marketplace names it", () => {
    expect(
      importedListingColumns(
        'poshmark',
        listed(
          { title: 'Skinny jeans', description: 'Dark wash.\n\nSKU: AJ-000004' },
          { categoryRef: 'Women/Jeans/Skinny', sku: 'AJ-000004' },
        ),
      ),
    ).toEqual({
      title: 'Skinny jeans',
      description: 'Dark wash.',
      priceCents: 3400,
      categoryRef: 'Women/Jeans/Skinny',
      condition: 'pre_owned_excellent',
      sku: 'AJ-000004',
    });
  });
});

describe('a Depop listing', () => {
  it("keeps its category as Depop's sell form names it", () => {
    const columns = importedListingColumns(
      'depop',
      listed({}, { categoryRef: 'womenswear/tops/jumpers', categoryPath: ['Womenswear', 'Tops'] }),
    );
    expect(columns.categoryRef).toBe('Women > Tops > Sweaters');
  });

  it('lists the item at the price before a markdown, and the listing at the price shown now', () => {
    const marked = listed({ priceCents: 1500 }, { originalPriceCents: 2500 });
    expect(importedItem('depop', marked).listPriceCents).toBe(2500);
    expect(importedListingColumns('depop', marked).priceCents).toBe(1500);
    expect(importedItem('depop', listed({ priceCents: 1500 })).listPriceCents).toBe(1500);
  });

  it('takes its colours, and leaves them out of the details it set when it has none', () => {
    const item = importedItem('depop', listed({}, { colors: ['white', 'cream'] }));
    expect(item.colors).toEqual(['white', 'cream']);
    expect(item.fromListing).toContain('colors');
    expect(importedItem('depop', listed()).fromListing).not.toContain('colors');
  });

  it('takes its title from its first line without the hashtags on it, and keeps them in its text', () => {
    const item = importedItem(
      'depop',
      listed({ description: 'Cartoon graphic tee #cartoon #retro\nSoft and boxy.' }),
    );
    expect(item.title).toBe('Cartoon graphic tee');
    expect(item.description).toBe('Cartoon graphic tee #cartoon #retro\nSoft and boxy.');
  });
});

describe('titles and sizes', () => {
  it('leaves hashtags out of a title, and a line of only hashtags for the next one', () => {
    expect(titleFrom('#y2k Baby tee #pink')).toBe('Baby tee');
    expect(titleFrom('#vintage #denim\nHigh rise jeans')).toBe('High rise jeans');
    expect(titleFrom('Size #1 fan jersey')).toBe('Size #1 fan jersey');
  });

  it('cuts a long first line at a word, within 80 characters', () => {
    const title = titleFrom(`${'Vintage oversized wool blend cardigan '.repeat(4)}\nmore`);
    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title?.endsWith(' ')).toBe(false);
    expect(titleFrom('\n\n')).toBeNull();
  });

  it('reads size systems the tag parsers use', () => {
    expect(['M', 'xl', '32x30', '8', '8.5', 'One Size', '10-12', null].map(sizeSystem)).toEqual([
      'letter',
      'letter',
      'waist_inseam',
      'numeric',
      'numeric',
      'one_size',
      null,
      null,
    ]);
  });
});
