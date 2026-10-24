import { describe, expect, it } from 'vitest';

import type { AiTier } from '@listora/ai';

import { tagFactsOf } from './prompt.ts';
import { AI_ESTIMATE_LABEL, buildAnalysisResult } from './result.ts';
import { answer, attributes, photo, tagInput } from './test-support.ts';
import type { AnalysisInput } from './input.ts';
import type { ItemAnalysisOutput } from './output-schema.ts';

function built(
  output: ItemAnalysisOutput,
  input: AnalysisInput = tagInput(),
  tier: AiTier = 'standard',
) {
  return buildAnalysisResult(output, input, tagFactsOf(input), tier);
}

function result(
  output: ItemAnalysisOutput,
  input: AnalysisInput = tagInput(),
  tier: AiTier = 'standard',
) {
  return built(output, input, tier).result;
}

/** The same front photo with a tag photo whose phone reads are `lines`. */
function readingTag(...lines: string[]): AnalysisInput {
  return tagInput({
    photos: [
      photo({ photoId: 'front' }),
      photo({
        photoId: 'tag',
        role: 'tag',
        ocrLines: lines.map((text) => ({ text, confidence: 0.95 })),
      }),
    ],
  });
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

  it('credits OCR only when whole words of a line spell the value', () => {
    const read = (value: string, ...lines: string[]) =>
      result(
        answer(attributes({ brand: { value, confidence: 0.9, source: 'tag_text' } })),
        readingTag(...lines),
      ).details.brand?.provenance;
    expect(read('Gap', 'MADE IN SINGAPORE')).toBe('ai');
    expect(read('Gap', 'GAP KIDS')).toBe('ocr');
    expect(read("Levi's", 'LEVIS STRAUSS & CO')).toBe('ocr');
    expect(read('Tommy Hilfiger', 'TOMMY', 'HILFIGER')).toBe('ai');
    expect(read('Tommy Hilfiger', 'TOMMY-HILFIGER')).toBe('ocr');

    const size = (value: string, ...lines: string[]) =>
      result(
        answer(
          attributes({
            sizeLabel: { value, confidence: 0.9, source: 'tag_text' },
            sizeSystem: null,
          }),
        ),
        readingTag(...lines),
      ).details.sizeLabel?.provenance;
    expect(size('S', 'MADE IN USA', 'MACHINE WASH')).toBe('ai');
    expect(size('S', 'TALLA S')).toBe('ocr');
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

  it('agrees with a tag listing a lining or trim fiber the materials leave out', () => {
    const shell = (values: ItemAnalysisOutput['attributes']['materials']) =>
      result(
        answer(attributes({ materials: values })),
        readingTag('SHELL: 100% NYLON', 'LINING: 100% POLYESTER'),
      ).details.materials;
    expect(shell({ values: ['nylon'], confidence: 0.8, source: 'tag_text' })).toEqual({
      values: ['nylon'],
      confidence: expect.any(Number) as unknown,
      provenance: 'ocr',
    });
    expect(shell({ values: ['nylon', 'polyester'], confidence: 0.8, source: 'tag_text' })).toEqual(
      expect.objectContaining({ provenance: 'ocr' }),
    );
    // Leaving out the shell's fiber, or naming one not on the tag, still contradicts it.
    expect(shell({ values: ['polyester'], confidence: 0.8, source: 'tag_text' })).toEqual({
      values: ['polyester'],
      confidence: 0.5,
      provenance: 'ai',
    });
    expect(shell({ values: ['nylon', 'wool'], confidence: 0.8, source: 'tag_text' })).toEqual(
      expect.objectContaining({ confidence: 0.5, provenance: 'ai' }),
    );
    // Filled in from the facts, the shell comes first.
    expect(shell(null)).toEqual(
      expect.objectContaining({ values: ['nylon', 'polyester'], provenance: 'ocr' }),
    );
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
    expect(built(answer())).toEqual({
      result: expect.objectContaining({ needsEscalation: false }) as unknown,
      autoEscalate: false,
    });
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
    expect(
      built(answer(attributes({ brand: { value: 'Gucci', confidence: 0.4, source: 'photo' } })))
        .autoEscalate,
    ).toBe(true);
  });

  it("does not repeat a rule's reason the model already gave", () => {
    const output = answer({
      ...attributes({ brand: { value: 'Gucci', confidence: 0.45, source: 'photo' } }),
      needsEscalation: true,
      escalationReason: 'the brand is uncertain.',
      looksVintage: true,
    });
    expect(result(output).escalationReason).toBe('the brand is uncertain. It looks vintage.');
  });

  it('suggests, but does not start, a premium identification for an unidentified brand', () => {
    // Many items are unbranded: the user decides whether a premium call is worth it.
    const unbranded = built(answer(attributes({ brand: null })), noReads);
    expect(unbranded.result).toMatchObject({
      needsEscalation: true,
      escalationReason: 'The brand was not identified.',
    });
    expect(unbranded.autoEscalate).toBe(false);
    // Most secondhand items show no product name: its absence alone suggests nothing.
    expect(built(answer(attributes({ productName: null })))).toEqual({
      result: expect.objectContaining({ needsEscalation: false }) as unknown,
      autoEscalate: false,
    });
    // Another reason still starts it.
    const vintage = built(answer({ ...attributes({ brand: null }), looksVintage: true }), noReads);
    expect(vintage.result.escalationReason).toBe('The brand was not identified. It looks vintage.');
    expect(vintage.autoEscalate).toBe(true);
  });

  it('never asks to escalate a premium analysis', () => {
    const premium = result(
      answer({ looksDesigner: true, needsEscalation: true, escalationReason: 'Still unsure.' }),
      tagInput(),
      'premium',
    );
    expect(premium.needsEscalation).toBe(false);
    expect(premium).not.toHaveProperty('escalationReason');
    expect(built(answer({ looksDesigner: true }), tagInput(), 'premium').autoEscalate).toBe(false);
  });
});
