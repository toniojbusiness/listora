/**
 * The fake eBay's category tree: a fixture of eBay US leaf categories (taxonomy.json) with
 * their ancestors, the condition ids each accepts, and their item aspects, in the shape of the
 * Taxonomy API's `getCategorySuggestions` and `getItemAspectsForCategory`. Suggestions match
 * the query's words against each category's names and keywords, the way eBay's keyword
 * suggestions behave for clear queries.
 */
import { readFileSync } from 'node:fs';

export interface FakeAspect {
  name: string;
  required: boolean;
  mode: 'FREE_TEXT' | 'SELECTION_ONLY';
  cardinality: 'SINGLE' | 'MULTI';
  /** Allowed values (all of them for `SELECTION_ONLY`; suggestions for `FREE_TEXT`). */
  values: string[];
  maxLength: number;
}

export interface FakeCategory {
  categoryId: string;
  categoryName: string;
  /** Ancestor names from the immediate parent up to the top level (the root is left out). */
  ancestors: string[];
  conditionIds: number[];
  keywords: string[];
  aspects: FakeAspect[];
}

const FIXTURE_URL = new URL('taxonomy.json', import.meta.url);

let loaded: readonly FakeCategory[] | undefined;

export function fakeCategories(): readonly FakeCategory[] {
  loaded ??= JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as FakeCategory[];
  return loaded;
}

export function fakeCategory(categoryId: string): FakeCategory | undefined {
  return fakeCategories().find((category) => category.categoryId === categoryId);
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

/** Categories for a keyword query, best match first (at most 10, like eBay's list). */
export function suggestCategories(query: string): FakeCategory[] {
  const asked = new Set(words(query));
  return fakeCategories()
    .map((category) => {
      const own = new Set(
        [category.categoryName, ...category.ancestors.slice(0, 2), ...category.keywords].flatMap(
          words,
        ),
      );
      const score = [...asked].filter((word) => own.has(word)).length;
      return { category, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ category }) => category);
}
