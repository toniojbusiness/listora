/**
 * The static maps from Listora's canonical values onto Poshmark's: catalog, sizes, conditions,
 * and the payload rules built on them.
 */
import { describe, expect, it } from 'vitest';

import { ITEM_CONDITIONS } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import {
  mapPoshmarkCatalog,
  mappedPoshmarkCatalogs,
  parseCatalogRef,
  sizeSetsFor,
} from './catalog.ts';
import { POSHMARK_CONDITIONS, poshmarkCondition } from './conditions.ts';
import { buildPoshmarkPayload, validatePoshmarkPayload } from './payload.ts';
import { poshmarkSize } from './sizes.ts';

describe('Poshmark catalog map', () => {
  it('maps canonical categories per department, most specific first', () => {
    expect(mapPoshmarkCatalog('clothing/tops/blouses', 'women')).toEqual({
      department: 'Women',
      category: 'Tops',
      subcategory: 'Blouses',
    });
    expect(mapPoshmarkCatalog('clothing/tops/bodysuits', 'women')).toEqual({
      department: 'Women',
      category: 'Tops',
      subcategory: null,
    });
    expect(mapPoshmarkCatalog('clothing/outerwear/blazers', 'men')).toEqual({
      department: 'Men',
      category: 'Suits & Blazers',
      subcategory: 'Sport Coats & Blazers',
    });
    // Unisex items go under Men.
    expect(mapPoshmarkCatalog('shoes/sneakers', 'unisex')?.department).toBe('Men');
  });

  it('leaves what it cannot place unmapped: kids, home, and unknown departments', () => {
    expect(mapPoshmarkCatalog('clothing/tops/t_shirts', 'kids')).toBeNull();
    expect(mapPoshmarkCatalog('home/decor', 'women')).toBeNull();
    expect(mapPoshmarkCatalog(null, 'women')).toBeNull();
    expect(mapPoshmarkCatalog('clothing/tops', null)).toBeNull();
  });

  it('maps only onto categories whose size sets it knows', () => {
    for (const catalog of mappedPoshmarkCatalogs()) {
      expect(sizeSetsFor(catalog.department, catalog.category), catalog.category).not.toBeNull();
    }
  });

  it('reads a categoryRef in Poshmark display names', () => {
    expect(parseCatalogRef('Men/Jackets & Coats/Vests')).toEqual({
      department: 'Men',
      category: 'Jackets & Coats',
      subcategory: 'Vests',
    });
    expect(parseCatalogRef('Women/Dresses')).toMatchObject({ subcategory: null });
    expect(parseCatalogRef('Kids/Dresses')).toBeNull();
    expect(parseCatalogRef('Women/Hoverboards')).toBeNull();
    expect(parseCatalogRef('15687')).toBeNull();
  });
});

describe('Poshmark sizes', () => {
  const sets = (department: 'Women' | 'Men', category: string) => {
    const found = sizeSetsFor(department, category);
    if (found === null) throw new Error(category);
    return found;
  };

  it.each([
    ['Medium', null, 'Men', 'Shirts', { set: 'Standard', size: 'M' }],
    ['2XL', 'letter', 'Men', 'Shirts', { set: 'Big & Tall', size: 'XXL' }],
    ['XL Tall', null, 'Men', 'Jackets & Coats', { set: 'Big & Tall', size: 'XLT' }],
    ['XXLT', null, 'Men', 'Sweaters', { set: 'Big & Tall', size: '2XLT' }],
    ['32x30', 'waist_inseam', 'Men', 'Jeans', { set: 'Standard', size: '32' }],
    ['W44 L32', 'waist_inseam', 'Men', 'Jeans', { set: 'Big & Tall', size: '44' }],
    ['36BT', null, 'Men', 'Jeans', { set: 'Big & Tall', size: '36BT' }],
    ['10 1/2', 'us', 'Men', 'Shoes', { set: 'Standard', size: '10.5' }],
    ['M 9', 'us', 'Men', 'Shoes', { set: 'Standard', size: '9' }],
    ['15.5', null, 'Men', 'Shirts', { set: 'Standard', size: '15.5' }],
    ['40R', null, 'Men', 'Suits & Blazers', { set: 'Standard', size: '40R' }],
    ['S Petite', null, 'Women', 'Tops', { set: 'Petite', size: 'SP' }],
    ['4P', null, 'Women', 'Dresses', { set: 'Petite', size: '4P' }],
    ['00', 'numeric', 'Women', 'Dresses', { set: 'Standard', size: '00' }],
    ['14W', null, 'Women', 'Tops', { set: 'Plus', size: '14W' }],
    ['3X', null, 'Women', 'Tops', { set: 'Plus', size: '3X' }],
    ['3XL', 'letter', 'Women', 'Tops', { set: 'Plus', size: 'XXXL' }],
    ['27', null, 'Women', 'Jeans', { set: 'Standard', size: '27' }],
    ['34DD', null, 'Women', 'Intimates & Sleepwear', { set: 'Standard', size: '34E (DD)' }],
    ['8.5', 'us', 'Women', 'Shoes', { set: 'Standard', size: '8.5' }],
    [null, null, 'Women', 'Bags', { set: 'Standard', size: 'OS' }],
    ['One Size', 'one_size', 'Men', 'Underwear & Socks', { set: 'Standard', size: 'OS' }],
  ] as const)('%s (%s) in %s %s', (label, system, department, category, expected) => {
    expect(poshmarkSize(label, system, sets(department, category))).toEqual(expected);
  });

  it('never guesses: a size the category lacks, a UK or EU size, or none at all', () => {
    expect(poshmarkSize('XXS', 'letter', sets('Men', 'Shirts'))).toBeNull();
    expect(poshmarkSize('42', 'eu', sets('Men', 'Shoes'))).toBeNull();
    expect(poshmarkSize('10', 'uk', sets('Women', 'Dresses'))).toBeNull();
    expect(poshmarkSize(null, null, sets('Women', 'Tops'))).toBeNull();
    expect(poshmarkSize('Huge', null, sets('Women', 'Tops'))).toBeNull();
  });
});

describe('Poshmark conditions', () => {
  it('maps every canonical condition onto one of the four, never claiming more', () => {
    const mapped = Object.fromEntries(
      ITEM_CONDITIONS.map((condition) => [condition, poshmarkCondition(condition).code]),
    );
    expect(mapped).toEqual({
      new_with_tags: 'nwt',
      new_without_tags: 'uln',
      new_with_defects: 'ug',
      pre_owned_excellent: 'uln',
      pre_owned_good: 'ug',
      pre_owned_fair: 'uf',
    });
    expect(poshmarkCondition('pre_owned_fair').label).toBe(POSHMARK_CONDITIONS.uf);
  });
});

describe('Poshmark payload rules', () => {
  const issues = (overrides: Parameters<typeof sampleListingContent>[0]) => {
    const { item, variant } = sampleListingContent(overrides);
    return validatePoshmarkPayload(buildPoshmarkPayload(item, variant));
  };
  const fields = (overrides: Parameters<typeof sampleListingContent>[0]) =>
    issues(overrides).map((issue) => `${issue.field}:${issue.code}`);

  it('accepts the sample listing', () => {
    expect(issues({})).toEqual([]);
  });

  it("takes the variant's category, brand, size, and condition over the item's", () => {
    const { item, variant } = sampleListingContent({
      variant: {
        categoryRef: 'Men/Jackets & Coats/Vests',
        condition: 'new_with_tags',
        aspects: [
          { name: 'Brand', values: ['Levi Strauss & Co.'] },
          { name: 'Size', values: ['L'] },
        ],
      },
    });
    expect(buildPoshmarkPayload(item, variant)).toMatchObject({
      catalog: { department: 'Men', category: 'Jackets & Coats', subcategory: 'Vests' },
      size: { set: 'Standard', size: 'L' },
      condition: { code: 'nwt' },
      brand: 'Levi Strauss & Co.',
    });
  });

  it('refuses what Poshmark would: prices, lengths, photos, and missing catalog values', () => {
    const cents = (amountCents: number) => ({
      variant: { price: { amountCents, currency: 'USD' as const } },
    });
    expect(fields(cents(200))).toEqual(['variant.price:out_of_range']);
    expect(fields(cents(4550))).toEqual(['variant.price:whole_dollars']);
    expect(fields(cents(100_000_100))).toEqual(['variant.price:out_of_range']);
    expect(fields({ variant: { description: 'x'.repeat(1_501) } })).toEqual([
      'variant.description:too_long',
    ]);
    expect(fields({ variant: { description: ' ' } })).toEqual(['variant.description:required']);
    const photos = Array.from({ length: 17 }, (_, position) => ({
      photoId: `photo-${String(position)}`,
      position,
      role: 'detail' as const,
      url: `https://media.listora.test/p/${String(position)}.jpg`,
    }));
    expect(fields({ item: { photos } })).toEqual(['item.photos:too_many']);
    expect(fields({ item: { department: 'kids' } })).toEqual(['variant.categoryRef:unmapped']);
    expect(fields({ item: { sizeLabel: 'Huge' }, variant: { aspects: [] } })).toEqual([
      'item.sizeLabel:unmapped',
    ]);
    expect(fields({ item: { sizeLabel: null }, variant: { aspects: [] } })).toEqual([
      'item.sizeLabel:required',
    ]);
    expect(fields({ item: { condition: null } })).toEqual(['item.condition:required']);
    expect(issues({ item: { sizeLabel: 'Huge' }, variant: { aspects: [] } })[0]?.message).toBe(
      `Poshmark has no size "Huge" for Men's Jackets & Coats. Set a size Poshmark offers.`,
    );
  });
});
