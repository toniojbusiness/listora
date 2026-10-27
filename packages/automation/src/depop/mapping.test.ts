import { describe, expect, it } from 'vitest';

import { CATEGORY_TREE, COLORS, MATERIALS } from '@listora/analysis';
import { DEPOP_CONDITIONS, ITEM_CONDITIONS } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { marketplaceCategories } from '../categories.ts';
import { DEPOP_COLOURS, DEPOP_MATERIALS, depopDetails } from './attributes.ts';
import { allDepopCategories, mapDepopCategory, parseCategoryRef } from './categories.ts';
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
import {
  DEPOP_TAXONOMY,
  depopAttribute,
  depopProductType,
  depopProductTypes,
  isBannedDepopHashtag,
} from './taxonomy/taxonomy.ts';

const item = sampleListingContent().item;

function payload(overrides: Parameters<typeof sampleListingContent>[0] = {}) {
  const content = sampleListingContent(overrides);
  return buildDepopAutomationPayload(content.item, content.variant);
}

describe("Depop's taxonomy", () => {
  it('holds every department, category, and product type of the sell form, with its sizes', () => {
    expect(DEPOP_TAXONOMY.departments.map((department) => department.name)).toEqual([
      'Men',
      'Women',
      'Kids',
      'Everything else',
    ]);
    expect(depopProductTypes().length).toBeGreaterThan(250);
    const tee = depopProductType('menswear', 'tops', 'tshirts');
    expect(tee?.sizes).toContain('3XL');
    expect(tee?.productType.attributes).toContain('material');
    expect(depopProductType('everything-else', 'home', 'decor-home-accesories')?.sizes).toEqual([]);
    // Every size list a product type names is there.
    for (const type of depopProductTypes()) {
      if (type.productType.sizeSet !== null)
        expect(type.sizes.length, type.productType.id).toBeGreaterThan(0);
    }
    expect(isBannedDepopHashtag('Poshmark')).toBe(true);
    expect(isBannedDepopHashtag('vintage')).toBe(false);
  });
});

describe('Depop categories', () => {
  const departments = ['men', 'women', 'kids', 'unisex'] as const;
  /** Canonical categories Depop has no product type for in a department. */
  const NONE: Record<(typeof departments)[number], readonly string[]> = {
    men: [
      'clothing/bottoms/skirts',
      'clothing/dresses',
      'clothing/dresses/dresses',
      'clothing/dresses/other',
      'clothing/activewear/sports_bras',
      'clothing/swimwear/one_pieces',
      'clothing/swimwear/bikinis',
      'clothing/intimates/bras',
      'clothing/intimates/shapewear',
      'shoes/heels',
    ],
    women: [],
    kids: [
      'clothing/activewear/sports_bras',
      'clothing/intimates',
      'clothing/intimates/bras',
      'clothing/intimates/underwear',
      'clothing/intimates/shapewear',
      'clothing/intimates/socks',
      'clothing/intimates/other',
      'clothing/suits_sets',
      'clothing/suits_sets/suits',
      'clothing/suits_sets/matching_sets',
      'clothing/suits_sets/other',
    ],
    unisex: [],
  };
  NONE.unisex = NONE.men;
  const canonical = Object.entries(CATEGORY_TREE).flatMap(([category, subcategories]) => [
    category,
    ...subcategories.map((subcategory) => `${category}/${subcategory}`),
  ]);

  it('maps every canonical category, in every department, to a product type Depop offers there', () => {
    for (const department of departments) {
      for (const path of canonical) {
        if (path === 'other' || path === 'other/other') continue;
        const mapped = mapDepopCategory(path, department);
        if (NONE[department].includes(path)) {
          expect(mapped, `${department} ${path}`).toBeNull();
          continue;
        }
        expect(mapped, `${department} ${path}`).not.toBeNull();
        const [top = '', group = '', type = ''] = mapped?.ids ?? [];
        expect(depopProductType(top, group, type), `${department} ${path}`).not.toBeNull();
      }
    }
  });

  it("puts women's items in Women, men's and unisex ones in Men, kids' in Kids, home in Everything else", () => {
    expect(mapDepopCategory('clothing/tops/t_shirts', 'women')).toMatchObject({
      ids: ['womenswear', 'tops', 'tshirts'],
      path: ['Women', 'Tops', 'T-shirts'],
    });
    expect(mapDepopCategory('clothing/tops/t_shirts', 'unisex')?.path).toEqual([
      'Men',
      'Tops',
      'T-shirts',
    ]);
    expect(mapDepopCategory('clothing/tops/t_shirts', 'kids')?.path).toEqual([
      'Kids',
      'Tops',
      'T-shirts',
    ]);
    expect(mapDepopCategory('home/kitchen', 'women')?.path).toEqual([
      'Everything else',
      'Home',
      'Dinnerware',
    ]);
    expect(mapDepopCategory('home/decor', null)?.path).toEqual([
      'Everything else',
      'Home',
      'Home accessories',
    ]);
    // The first product type the department offers: men's tops have no Blouses.
    expect(mapDepopCategory('clothing/tops/blouses', 'men')?.path).toEqual([
      'Men',
      'Tops',
      'Shirts',
    ]);
    expect(mapDepopCategory('clothing/intimates/underwear', 'men')?.path).toEqual([
      'Men',
      'Underwear',
      'Boxers and briefs',
    ]);
    expect(mapDepopCategory('clothing/intimates/underwear', 'women')?.path).toEqual([
      'Women',
      'Underwear',
      'Panties',
    ]);
    // The most specific entry wins, and a path Listora doesn't know falls back to its parent.
    expect(mapDepopCategory('clothing/outerwear/denim_jackets', 'men')?.path).toEqual([
      'Men',
      'Coats and jackets',
      'Jackets',
    ]);
    expect(mapDepopCategory('clothing/tops/t_shirts', null)).toBeNull();
    expect(mapDepopCategory('other/other', 'women')).toBeNull();
    expect(mapDepopCategory(null, 'women')).toBeNull();
  });

  it('reads a category the listing names, by names, by ids, or by product type id', () => {
    const boots = ['Women', 'Footwear', 'Boots'];
    expect(parseCategoryRef('Women > Footwear > Boots', null)?.path).toEqual(boots);
    expect(parseCategoryRef('womenswear > footwear > boots', null)?.path).toEqual(boots);
    // A listing saved with Depop's former department names still reads.
    expect(parseCategoryRef('Menswear > Tops > T-shirts', null)?.path).toEqual([
      'Men',
      'Tops',
      'T-shirts',
    ]);
    expect(parseCategoryRef('womenswear/footwear/boots', null)?.path).toEqual(boots);
    expect(parseCategoryRef('boots', 'women')?.path).toEqual(boots);
    expect(parseCategoryRef('makeup', 'women')?.path).toEqual([
      'Everything else',
      'Beauty',
      'Makeup',
    ]);
    expect(parseCategoryRef('Everything else > Beauty > Makeup', null)?.sizes).toEqual([]);
    for (const [bad, department] of [
      ['Women > Footwear', null],
      ['Women > Hovercraft > Parts', null],
      ['menswear/tops/blouses', null],
      ['boots', null],
      ['hovercraft', 'women'],
      ['', 'women'],
    ] as const) {
      expect(parseCategoryRef(bad, department), bad).toBeNull();
    }
  });

  it("offers every product type in the List flow's picker, and suggests unisex items' Men category", () => {
    expect(allDepopCategories()).toHaveLength(depopProductTypes().length);
    const unisex = marketplaceCategories('depop', {
      category: 'clothing/tops/t_shirts',
      department: 'unisex',
    });
    expect(unisex?.suggested).toEqual({
      ref: 'Men > Tops > T-shirts',
      path: ['Men', 'Tops', 'T-shirts'],
    });
    expect(unisex?.choices.map((choice) => choice.ref)).toContain(
      'Everything else > Beauty > Makeup',
    );
    expect(parseCategoryRef(unisex?.suggested?.ref ?? '', 'unisex')?.ids).toEqual([
      'menswear',
      'tops',
      'tshirts',
    ]);
  });
});

describe('Depop details', () => {
  it("maps every Listora colour, and the materials Depop lists, to Depop's own values", () => {
    for (const colour of COLORS) {
      expect(
        depopAttribute('colour')?.values.map((value) => value.id),
        colour,
      ).toContain(DEPOP_COLOURS[colour]);
    }
    const materials = depopAttribute('material')?.values.map((value) => value.id) ?? [];
    for (const [own, id] of Object.entries(DEPOP_MATERIALS)) {
      expect(MATERIALS as readonly string[], own).toContain(own);
      expect(materials, own).toContain(id);
    }
  });

  it('picks up to 2 colours, and the material where the product type offers one', () => {
    const tee = {
      ...item,
      colors: ['gray', 'navy', 'red'],
      materials: ['cotton', 'spandex', 'metal'],
    };
    expect(depopDetails(tee, ['material'])).toEqual([
      { field: 'colour', values: ['Grey', 'Navy'] },
      { field: 'attributes.material', values: ['Cotton', 'Elastane / Lycra / Spandex'] },
    ]);
    expect(depopDetails(tee, [])).toEqual([{ field: 'colour', values: ['Grey', 'Navy'] }]);
    expect(depopDetails({ ...item, colors: [], materials: [] }, ['material'])).toEqual([]);
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
  const listOf = (department: string, group: string, type: string) =>
    depopProductType(department, group, type)?.sizes ?? [];
  const mensTops = listOf('menswear', 'tops', 'tshirts');
  const mensBottoms = listOf('menswear', 'bottoms', 'jeans');
  const womensTops = listOf('womenswear', 'tops', 'blouses');
  const womensBottoms = listOf('womenswear', 'bottoms', 'skirts');
  const kids = listOf('kidswear', 'tops', 'tshirts');

  it("picks the label the product type's own size list has", () => {
    const cases: [string, readonly string[], string | null][] = [
      ['Small', mensTops, 'S'],
      ['md', mensTops, 'M'],
      ['2XL', mensTops, 'XXL'],
      ['XXXL', mensTops, '3XL'],
      ['3xl', mensTops, '3XL'],
      ['8', womensTops, '8'],
      ['00', womensTops, '00'],
      ['8', mensTops, null],
      ['W32 L30', mensBottoms, '32"'],
      ['32x30', mensBottoms, '32"'],
      ['34', mensBottoms, '34"'],
      ['28', womensBottoms, '28'],
      ['One Size', mensTops, 'One size'],
      ['8', kids, '8 years'],
      ['2T', kids, '2 years'],
      ['6-9M', kids, '6-9 months'],
      ['34B', listOf('womenswear', 'underwear', 'bras'), '34B'],
      ['Large Tall', mensTops, null],
      ['99', mensBottoms, null],
    ];
    for (const [label, sizes, expected] of cases) {
      expect(depopSize(sized(label), sizes), label).toBe(expected);
    }
    expect(depopSize(sized('28', 'waist_inseam'), womensBottoms)).toBe('28"');
    expect(depopSize({ ...sized('anything'), sizeSystem: 'one_size' }, mensTops)).toBe('One size');
    expect(depopSize(sized('M'), [])).toBeNull();
  });

  it('spells US shoe sizes in halves, kids shoe sizes in their ranges, and maps no UK or EU size', () => {
    const shoes = listOf('menswear', 'footwear', 'trainers');
    expect(depopSize(sized('10 1/2'), shoes)).toBe('US 10.5');
    expect(depopSize(sized('9.5'), shoes)).toBe('US 9.5');
    expect(depopSize(sized('W 8'), listOf('womenswear', 'footwear', 'boots'))).toBe('US 8');
    expect(depopSize(sized('9', 'uk'), shoes)).toBeNull();
    expect(depopSize(sized('42', 'eu'), shoes)).toBeNull();
    const kidsShoes = listOf('kidswear', 'footwear', 'trainers');
    expect(depopSize(sized('9.5'), kidsShoes)).toBe('9-9.5');
    expect(depopSize(sized('11'), kidsShoes)).toBe('11');
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
      category: ['Men', 'Coats and jackets', 'Jackets'],
      categoryIds: ['menswear', 'coats-jackets', 'jackets'],
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
    expect(fields({ item: { department: null } })).toEqual(['required']);
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
    expect(DEPOP_PATHS.sold(3)).toBe('/sellinghub/sold-items/?page=3');
  });
});
