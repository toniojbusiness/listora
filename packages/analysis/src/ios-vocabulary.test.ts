import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MARKETPLACE_COPY_LIMITS } from './marketplace-copy.ts';
import {
  CATEGORY_TREE,
  COLORS,
  CONDITIONS,
  DEPARTMENTS,
  MATERIALS,
  PATTERNS,
  SIZE_SYSTEMS,
} from './vocabulary.ts';

/**
 * The iPhone app's review screen offers the canonical vocabulary as choices, maps spoken
 * corrections to it, and checks copy against each marketplace's limits, from its own copy of
 * them in this JSON file. This test
 * keeps that copy equal to the source of truth here. After changing the vocabulary or the
 * limits, rewrite the file with
 * `UPDATE_IOS_VOCABULARY=1 npx vitest run packages/analysis/src/ios-vocabulary.test.ts`.
 */
const IOS_VOCABULARY = fileURLToPath(
  new URL(
    '../../../apps/ios/Packages/Features/Sources/ReviewFeature/Resources/vocabulary.json',
    import.meta.url,
  ),
);

function expectedVocabulary(): string {
  const copyLimits = Object.fromEntries(
    Object.entries(MARKETPLACE_COPY_LIMITS).map(([marketplace, limits]) => [
      marketplace,
      { title: limits.title, description: limits.description, hashtags: limits.hashtags },
    ]),
  );
  const vocabulary = {
    // Arrays rather than objects, so the order survives decoding.
    categories: Object.entries(CATEGORY_TREE).map(([category, subcategories]) => ({
      category,
      subcategories,
    })),
    departments: DEPARTMENTS,
    sizeSystems: SIZE_SYSTEMS,
    colors: COLORS,
    patterns: PATTERNS,
    materials: MATERIALS,
    conditions: CONDITIONS,
    copyLimits,
  };
  return `${JSON.stringify(vocabulary, null, 2)}\n`;
}

describe("the iPhone app's vocabulary", () => {
  it('matches the canonical vocabulary and marketplace copy limits', async () => {
    const expected = expectedVocabulary();
    if (process.env['UPDATE_IOS_VOCABULARY'] === '1') await writeFile(IOS_VOCABULARY, expected);
    expect(await readFile(IOS_VOCABULARY, 'utf8')).toBe(expected);
  });
});
