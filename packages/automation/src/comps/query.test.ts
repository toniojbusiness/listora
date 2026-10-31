import { describe, expect, it } from 'vitest';

import { comparisonQuery, comparisonQueryKey, type ComparisonItem } from './query.ts';

const jeans: ComparisonItem = {
  brand: "Levi's",
  item: 'light wash straight jeans',
  line: '501',
  category: 'clothing/bottoms/jeans',
  department: 'women',
  sizeLabel: 'W28',
};

describe('comparisonQuery', () => {
  it('searches the brand, model, and type as a buyer types them, matching Depop types', () => {
    expect(comparisonQuery('depop', jeans)).toEqual({
      words: 'levis 501 jeans',
      brand: "Levi's",
      model: '501',
      sizeLabel: 'W28',
      productTypes: ['jeans'],
      typeWords: ['jeans'],
    });
  });

  it('never searches a brand alone: no query without a brand or a category', () => {
    expect(comparisonQuery('depop', { ...jeans, brand: null })).toBeNull();
    expect(comparisonQuery('depop', { ...jeans, brand: '  ' })).toBeNull();
    expect(comparisonQuery('depop', { ...jeans, category: null })).toBeNull();
  });

  it("tries every department's type when the read could not tell whose it is", () => {
    const tee = comparisonQuery('depop', {
      ...jeans,
      brand: 'Nike',
      item: 'swoosh tee',
      line: null,
      category: 'clothing/tops/t_shirts',
      department: null,
      sizeLabel: null,
    });
    expect(tee).toMatchObject({ words: 'nike shirts', model: null, sizeLabel: null });
    expect(tee?.productTypes).toEqual(['tshirts']);
    expect(tee?.typeWords).toEqual(['shirts', 'tee']);
  });
});

describe('comparisonQueryKey', () => {
  it('is one key for one search, whatever its spelling, and another for another size', () => {
    const query = comparisonQuery('depop', jeans);
    const same = comparisonQuery('depop', { ...jeans, brand: "LEVI'S", item: 'jeans' });
    const other = comparisonQuery('depop', { ...jeans, sizeLabel: 'W30' });
    if (query === null || same === null || other === null) throw new Error('no query');
    expect(comparisonQueryKey('depop', query)).toMatch(/^[0-9a-f]{64}$/);
    expect(comparisonQueryKey('depop', same)).toBe(comparisonQueryKey('depop', query));
    expect(comparisonQueryKey('depop', other)).not.toBe(comparisonQueryKey('depop', query));
  });
});
