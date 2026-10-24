import { itemConditionValues, knownMarketplaceValues } from '@listora/api-contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MARKETPLACE_COPY_LIMITS } from './marketplace-copy.ts';
import {
  decodeAnalysisAnswer,
  encodeAnalysisAnswer,
  itemAnalysisSchema,
  ITEM_ANALYSIS_OUTPUT,
  type ItemAnalysisOutput,
} from './output-schema.ts';
import { answer, attributes } from './test-support.ts';
import { CATEGORY_TREE, CONDITIONS, SUBCATEGORIES } from './vocabulary.ts';

/** What the schema says about a decoded answer, sent as the model sends it. */
function issues(output: ItemAnalysisOutput): string[] {
  return wireIssues(encodeAnalysisAnswer(output));
}

function wireIssues(answer: unknown): string[] {
  const parsed = itemAnalysisSchema.safeParse(answer);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

function variants(overrides: Partial<ItemAnalysisOutput['variants']>) {
  return answer({ variants: { ...answer().variants, ...overrides } });
}

describe('itemAnalysisSchema', () => {
  it('accepts a complete answer, and one that found nothing beyond the copy', () => {
    expect(issues(answer())).toEqual([]);
    const empty = Object.fromEntries(Object.keys(answer().attributes).map((key) => [key, null]));
    expect(issues(answer({ attributes: empty as ItemAnalysisOutput['attributes'] }))).toEqual([]);
  });

  it('travels in the prompt with its full vocabulary, and is still validated', () => {
    expect(ITEM_ANALYSIS_OUTPUT.enforcement).toBe('prompt');
    const instructions = JSON.stringify(z.toJSONSchema(itemAnalysisSchema));
    expect(instructions).toContain('"t_shirts"');
    expect(instructions).toContain('"maxLength":80');
    // Flat: every property is required and no value is a union, so an answer is easy to write.
    expect(instructions).not.toContain('anyOf');
  });

  it('decodes empty values as not found, and encodes them back', () => {
    const empty = Object.fromEntries(Object.keys(answer().attributes).map((key) => [key, null]));
    const output = answer({
      attributes: empty as ItemAnalysisOutput['attributes'],
      priceEstimate: null,
      escalationReason: null,
    });
    const wire = encodeAnalysisAnswer(output);
    expect(wire.attributes.brand).toBe('');
    expect(wire.attributes.colors).toEqual([]);
    expect(wire.priceEstimate).toEqual({ lowCents: 0, midCents: 0, highCents: 0, confidence: 0 });
    expect(decodeAnalysisAnswer(itemAnalysisSchema.parse(wire))).toEqual(output);
    expect(decodeAnalysisAnswer(itemAnalysisSchema.parse(encodeAnalysisAnswer(answer())))).toEqual(
      answer(),
    );
  });

  it("holds every variant to its marketplace's limits", () => {
    const long = (length: number) => 'x'.repeat(length);
    expect(issues(variants({ ebay: { title: long(81), description: 'ok' } })).join('\n')).toContain(
      'variants.ebay.title',
    );
    expect(issues(variants({ ebay: { title: long(80), description: 'ok' } }))).toEqual([]);
    expect(
      issues(variants({ poshmark: { title: 'ok', description: long(1_501) } })).join('\n'),
    ).toContain('variants.poshmark.description');
    expect(
      issues(variants({ mercari: { title: 'ok', description: long(1_001) } })).join('\n'),
    ).toContain('variants.mercari.description');
  });

  it("enforces Depop's description rules: hashtags count, at most five, no email", () => {
    const depop = (description: string, hashtags: string[]) =>
      issues(variants({ depop: { title: 'ok', description, hashtags } }));
    // 990 characters plus "\n\n#abc" is 996: fits. Plus "\n\n#abcdefghijk" does not.
    expect(depop('x'.repeat(990), ['abc'])).toEqual([]);
    expect(depop('x'.repeat(990), ['abcdefghijk'])).toEqual([
      'variants.depop.description: with its hashtags must fit in 1000 characters',
    ]);
    expect(depop('ok', ['a', 'b', 'c', 'd', 'e', 'f']).join('\n')).toContain(
      'variants.depop.hashtags',
    );
    expect(depop('ok', ['#y2k']).join('\n')).toContain('variants.depop.hashtags.0');
    expect(depop('Ask me at seller@example.com', [])).toEqual([
      'variants.depop.description: must not contain an email address',
    ]);
  });

  it('requires a subcategory of the chosen category', () => {
    const subcategory = (value: ItemAnalysisOutput['attributes']['subcategory']) =>
      issues(answer(attributes({ subcategory: value })));
    expect(subcategory({ value: 'sneakers', confidence: 0.9, source: 'photo' })).toEqual([
      'attributes.subcategory: sneakers is not a subcategory of clothing/bottoms',
    ]);
    expect(
      issues(
        answer(
          attributes({
            category: null,
            subcategory: { value: 'jeans', confidence: 0.9, source: 'photo' },
          }),
        ),
      ),
    ).toEqual(['attributes.subcategory: a subcategory needs its category']);
  });

  it('rejects a UPC without a valid check digit, and RN text that is not digits', () => {
    expect(
      issues(
        answer(attributes({ upc: { value: '036000291453', confidence: 1, source: 'barcode' } })),
      ),
    ).toEqual(['attributes.upc: has no valid check digit']);
    expect(
      issues(
        answer(attributes({ rnNumber: { value: 'RN 12345', confidence: 1, source: 'tag_text' } })),
      ).join('\n'),
    ).toContain('attributes.rnNumber');
  });

  it('rejects values outside the vocabulary, confidences outside 0..1, and extra keys', () => {
    expect(
      issues(
        answer(
          attributes({ colors: { values: ['teal' as 'blue'], confidence: 1, source: 'photo' } }),
        ),
      ).join('\n'),
    ).toContain('attributes.colors.0');
    expect(issues(answer({ title: { value: 'A title', confidence: 1.2 } })).join('\n')).toContain(
      'confidence.title',
    );
    expect(wireIssues({ ...encodeAnalysisAnswer(answer()), comps: [] }).join('\n')).toContain(
      'comps',
    );
  });

  it('requires a price range in order and a reason for escalating', () => {
    expect(
      issues(
        answer({
          priceEstimate: { lowCents: 3_000, midCents: 2_000, highCents: 4_000, confidence: 0.5 },
        }),
      ),
    ).toEqual(['priceEstimate: must have 1 <= lowCents <= midCents <= highCents, or all zero']);
    expect(issues(answer({ needsEscalation: true }))).toEqual([
      'escalationReason: is required when needsEscalation is true',
    ]);
  });
});

describe('vocabulary', () => {
  it("matches the contract's conditions and marketplaces", () => {
    expect([...CONDITIONS]).toEqual([...itemConditionValues]);
    expect(Object.keys(MARKETPLACE_COPY_LIMITS)).toEqual([...knownMarketplaceValues]);
  });

  it('ends every category with "other" and keeps subcategory ids unique per category', () => {
    for (const subcategories of Object.values(CATEGORY_TREE)) {
      expect(subcategories.at(-1)).toBe('other');
      expect(new Set(subcategories).size).toBe(subcategories.length);
    }
    expect(SUBCATEGORIES).toContain('t_shirts');
  });
});
