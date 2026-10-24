import { describe, expect, it } from 'vitest';

import type { AiTier } from '@listora/ai';

import { tagFactsOf } from './prompt.ts';
import { AI_ESTIMATE_LABEL, buildAnalysisResult } from './result.ts';
import { answer, attributes, photo, tagInput } from './test-support.ts';
import type { AnalysisInput } from './input.ts';
import type { ItemAnalysisOutput } from './output-schema.ts';

function result(
  output: ItemAnalysisOutput,
  input: AnalysisInput = tagInput(),
  tier: AiTier = 'standard',
) {
  return buildAnalysisResult(output, input, tagFactsOf(input), tier);
}

/** The same item with no phone reads: everything the model says is its own reading. */
const noReads = tagInput({
  photos: [photo({ photoId: 'front' }), photo({ photoId: 'tag', role: 'tag' })],
});

describe('buildAnalysisResult provenance', () => {
  it('credits OCR and barcodes only when the phone read the value', () => {
    const read = result(answer()).details;
    expect(read.brand).toEqual({ value: "Levi's", confidence: 0.95, provenance: 'ocr' });
    expect(read.rnNumber).toMatchObject({ value: '12345', provenance: 'ocr' });
    expect(read.upc).toMatchObject({ value: '036000291452', provenance: 'barcode' });

    const unread = result(answer(), noReads).details;
    expect(unread.brand).toEqual({ value: "Levi's", confidence: 0.95, provenance: 'ai' });
    expect(unread.rnNumber).toMatchObject({ value: '12345', provenance: 'ai' });
    expect(unread.upc).toMatchObject({ value: '036000291452', provenance: 'ai' });
  });

  it('marks what the model judged from the photos as ai, whatever source it claims', () => {
    const details = result(
      answer(attributes({ department: { value: 'men', confidence: 0.9, source: 'barcode' } })),
    ).details;
    expect(details.department?.provenance).toBe('ai');
    expect(details.category).toEqual({
      value: 'clothing/bottoms/jeans',
      confidence: 0.9,
      provenance: 'ai',
    });
    expect(details.colors).toEqual({ values: ['blue'], confidence: 0.9, provenance: 'ai' });
    expect(details.condition).toEqual({
      value: 'pre_owned_good',
      confidence: 0.8,
      provenance: 'ai',
    });
    expect(details.title?.provenance).toBe('ai');
  });

  it('fills in confident tag facts the model left out, with their source', () => {
    const details = result(
      answer(
        attributes({
          rnNumber: null,
          upc: null,
          sizeLabel: null,
          sizeSystem: null,
          materials: null,
          styleNumber: null,
        }),
      ),
    ).details;
    expect(details.rnNumber).toMatchObject({ value: '12345', provenance: 'ocr' });
    expect(details.upc).toMatchObject({ value: '036000291452', provenance: 'barcode' });
    expect(details.sizeLabel).toMatchObject({ value: 'M', provenance: 'ocr' });
    expect(details.sizeSystem).toMatchObject({ value: 'letter', provenance: 'ocr' });
    expect(details.materials).toMatchObject({ values: ['cotton', 'polyester'], provenance: 'ocr' });
  });

  it('keeps a value that contradicts a confident tag fact, at a confidence that asks for review', () => {
    const details = result(
      answer(
        attributes({
          rnNumber: { value: '54321', confidence: 0.9, source: 'tag_text' },
          materials: { values: ['wool'], confidence: 0.9, source: 'photo' },
        }),
      ),
    ).details;
    expect(details.rnNumber).toEqual({ value: '54321', confidence: 0.5, provenance: 'ai' });
    expect(details.materials).toEqual({ values: ['wool'], confidence: 0.5, provenance: 'ai' });
  });

  it('puts the size in canonical form, so it agrees with the tag facts', () => {
    const spelled = result(
      answer(
        attributes({
          sizeLabel: { value: 'Medium', confidence: 0.8, source: 'tag_text' },
          sizeSystem: null,
        }),
      ),
    ).details;
    // The parsed fact confirms it, so it takes the fact's source and higher confidence.
    expect(spelled.sizeLabel).toMatchObject({ value: 'M', provenance: 'ocr' });
    expect(spelled.sizeLabel?.confidence).toBeGreaterThan(0.8);
    expect(spelled.sizeSystem).toMatchObject({ value: 'letter', provenance: 'ocr' });

    const several = result(
      answer(
        attributes({
          sizeLabel: { value: 'US 4 / UK 8 / EU 36', confidence: 0.8, source: 'tag_text' },
          sizeSystem: { value: 'uk', confidence: 0.8, source: 'tag_text' },
        }),
      ),
      noReads,
    ).details;
    expect(several.sizeLabel).toMatchObject({ value: '8', provenance: 'ai' });
    expect(several.sizeSystem).toMatchObject({ value: 'uk' });

    const unreadable = result(
      answer(attributes({ sizeLabel: { value: 'Petite', confidence: 0.5, source: 'photo' } })),
      noReads,
    ).details;
    expect(unreadable.sizeLabel).toMatchObject({ value: 'Petite' });
  });

  it('reports a UPC in its canonical 12-digit form when read as EAN-13', () => {
    const details = result(
      answer(attributes({ upc: { value: '0036000291452', confidence: 0.9, source: 'barcode' } })),
    ).details;
    expect(details.upc).toMatchObject({ value: '036000291452', provenance: 'barcode' });
  });

  it('uses a partial category path when no subcategory was chosen', () => {
    const details = result(answer(attributes({ subcategory: null }))).details;
    expect(details.category).toMatchObject({ value: 'clothing/bottoms' });
  });

  it('omits what the model did not find and no fact supports', () => {
    const empty = Object.fromEntries(Object.keys(answer().attributes).map((key) => [key, null]));
    const details = result(
      answer({ attributes: empty as ItemAnalysisOutput['attributes'] }),
      noReads,
    ).details;
    expect(Object.keys(details).sort()).toEqual(['description', 'title']);
  });
});

describe('buildAnalysisResult copy and price', () => {
  it('returns one variant per marketplace, Depop with its hashtags', () => {
    const { variants } = result(answer());
    expect(variants.map((variant) => variant.marketplace)).toEqual([
      'ebay',
      'depop',
      'poshmark',
      'mercari',
    ]);
    expect(variants[1]).toEqual({
      marketplace: 'depop',
      title: "Levi's 501s",
      description: 'Classic blue 501s, broken in just right.',
      hashtags: ['levis', 'denim', 'vintage'],
    });
  });

  it('labels the price estimate as an AI estimate in US cents, and omits a missing one', () => {
    expect(result(answer()).priceEstimate).toEqual({
      label: AI_ESTIMATE_LABEL,
      low: { amountCents: 2_000, currency: 'USD' },
      mid: { amountCents: 2_800, currency: 'USD' },
      high: { amountCents: 3_500, currency: 'USD' },
      confidence: 0.6,
    });
    expect(AI_ESTIMATE_LABEL).toBe('AI estimate - not based on sold listings');
    expect(result(answer({ priceEstimate: null }))).not.toHaveProperty('priceEstimate');
  });
});

describe('buildAnalysisResult escalation', () => {
  it('does not escalate a confident, ordinary item', () => {
    expect(result(answer())).toMatchObject({ needsEscalation: false });
    expect(result(answer())).not.toHaveProperty('escalationReason');
  });

  it('escalates an uncertain brand or product, a designer or vintage look, or when asked', () => {
    const reason = (output: ItemAnalysisOutput) => result(output).escalationReason;
    expect(
      reason(answer(attributes({ brand: { value: 'Gucci', confidence: 0.4, source: 'photo' } }))),
    ).toBe('The brand is uncertain.');
    expect(
      reason(
        answer(attributes({ productName: { value: 'Jackie', confidence: 0.3, source: 'photo' } })),
      ),
    ).toBe('The product is uncertain.');
    expect(reason(answer({ looksDesigner: true, looksVintage: true }))).toBe(
      'It looks like a designer item. It looks vintage.',
    );
    expect(
      reason(answer({ needsEscalation: true, escalationReason: 'The logo is hard to read.' })),
    ).toBe('The logo is hard to read.');
    // No brand at all is not an uncertain brand: a stronger model would not find one either.
    expect(result(answer(attributes({ brand: null })), noReads).needsEscalation).toBe(false);
  });

  it('never asks to escalate a premium analysis', () => {
    const premium = result(
      answer({ looksDesigner: true, needsEscalation: true, escalationReason: 'Still unsure.' }),
      tagInput(),
      'premium',
    );
    expect(premium.needsEscalation).toBe(false);
    expect(premium).not.toHaveProperty('escalationReason');
  });
});
