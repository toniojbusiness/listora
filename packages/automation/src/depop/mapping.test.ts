import { describe, expect, it } from 'vitest';

import { DEPOP_CONDITIONS, depopProductType, ITEM_CONDITIONS } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import {
  categorySizeKind,
  mapDepopCategory,
  mappedDepopCategories,
  parseCategoryRef,
} from './categories.ts';
import { DEPOP_CONDITION_LABELS, depopFormCondition } from './conditions.ts';
import { listingCopy } from './pages/page-data.ts';
import {
  buildDepopAutomationPayload,
  depopListingText,
  depopPriceField,
  validateDepopAutomationPayload,
} from './payload.ts';
import { DEPOP_PATHS, DEPOP_SLUG, slugFromPath } from './site.ts';
import { depopSize, sizeOptionMatches } from './sizes.ts';

const item = sampleListingContent().item;

function payload(overrides: Parameters<typeof sampleListingContent>[0] = {}) {
  const content = sampleListingContent(overrides);
  return buildDepopAutomationPayload(content.item, content.variant);
}

describe('Depop categories', () => {
  it('maps by the most specific canonical path, per department', () => {
    expect(mapDepopCategory('clothing/tops/t_shirts', 'women')).toEqual({
      path: ['Womenswear', 'Tops', 'T-shirts'],
      productType: 'tshirts',
      size: 'clothing',
    });
    expect(mapDepopCategory('clothing/bottoms/joggers', 'men')).toMatchObject({
      path: ['Menswear', 'Bottoms', 'Sweatpants'],
      productType: 'joggers-tracksuits',
    });
    // An unlisted subcategory falls back to its category.
    expect(mapDepopCategory('clothing/outerwear/denim_jackets', 'men')).toMatchObject({
      path: ['Menswear', 'Coats & jackets', 'Jackets'],
      productType: null,
    });
    expect(mapDepopCategory('shoes/boots', 'women')).toMatchObject({ size: 'shoes' });
    expect(mapDepopCategory('jewelry/rings', 'women')).toMatchObject({ size: 'none' });
  });

  it('maps nothing for kids, unisex, unknown departments, and unmapped categories', () => {
    expect(mapDepopCategory('clothing/tops/t_shirts', 'kids')).toBeNull();
    expect(mapDepopCategory('clothing/tops/t_shirts', 'unisex')).toBeNull();
    expect(mapDepopCategory('clothing/tops/t_shirts', null)).toBeNull();
    expect(mapDepopCategory('home/decor', 'women')).toBeNull();
    expect(mapDepopCategory(null, 'women')).toBeNull();
  });

  it("carries only the product type ids Depop's own documentation names, and agrees with the API adapter", () => {
    const documented = new Set([
      'tshirts',
      'jeans',
      'joggers-tracksuits',
      'dresses',
      'swimsuit-one-piece',
      'boots',
      'other-accessories',
    ]);
    for (const category of mappedDepopCategories()) {
      expect(category.path, category.path.join(' > ')).toHaveLength(3);
      if (category.productType !== null) expect(documented).toContain(category.productType);
    }
    for (const [canonical, department] of [
      ['clothing/tops/t_shirts', 'men'],
      ['clothing/bottoms/jeans', 'women'],
      ['clothing/dresses/dresses', 'women'],
      ['clothing/swimwear/one_pieces', 'women'],
      ['shoes/boots', 'men'],
      ['accessories/other', 'women'],
    ] as const) {
      expect(mapDepopCategory(canonical, department)?.productType, canonical).toBe(
        depopProductType(canonical),
      );
    }
  });

  it('reads a category the listing names itself, by names or by a documented id', () => {
    expect(parseCategoryRef('Womenswear > Footwear > Boots', null)).toEqual([
      'Womenswear',
      'Footwear',
      'Boots',
    ]);
    expect(parseCategoryRef('boots', 'women')).toEqual(['Womenswear', 'Footwear', 'Boots']);
    expect(parseCategoryRef('tshirts', 'men')).toEqual(['Menswear', 'Tops', 'T-shirts']);
    for (const [bad, department] of [
      ['Womenswear > Footwear', 'women'],
      ['A > > B', 'women'],
      ['boots', null],
      ['hovercraft', 'men'],
      ['', 'men'],
    ] as const) {
      expect(parseCategoryRef(bad, department), bad).toBeNull();
    }
    expect(categorySizeKind(['Womenswear', 'Footwear', 'Boots'], null)).toBe('shoes');
    expect(categorySizeKind(['Menswear', 'Hovercraft', 'Parts'], 'clothing/tops')).toBe('clothing');
    expect(categorySizeKind(['Menswear', 'Hovercraft', 'Parts'], null)).toBe('none');
  });
});

describe('Depop conditions', () => {
  it('gives every Listora condition the Depop grade the API adapter gives it, with its label', () => {
    for (const condition of ITEM_CONDITIONS) {
      const mapped = depopFormCondition(condition);
      expect(DEPOP_CONDITIONS, condition).toContain(mapped?.value);
      expect(mapped?.label).toBe(DEPOP_CONDITION_LABELS[mapped?.value ?? 'brand_new']);
    }
    expect(depopFormCondition('new_with_tags')).toEqual({ value: 'brand_new', label: 'Brand new' });
    expect(depopFormCondition('new_with_defects')?.value).toBe('used_excellent');
    expect(depopFormCondition('pre_owned_fair')).toEqual({
      value: 'used_fair',
      label: 'Used - Fair',
    });
    expect(depopFormCondition(null)).toBeNull();
  });
});

describe('Depop sizes', () => {
  const sized = (sizeLabel: string, sizeSystem: typeof item.sizeSystem = 'us') => ({
    ...item,
    sizeLabel,
    sizeSystem,
  });

  it('spells clothing sizes the way Depop lists them', () => {
    const cases: [string, string | null][] = [
      ['Small', 'S'],
      ['md', 'M'],
      ['2XL', 'XXL'],
      ['3xl', 'XXXL'],
      ['8', 'US 8'],
      ['00', 'US 00'],
      ['W32 L30', 'W32'],
      ['32x30', 'W32'],
      ['W30', 'W30'],
      ['34', 'W34'],
      ['One Size', 'One size'],
      ['Large Tall', null],
      ['99', null],
    ];
    for (const [label, expected] of cases) {
      expect(depopSize(sized(label), 'clothing'), label).toBe(expected);
    }
    expect(depopSize({ ...sized('anything'), sizeSystem: 'one_size' }, 'clothing')).toBe(
      'One size',
    );
  });

  it('spells US shoe sizes in halves, and maps no UK or EU size', () => {
    expect(depopSize(sized('10 1/2'), 'shoes')).toBe('US 10.5');
    expect(depopSize(sized('9.5'), 'shoes')).toBe('US 9.5');
    expect(depopSize(sized('W 8'), 'shoes')).toBe('US 8');
    expect(depopSize(sized('9', 'uk'), 'shoes')).toBeNull();
    expect(depopSize(sized('42', 'eu'), 'shoes')).toBeNull();
    expect(depopSize(sized('M'), 'none')).toBeNull();
  });

  it('matches a size option that is the size, or the size and more', () => {
    expect(sizeOptionMatches('M', 'M')).toBe(true);
    expect(sizeOptionMatches('M (UK 12)', 'M')).toBe(true);
    expect(sizeOptionMatches('US 10.5', 'US 10')).toBe(false);
    expect(sizeOptionMatches('MS', 'M')).toBe(false);
  });
});

describe('Depop automation payload', () => {
  it('builds the form fields from the listing content', () => {
    expect(payload({ variant: { hashtags: ['vintage'] } })).toMatchObject({
      title: "Levi's Trucker Denim Jacket Men's M Blue",
      hashtags: ['vintage'],
      category: ['Menswear', 'Coats & jackets', 'Jackets'],
      size: 'M',
      sized: true,
      brand: "Levi's",
      condition: { value: 'used_excellent', label: 'Used - Excellent' },
    });
    expect(payload({ item: { brand: '  ' } }).brand).toBeNull();
    // The variant's own condition wins over the item's.
    expect(payload({ variant: { condition: 'new_with_tags' } }).condition?.value).toBe('brand_new');
  });

  it('writes the copy, the SKU line, then the hashtags, and reads the copy and SKU back', () => {
    const built = payload({ variant: { hashtags: ['vintage', 'denim'] } });
    const text = depopListingText(built, 'AJ-000184');
    expect(text).toBe(
      'Classic trucker jacket in medium wash. Light fading at the cuffs.\n\nSKU: AJ-000184\n\n#vintage #denim',
    );
    expect(listingCopy(text)).toEqual({ description: built.description, sku: 'AJ-000184' });
    expect(listingCopy(depopListingText({ ...built, hashtags: [] }, 'AJ-1'))).toEqual({
      description: built.description,
      sku: 'AJ-1',
    });
    expect(listingCopy('Listed by hand.\n\n#y2k')).toEqual({
      description: 'Listed by hand.',
      sku: null,
    });
  });

  it('puts prices in dollars and cents', () => {
    expect(depopPriceField(4500)).toBe('45.00');
    expect(depopPriceField(3999)).toBe('39.99');
    expect(depopPriceField(105)).toBe('1.05');
  });

  it("refuses what Depop's form refuses", () => {
    expect(validateDepopAutomationPayload(payload())).toEqual([]);
    const fields = (overrides: Parameters<typeof sampleListingContent>[0]) =>
      validateDepopAutomationPayload(payload(overrides)).map((issue) => issue.code);
    const photo = item.photos[0];
    if (photo === undefined) throw new Error('the sample has photos');
    const nine = Array.from({ length: 9 }, (_, position) => ({
      ...photo,
      photoId: `p${String(position)}`,
      position,
    }));
    expect(fields({ item: { photos: nine } })).toEqual(['too_many']);
    expect(fields({ variant: { price: { amountCents: 50, currency: 'USD' } } })).toEqual([
      'out_of_range',
    ]);
    expect(fields({ variant: { description: 'x'.repeat(930) } })).toEqual(['too_long']);
    expect(fields({ variant: { description: 'x'.repeat(929) } })).toEqual([]);
    expect(fields({ variant: { description: 'Mail me at a@b.co' } })).toEqual(['invalid']);
    expect(fields({ variant: { description: ' ' } })).toEqual(['required']);
    expect(fields({ variant: { description: 'Copy\n\n#vintage' } })).toEqual(['invalid']);
    expect(fields({ variant: { hashtags: ['not ok'] } })).toEqual(['invalid']);
    expect(fields({ variant: { hashtags: ['a', 'b', 'c', 'd', 'e', 'f'] } })).toEqual(['too_many']);
    expect(fields({ item: { department: 'kids' } })).toEqual(['required']);
    expect(fields({ item: { condition: null } })).toEqual(['required']);
    expect(fields({ item: { sizeLabel: 'Large Tall' } })).toEqual(['required']);
    expect(
      fields({ item: { department: 'women', category: 'bags/totes', sizeLabel: null } }),
    ).toEqual([]);
    for (const issue of validateDepopAutomationPayload(payload({ item: { department: null } }))) {
      expect(issue.message).toContain('Depop');
    }
  });
});

describe("Depop's site", () => {
  it('reads product slugs from paths, and never mistakes the sell page for one', () => {
    expect(slugFromPath('/products/jdoe-levis-trucker-jacket/')).toBe('jdoe-levis-trucker-jacket');
    expect(slugFromPath(DEPOP_PATHS.product('jdoe-tee-1'))).toBe('jdoe-tee-1');
    for (const path of [DEPOP_PATHS.sell, '/products/edit/jdoe-tee-1/', '/products/Jdoe-Tee/']) {
      expect(slugFromPath(path), path).toBeNull();
    }
    expect(DEPOP_SLUG.test('create')).toBe(false);
    expect(DEPOP_PATHS.selling(1)).toBe('/sellinghub/selling/');
    expect(DEPOP_PATHS.sold(3)).toBe('/sellinghub/sold-items/?page=3');
  });
});
