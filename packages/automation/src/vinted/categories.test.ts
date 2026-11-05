import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { mappedVintedPaths, matchVintedCategory, parseVintedCategoryRef } from './categories.ts';

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
) as { categories: { category: string; subcategories: string[] }[] };

const CANONICAL = VOCABULARY.categories.flatMap(({ category, subcategories }) => [
  category,
  ...subcategories.map((subcategory) => `${category}/${subcategory}`),
]);

const words = { title: 'Invented item', productName: null };
const path = (canonical: string, department: string, title = 'Invented item') => {
  const match = matchVintedCategory(canonical, department, { title, productName: null });
  return match.type === 'mapped' ? match.path.join(' > ') : match.type;
};

describe('the Vinted category map', () => {
  it("names only categories without subcategories, under Vinted's Women and Men", () => {
    for (const named of mappedVintedPaths()) {
      const parts = named.split(' > ');
      expect(parts.length, named).toBeGreaterThanOrEqual(3);
      expect(['Women', 'Men'], named).toContain(parts[0]);
      expect(
        parts.every((part) => part.trim() === part && part !== ''),
        named,
      ).toBe(true);
    }
  });

  it("places women's, men's, and unisex clothing, shoes, bags, accessories, and jewelry", () => {
    const placed = CANONICAL.filter((canonical) =>
      /^(clothing|shoes|bags|accessories|jewelry)(\/|$)/.test(canonical),
    );
    const unplaced = ['women', 'men', 'unisex'].flatMap((department) =>
      placed
        .filter(
          (canonical) => matchVintedCategory(canonical, department, words).type === 'unmapped',
        )
        .map((canonical) => `${department} ${canonical}`),
    );
    // Vinted lists no shoes without a kind (no "Other shoes"), and no men's heels: the seller
    // picks one.
    expect(unplaced).toEqual([
      'women shoes',
      'women shoes/other',
      'men shoes',
      'men shoes/heels',
      'men shoes/other',
      'unisex shoes',
      'unisex shoes/other',
    ]);
  });

  it('maps by the most specific canonical path, per department', () => {
    expect(path('clothing/tops/t_shirts', 'women')).toBe(
      'Women > Clothing > Tops & T-shirts > T-shirts',
    );
    expect(path('clothing/tops/t_shirts', 'men')).toBe(
      'Men > Clothing > Tops & T-shirts > T-shirts > Other T-shirts',
    );
    // An unlisted subcategory falls back to its category.
    expect(path('clothing/tops/polos', 'women')).toBe(
      'Women > Clothing > Tops & T-shirts > Other tops & t-shirts',
    );
    expect(path('clothing/outerwear/denim_jackets', 'men')).toBe(
      'Men > Clothing > Outerwear > Jackets > Denim jackets',
    );
  });

  it("files jackets and coats by the kind the item's words name, else asks", () => {
    expect(path('clothing/outerwear/jackets', 'women', 'Levi’s Denim Trucker Jacket')).toBe(
      'Women > Clothing > Outerwear > Jackets > Denim jackets',
    );
    expect(path('clothing/outerwear/coats', 'men', 'Wool Trench Coat')).toBe(
      'Men > Clothing > Outerwear > Coats > Trench coats',
    );
    const unnamed = matchVintedCategory('clothing/outerwear/jackets', 'women', words);
    expect(unnamed.type).toBe('by_kind');
    expect(unnamed.type === 'by_kind' && unnamed.examples.length).toBe(3);
  });

  it("files unisex items as men's, but the kinds Vinted keeps under Women", () => {
    expect(path('clothing/tops/hoodies_sweatshirts', 'unisex')).toBe(
      'Men > Clothing > Sweaters & sweatshirts > Hoodies & sweatshirts',
    );
    expect(path('clothing/dresses', 'unisex')).toBe('Women > Clothing > Dresses > Other dresses');
    expect(path('bags/totes', 'unisex')).toBe('Women > Bags > Tote bags');
  });

  it("leaves kids', home, and other items to the seller", () => {
    expect(path('clothing/tops/t_shirts', 'kids')).toBe('unmapped');
    expect(path('home/decor', 'women')).toBe('unmapped');
    expect(path('clothing/tops', null as unknown as string)).toBe('unmapped');
    expect(matchVintedCategory(null, 'women', words)).toEqual({ type: 'unmapped' });
  });

  it('reads a category a listing names itself, and refuses what is not one', () => {
    expect(parseVintedCategoryRef('Women > Clothing > Dresses > Mini-dresses')).toEqual([
      'Women',
      'Clothing',
      'Dresses',
      'Mini-dresses',
    ]);
    expect(parseVintedCategoryRef('Home>Decor >  Vases')).toEqual(['Home', 'Decor', 'Vases']);
    expect(parseVintedCategoryRef('Women')).toBeNull();
    expect(parseVintedCategoryRef('Women >  > Dresses')).toBeNull();
    expect(parseVintedCategoryRef('1904')).toBeNull();
  });
});
