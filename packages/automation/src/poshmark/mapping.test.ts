/**
 * The static maps from Listora's canonical values onto Poshmark's: catalog, sizes, colors,
 * conditions, prohibited items, and the payload rules built on them.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ITEM_CONDITIONS } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import {
  canonicalMapPlaces,
  mapPoshmarkCatalog,
  mappedPoshmarkCatalogs,
  parseCatalogRef,
  POSHMARK_DEPARTMENTS,
  poshmarkCatalog,
  poshmarkCategories,
  sizeSetsFor,
  type PoshmarkDepartment,
} from './catalog.ts';
import { poshmarkColors } from './colors.ts';
import { POSHMARK_CONDITIONS, poshmarkCondition } from './conditions.ts';
import catalogJson from './data/catalog.json' with { type: 'json' };
import { buildPoshmarkPayload, validatePoshmarkPayload } from './payload.ts';
import { poshmarkSize } from './sizes.ts';

/**
 * Listora's canonical categories, from the vocabulary the iPhone app ships (which
 * packages/analysis keeps equal to `CATEGORY_TREE`).
 */
const CANONICAL: string[] = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../apps/ios/Packages/Features/Sources/ReviewFeature/Resources/vocabulary.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { categories: { category: string; subcategories: string[] }[] }
).categories.flatMap(({ category, subcategories }) =>
  subcategories.map((subcategory) => `${category}/${subcategory}`),
);

/**
 * The canonical categories Poshmark has no place for in a department, so the seller picks one
 * (every other one is mapped).
 */
const SELLERS_PICK: Readonly<Record<string, readonly string[]>> = {
  women: [
    'clothing/activewear/sets',
    'clothing/suits_sets/matching_sets',
    'clothing/suits_sets/other',
    'other/other',
  ],
  men: [
    'clothing/bottoms/skirts',
    'clothing/dresses/dresses',
    'clothing/dresses/jumpsuits_rompers',
    'clothing/dresses/other',
    'clothing/activewear/sports_bras',
    'clothing/activewear/sets',
    'clothing/sleep_lounge/pajamas',
    'clothing/sleep_lounge/robes',
    'clothing/sleep_lounge/loungewear',
    'clothing/sleep_lounge/other',
    'clothing/intimates/bras',
    'clothing/suits_sets/matching_sets',
    'clothing/suits_sets/other',
    'other/other',
  ],
  kids: [
    'clothing/activewear/sports_bras',
    'clothing/intimates/bras',
    'clothing/suits_sets/suits',
    'clothing/suits_sets/other',
    'other/other',
  ],
};

describe('Poshmark catalog data', () => {
  it("holds Poshmark's whole catalog: every department, with its categories and size sets", () => {
    expect(catalogJson.departments.map((department) => department.name)).toEqual([
      ...POSHMARK_DEPARTMENTS,
    ]);
    const counts = Object.fromEntries(
      POSHMARK_DEPARTMENTS.map((department) => [department, poshmarkCategories(department).length]),
    );
    expect(counts).toEqual({ Women: 38, Men: 28, Kids: 14, Home: 14, Pets: 7, Electronics: 13 });
    for (const department of POSHMARK_DEPARTMENTS) {
      for (const category of poshmarkCategories(department)) {
        expect(
          sizeSetsFor(department, category)?.length,
          `${department}/${category}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(mappedPoshmarkCatalogs()).toHaveLength(114 + 633);
    // Every one fits the API's `categoryRef` (at most 64 characters).
    for (const catalog of mappedPoshmarkCatalogs()) {
      const ref = [catalog.department, catalog.category, catalog.subcategory ?? ''].join('/');
      expect(ref.length, ref).toBeLessThanOrEqual(64);
    }
  });

  it('files the display groups’ categories under their group', () => {
    expect(poshmarkCatalog('Women', 'Kurtas')).toEqual({
      department: 'Women',
      category: 'Kurtas',
      subcategory: null,
      group: 'Global & Traditional Wear',
    });
    expect(poshmarkCatalog('Women', 'Tops')?.group).toBeNull();
  });
});

describe('Poshmark catalog map', () => {
  it('maps canonical categories per department, most specific first', () => {
    expect(mapPoshmarkCatalog('clothing/tops/blouses', 'women')).toEqual({
      department: 'Women',
      category: 'Tops',
      subcategory: 'Blouses',
      group: null,
    });
    expect(mapPoshmarkCatalog('clothing/tops/bodysuits', 'women')).toMatchObject({
      category: 'Tops',
      subcategory: 'Bodysuits',
    });
    expect(mapPoshmarkCatalog('clothing/outerwear/blazers', 'men')).toMatchObject({
      department: 'Men',
      category: 'Suits & Blazers',
      subcategory: 'Sport Coats & Blazers',
    });
    expect(mapPoshmarkCatalog('clothing/tops/t_shirts', 'kids')).toMatchObject({
      department: 'Kids',
      category: 'Shirts & Tops',
      subcategory: 'Tees - Short Sleeve',
    });
    // Home items go to Home whatever their department; unisex items under Men.
    expect(mapPoshmarkCatalog('home/bedding', null)).toMatchObject({
      department: 'Home',
      category: 'Bedding',
    });
    expect(mapPoshmarkCatalog('shoes/sneakers', 'unisex')?.department).toBe('Men');
  });

  it('maps every canonical category in every department, except the ones the seller picks', () => {
    for (const [department, picks] of Object.entries(SELLERS_PICK)) {
      const unmapped = CANONICAL.filter(
        (path) => !path.startsWith('home/') && mapPoshmarkCatalog(path, department) === null,
      );
      expect(unmapped, department).toEqual(picks);
    }
    expect(
      CANONICAL.filter(
        (path) => path.startsWith('home/') && mapPoshmarkCatalog(path, null) === null,
      ),
    ).toEqual(['home/other']);
  });

  it("names only places Poshmark's catalog has", () => {
    for (const { department, place } of canonicalMapPlaces()) {
      const [category = '', subcategory = null] = place.split('/');
      expect(
        poshmarkCatalog(department, category, subcategory),
        `${department}/${place}`,
      ).not.toBeNull();
    }
  });

  it('leaves unknown departments and categories unmapped', () => {
    expect(mapPoshmarkCatalog(null, 'women')).toBeNull();
    expect(mapPoshmarkCatalog('clothing/tops', null)).toBeNull();
  });

  it('reads a categoryRef in Poshmark display names, for any place Poshmark has', () => {
    expect(parseCatalogRef('Men/Jackets & Coats/Vests')).toMatchObject({
      department: 'Men',
      category: 'Jackets & Coats',
      subcategory: 'Vests',
    });
    expect(parseCatalogRef('Women/Dresses')).toMatchObject({ subcategory: null });
    expect(parseCatalogRef('Electronics/Headphones/Over-Ear Headphones')).toMatchObject({
      department: 'Electronics',
    });
    expect(parseCatalogRef('Kids/Dresses')).toMatchObject({ department: 'Kids' });
    expect(parseCatalogRef('Men/Dresses')).toBeNull();
    expect(parseCatalogRef('Women/Tops/Hoverboards')).toBeNull();
    expect(parseCatalogRef('Women/Hoverboards')).toBeNull();
    expect(parseCatalogRef('15687')).toBeNull();
  });
});

describe('Poshmark sizes', () => {
  const sets = (department: PoshmarkDepartment, category: string) => {
    const found = sizeSetsFor(department, category);
    if (found === null) throw new Error(category);
    return found;
  };
  const size = (
    label: string | null,
    system: string | null,
    department: PoshmarkDepartment,
    category: string,
  ) => poshmarkSize(label, system, sets(department, category), department);

  it.each([
    ['Medium', null, 'Men', 'Shirts', { set: 'Standard', size: 'M', label: 'M', chosen: 'M' }],
    ['2XL', 'letter', 'Men', 'Shirts', { set: 'Big & Tall', size: 'XXL' }],
    ['XL Tall', null, 'Men', 'Jackets & Coats', { set: 'Big & Tall', size: 'XLT' }],
    ['XXLT', null, 'Men', 'Sweaters', { set: 'Big & Tall', size: '2XLT' }],
    ['32x30', 'waist_inseam', 'Men', 'Jeans', { set: 'Standard', size: '32', label: 'Waist 32' }],
    ['W44 L32', 'waist_inseam', 'Men', 'Jeans', { set: 'Big & Tall', size: '44' }],
    ['36BT', null, 'Men', 'Jeans', { set: 'Big & Tall', size: '36BT', label: 'Waist 36' }],
    ['10 1/2', 'us', 'Men', 'Shoes', { set: 'Standard', size: '10.5' }],
    ['M 9', 'us', 'Men', 'Shoes', { set: 'Standard', size: '9' }],
    ['15.5', null, 'Men', 'Shirts', { set: 'Standard', size: '15.5', label: 'Neck 15.5' }],
    ['Neck 16', null, 'Men', 'Shirts', { set: 'Standard', size: '16', label: 'Neck 16' }],
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
    [null, null, 'Women', 'Bags', { set: 'Standard', size: 'OS', label: 'One Size', chosen: 'OS' }],
    ['One Size', 'one_size', 'Men', 'Underwear & Socks', { set: 'Standard', size: 'OS' }],
    ['Queen', null, 'Home', 'Bedding', { set: 'Standard', size: 'QUEEN', label: 'Queen' }],
    [null, null, 'Electronics', 'Headphones', { set: 'Standard', size: 'OS' }],
    [
      'Girls 8',
      null,
      'Kids',
      'Shirts & Tops',
      { set: 'Girls', size: '8G', label: '8', chosen: '8 (Girl)' },
    ],
    ["Boy's M", 'letter', 'Kids', 'Bottoms', { set: 'Boys', size: 'MB' }],
    ['4T', null, 'Kids', 'Dresses', { set: 'Girls', size: '4TG', label: '4T' }],
    ['6-9 months', null, 'Kids', 'One Pieces', { set: 'Baby', size: '6-9MB', label: '6-9 Months' }],
    ['12M', null, 'Kids', 'Pajamas', { set: 'Baby', size: '12MB' }],
    ['10 boys', 'us', 'Kids', 'Shoes', { set: 'Boys', size: '10B' }],
    [null, null, 'Kids', 'Toys', { set: 'Baby', size: 'OSBB', chosen: 'OS (Baby)' }],
  ] as const)('%s (%s) in %s %s', (label, system, department, category, expected) => {
    expect(size(label, system, department, category)).toMatchObject(expected);
  });

  it.each([
    // Petite written other ways, and inseam lengths (a size, not Poshmark's Petite).
    ['PS', 'Dresses', { set: 'Petite', size: 'SP' }],
    ['Petite M', 'Skirts', { set: 'Petite', size: 'MP' }],
    ['6 Petite', 'Dresses', { set: 'Petite', size: '6P' }],
    ['27P', 'Jeans', { set: 'Petite', size: '27P' }],
    ['0S', 'Jeans', { set: 'Standard', size: '0' }],
    ['4 Short', 'Pants & Jumpsuits', { set: 'Standard', size: '4' }],
    ['L Tall', 'Dresses', { set: 'Standard', size: 'L' }],
    // Plus sizes, waists in inches, and a waist with its size.
    ['16 Plus', 'Dresses', { set: 'Plus', size: '16' }],
    ['0X', 'Shorts', { set: 'Plus', size: '0X' }],
    ['27"', 'Jeans', { set: 'Standard', size: '27' }],
    ['W27', 'Shorts', { set: 'Standard', size: '27' }],
    ['27 in.', 'Pants & Jumpsuits', { set: 'Standard', size: '27' }],
    ['27/4', 'Jeans', { set: 'Standard', size: '27' }],
    ['27/4', 'Skirts', { set: 'Standard', size: '4' }],
  ] as const)("women's %s in %s", (label, category, expected) => {
    expect(size(label, null, 'Women', category)).toMatchObject(expected);
  });

  it('never guesses: a size the category lacks, a UK or EU size, a kids size for both, or none', () => {
    expect(size('XXS', 'letter', 'Men', 'Shirts')).toBeNull();
    expect(size('42', 'eu', 'Men', 'Shoes')).toBeNull();
    expect(size('10', 'uk', 'Women', 'Dresses')).toBeNull();
    expect(size(null, null, 'Women', 'Tops')).toBeNull();
    expect(size('Huge', null, 'Women', 'Tops')).toBeNull();
    // Girls and Boys both have an 8 and a 4T.
    expect(size('8', null, 'Kids', 'Shirts & Tops')).toBeNull();
    expect(size('4T', null, 'Kids', 'Bottoms')).toBeNull();
    // Juniors and Maternity sizes are never picked.
    expect(size('XS', null, 'Women', 'Dresses')).toMatchObject({ set: 'Standard', size: 'XS' });
  });
});

describe('Poshmark colors', () => {
  it("takes up to two of Poshmark's colors, nearest where Poshmark lacks one", () => {
    expect(poshmarkColors(['navy', 'white', 'red'])).toEqual(['Blue', 'White']);
    expect(poshmarkColors(['beige'])).toEqual(['Tan']);
    expect(poshmarkColors(['multicolor', 'black', 'black'])).toEqual(['Black']);
    expect(poshmarkColors([])).toEqual([]);
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
    // The data's conditions are the same four.
    expect(catalogJson.conditions).toEqual(
      Object.entries(POSHMARK_CONDITIONS).map(([code, label]) => ({ code, label })),
    );
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
    expect(fields({ item: { department: null } })).toEqual(['variant.categoryRef:unmapped']);
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

  it("asks for Girls or Boys when a kids' size doesn't say", () => {
    const kids = (sizeLabel: string) => ({
      item: { department: 'kids', category: 'clothing/tops/t_shirts', sizeLabel },
      variant: { aspects: [] },
    });
    expect(issues(kids('8'))[0]?.message).toBe(
      `Poshmark files kids' sizes under Girls, Boys, or Baby, and "8" doesn't say which one it is for Kids' Shirts & Tops. Write the size as, for example, "Girls 8" or "Boys 8".`,
    );
    expect(fields(kids('Boys 8'))).toEqual([]);
  });

  it('fills in up to two colors', () => {
    const { item, variant } = sampleListingContent({ item: { colors: ['navy', 'gray'] } });
    expect(buildPoshmarkPayload(item, variant).colors).toEqual(['Blue', 'Gray']);
  });

  it('takes underwear only new with tags, since Poshmark removes used underwear', () => {
    const boxers = (condition: 'pre_owned_excellent' | 'new_without_tags' | 'new_with_tags') => ({
      item: { category: 'clothing/intimates/underwear', sizeLabel: 'XL', condition },
      variant: { aspects: [] },
    });
    expect(issues(boxers('pre_owned_excellent'))).toEqual([
      {
        field: 'item.condition',
        code: 'not_allowed',
        message: "Poshmark doesn't take used underwear: it lists underwear only new with tags.",
      },
    ]);
    // Poshmark lists new underwear without tags as Like New, which reads as used.
    expect(fields(boxers('new_without_tags'))).toEqual(['item.condition:not_allowed']);
    expect(fields(boxers('new_with_tags'))).toEqual([]);
    // The item's own category decides, whatever Poshmark category the listing names.
    const named = boxers('pre_owned_excellent');
    expect(
      fields({ ...named, variant: { ...named.variant, categoryRef: 'Men/Underwear & Socks' } }),
    ).toEqual(['item.condition:not_allowed']);
    // So does the Poshmark category the listing names, whatever the item's.
    expect(
      fields({
        item: { category: 'clothing/tops/t_shirts', sizeLabel: 'M', condition: 'pre_owned_good' },
        variant: { aspects: [], categoryRef: 'Men/Underwear & Socks/Boxer Briefs' },
      }),
    ).toEqual(['item.condition:not_allowed']);
  });

  it('refuses what Poshmark prohibits before anything is sent', () => {
    const makeup = (condition: 'pre_owned_excellent' | 'new_with_tags') => ({
      item: { condition, sizeLabel: null },
      variant: { aspects: [], categoryRef: 'Women/Makeup/Lipstick' },
    });
    expect(issues(makeup('pre_owned_excellent'))).toEqual([
      {
        field: 'item.condition',
        code: 'not_allowed',
        message:
          'Poshmark takes makeup and personal care products only new: it lists them only new with tags.',
      },
    ]);
    expect(fields(makeup('new_with_tags'))).toEqual([]);
    expect(fields({ variant: { title: 'Gucci replica belt' } })).toEqual([
      'variant.title:not_allowed',
    ]);
    expect(fields({ variant: { description: 'Inspired by Chanel, never worn.' } })).toEqual([
      'variant.description:not_allowed',
    ]);
    expect(fields({ variant: { title: 'Dior perfume 50ml' } })).toEqual([
      'variant.title:not_allowed',
    ]);
  });
});
