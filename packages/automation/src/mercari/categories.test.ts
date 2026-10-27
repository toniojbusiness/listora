import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { mappedMercariCategories } from './categories.ts';

/**
 * Mercari's men's and women's category trees as its sell form's dialog shows them, read on the
 * seller's own session (2026-10-27): top level, then each category's subcategories.
 */
const TREE = JSON.parse(
  readFileSync(new URL('__golden__/category-tree.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, string[]>>;

describe('the Mercari category map', () => {
  it('names only categories Mercari offers, each one the form can pick', () => {
    const missing = mappedMercariCategories().flatMap(({ path }) => {
      const [top = '', category = '', subcategory] = path;
      const children = TREE[top]?.[category];
      if (children === undefined) return [path.join(' > ')];
      // A category with subcategories is picked whole through its "All <category>" row.
      const leaf = subcategory ?? `All ${category}`;
      return children.includes(leaf) ? [] : [path.join(' > ')];
    });
    expect(missing).toEqual([]);
  });
});
