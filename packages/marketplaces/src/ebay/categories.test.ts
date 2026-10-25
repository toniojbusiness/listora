import { describe, expect, it } from 'vitest';

import { categoryTraits, mapEbayCategory, mappedEbayCategories } from './categories.ts';
import { fakeCategory } from './fake/taxonomy.ts';

describe('the canonical eBay category map', () => {
  it('maps the most specific canonical path, then shorter prefixes', () => {
    expect(mapEbayCategory('clothing/bottoms/jeans', 'men')?.categoryId).toBe('11483');
    expect(mapEbayCategory('clothing/bottoms/joggers', 'men')?.categoryId).toBe('57989');
    expect(mapEbayCategory('clothing/outerwear/denim_jackets', 'men')?.categoryId).toBe('57988');
    expect(mapEbayCategory('clothing/outerwear/coats', 'women')?.categoryId).toBe('63862');
    expect(mapEbayCategory('bags/totes', 'women')?.categoryId).toBe('169291');
  });

  it('maps nothing it cannot place', () => {
    expect(mapEbayCategory(null, 'men')).toBeNull();
    expect(mapEbayCategory('clothing/tops/t_shirts', 'kids')).toBeNull();
    expect(mapEbayCategory('clothing/tops/t_shirts', 'unisex')).toBeNull();
    expect(mapEbayCategory('clothing/tops/t_shirts', null)).toBeNull();
    expect(mapEbayCategory('home/decor', 'women')).toBeNull();
  });

  it("matches the fake eBay's category tree: every mapped id is a leaf with that name and branch", () => {
    for (const category of mappedEbayCategories()) {
      const leaf = fakeCategory(category.categoryId);
      expect(leaf, category.categoryId).toBeDefined();
      expect(leaf?.categoryName, category.categoryId).toBe(category.name);
      expect(leaf?.ancestors, category.categoryId).toContain(category.branch);
      const apparel = category.conditionScheme === 'apparel';
      expect(leaf?.conditionIds.includes(2990), category.categoryId).toBe(apparel);
    }
  });

  it('treats unmapped clothing and shoes like mapped ones', () => {
    expect(categoryTraits('clothing/tops/t_shirts')).toEqual({
      conditionScheme: 'apparel',
      size: 'clothing',
    });
    expect(categoryTraits('shoes/boots')).toEqual({ conditionScheme: 'general', size: 'shoes' });
    expect(categoryTraits('home/decor')).toEqual({ conditionScheme: 'general', size: 'none' });
    expect(categoryTraits(null)).toEqual({ conditionScheme: 'general', size: 'none' });
  });
});
