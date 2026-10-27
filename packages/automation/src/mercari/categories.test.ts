import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  kidsAge,
  mapMercariCategory,
  mappedMercariCategories,
  mappedMercariPaths,
  matchMercariCategory,
  parseCategoryRef,
} from './categories.ts';
import { mercariCatalog } from './catalog/catalog.ts';

/**
 * Listora's canonical vocabulary, as the analysis package writes it for the iPhone app
 * (packages/analysis/src/ios-vocabulary.test.ts keeps the file equal to the vocabulary).
 */
const VOCABULARY = JSON.parse(
  readFileSync(
    new URL(
      '../../../../apps/ios/Packages/Features/Sources/ReviewFeature/Resources/vocabulary.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { categories: { category: string; subcategories: string[] }[]; departments: string[] };

const CANONICAL = VOCABULARY.categories.flatMap(({ category, subcategories }) => [
  category,
  ...subcategories.map((subcategory) => `${category}/${subcategory}`),
]);

const path = (canonical: string, department: string, size: string | null = null) => {
  const match = matchMercariCategory(canonical, department, size);
  return match.type === 'mapped' ? match.category.path.join(' > ') : match.type;
};

describe('the Mercari category map', () => {
  it("names only categories in Mercari's catalog", () => {
    const missing = mappedMercariPaths().filter(
      (named) => mercariCatalog().find(named.split(' > ')) === null,
    );
    expect(missing).toEqual([]);
  });

  it('places every canonical category for every department', () => {
    const unplaced = VOCABULARY.departments.flatMap((department) =>
      CANONICAL.filter((canonical) => matchMercariCategory(canonical, department).type === 'unmapped').map(
        (canonical) => `${department} ${canonical}`,
      ),
    );
    expect(unplaced).toEqual([]);
  });

  it('maps by the most specific canonical path, per department', () => {
    expect(path('clothing/tops/t_shirts', 'women')).toBe('Women > Tops & blouses > T-shirts');
    expect(path('clothing/tops/t_shirts', 'men')).toBe('Men > Tops > T-shirts');
    // An unlisted subcategory falls back to its category.
    expect(path('clothing/outerwear/denim_jackets', 'men')).toBe('Men > Coats & jackets');
    expect(path('clothing/bottoms/jeans', 'women')).toBe('Women > Jeans');
    // Mercari's men's tree has no underwear: Other, whose form asks no size.
    expect(path('clothing/intimates', 'men')).toBe('Men > Other');
    expect(mapMercariCategory('clothing/intimates', 'men')?.sizeGroupId).toBeNull();
  });

  it("files unisex items under Men, but under Women what Mercari has only for women", () => {
    expect(path('clothing/tops/hoodies_sweatshirts', 'unisex')).toBe('Men > Sweats & hoodies');
    expect(path('shoes/sneakers', 'unisex')).toBe('Men > Shoes > Athletic');
    expect(path('clothing/dresses', 'unisex')).toBe('Women > Dresses');
    expect(path('bags/totes', 'unisex')).toBe("Women > Women's handbags > Tote Bags");
  });

  it('files home and other items by kind, whatever the department', () => {
    expect(path('home/decor', 'women')).toBe('Home > Home decor > Home decor accents');
    expect(path('home/kitchen', 'kids')).toBe('Home > Kitchen & dining > Other');
    expect(path('other/other', 'men')).toBe('Other > Other');
  });

  it("files kids' items by age, and by girls or boys when the kind tells", () => {
    expect(path('clothing/dresses', 'kids', '4T')).toBe('Kids > Girls dresses > Girls 2T-5T');
    expect(path('clothing/dresses', 'kids', '6-9 months')).toBe(
      'Kids > Girls dresses > Girls 0-24 mos',
    );
    expect(path('clothing/swimwear/swim_trunks', 'kids', '8')).toBe(
      'Kids > Boys swimwear > Boys (4+)',
    );
    // One-pieces stop at 5T: an older kid's romper is in the other kinds.
    expect(path('clothing/dresses/jumpsuits_rompers', 'kids', '10')).toBe('choose');
    const tee = matchMercariCategory('clothing/tops/t_shirts', 'kids', 'M');
    expect(tee).toMatchObject({ type: 'choose' });
    expect(tee.type === 'choose' ? tee.options.map((option) => option.path.join(' > ')) : []).toEqual([
      'Kids > Girls tops & t-shirts > Girls (4+)',
      'Kids > Boys tops & t-shirts > Boys (4+)',
    ]);
    // The List flow then suggests nothing: the seller picks.
    expect(mapMercariCategory('clothing/tops/t_shirts', 'kids')).toBeNull();
    expect(kidsAge('2T')).toBe('2T-5T');
    expect(kidsAge('NB')).toBe('0-24 mos');
    expect(kidsAge('18M')).toBe('0-24 mos');
    expect(kidsAge('10-12')).toBe('(4+)');
    expect(kidsAge(null)).toBe('(4+)');
  });

  it('maps nothing without a department or a category', () => {
    expect(path('clothing/tops/t_shirts', 'pets')).toBe('unmapped');
    expect(mapMercariCategory('clothing/tops/t_shirts', null)).toBeNull();
    expect(mapMercariCategory(null, 'women')).toBeNull();
  });

  it('offers every Mercari category below its departments to pick from', () => {
    const offered = mappedMercariCategories();
    expect(offered.length).toBe(mercariCatalog().byId.size - mercariCatalog().departments.length);
    expect(offered.every((category) => category.path.length >= 2)).toBe(true);
  });

  it("reads a category the listing names itself, if Mercari's catalog has it", () => {
    expect(parseCategoryRef('Women > Shoes > Boots')).toMatchObject({
      path: ['Women', 'Shoes', 'Boots'],
      sizeGroupId: 5,
    });
    expect(parseCategoryRef(' Electronics>Cameras & photography ')?.path).toEqual([
      'Electronics',
      'Cameras & photography',
    ]);
    for (const bad of ['Women', 'A > > B', 'Women > Shoes > Moon boots', 'Women > Tops > T-shirts', '']) {
      expect(parseCategoryRef(bad), bad).toBeNull();
    }
  });
});
