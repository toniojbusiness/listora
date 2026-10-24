import { describe, expect, it } from 'vitest';

import { isValidGtin, normalizeText } from '@listora/tag-parse';

import { FONT_CHARACTERS } from './font.ts';
import { GENERATED_CASES, buildCorpusSpecs } from './generate.ts';
import { TAG_KINDS } from './types.ts';

const specs = buildCorpusSpecs();
const printedText = (spec: (typeof specs)[number]) =>
  spec.printed.map((block) => ('text' in block ? block.text : block.barcode)).join('\n');

describe('corpus generator', () => {
  it('is reproducible from its seed and changes with the seed', () => {
    expect(buildCorpusSpecs()).toEqual(specs);
    expect(buildCorpusSpecs(1, 5)).not.toEqual(buildCorpusSpecs(2, 5));
  });

  it('builds the generated cases plus the edge cases with unique ids and every kind', () => {
    expect(specs.length).toBeGreaterThan(GENERATED_CASES);
    expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length);
    expect(new Set(specs.map((spec) => spec.kind))).toEqual(new Set(TAG_KINDS));
  });

  it('prints only characters the font can draw', () => {
    const font = new Set(FONT_CHARACTERS);
    for (const spec of specs) {
      for (const block of spec.printed) {
        if (!('text' in block)) continue;
        for (const char of block.text) expect(font.has(char), `${spec.id}: ${char}`).toBe(true);
      }
    }
  });

  it('prints every ground-truth number on the tag', () => {
    for (const spec of specs) {
      const printed = normalizeText(printedText(spec)).replace(/ /g, '');
      for (const value of [...spec.truth.rn, ...spec.truth.ca]) {
        expect(printed, spec.id).toContain(value);
      }
      for (const gtin of spec.truth.gtin) {
        expect(isValidGtin(gtin.digits), spec.id).toBe(true);
        expect(printed, spec.id).toContain(gtin.digits.slice(1));
      }
      for (const style of spec.truth.style) expect(printed, spec.id).toContain(style);
    }
  });

  it('keeps every fiber part composition at 100%', () => {
    for (const spec of specs) {
      const totals = new Map<string, number>();
      for (const fiber of spec.truth.fiber) {
        const part = fiber.part ?? '-';
        totals.set(part, (totals.get(part) ?? 0) + fiber.percent);
      }
      for (const [part, total] of totals) expect(total, `${spec.id} ${part}`).toBe(100);
    }
  });

  it('includes negative cases: invalid barcodes and tags without registration numbers', () => {
    const invalidBarcodes = specs.filter((spec) =>
      spec.printed.some((block) => 'barcode' in block && !isValidGtin(block.barcode)),
    );
    expect(invalidBarcodes.length).toBeGreaterThan(0);
    for (const spec of invalidBarcodes) expect(spec.ocr.barcodes, spec.id).toEqual([]);
    expect(specs.filter((spec) => spec.truth.rn.length === 0).length).toBeGreaterThan(20);
  });

  it('applies OCR noise to a realistic share of lines', () => {
    const lines = specs.flatMap((spec) => spec.ocr.lines);
    const noisy = lines.filter((line) => line.confidence !== 1);
    expect(noisy.length / lines.length).toBeGreaterThan(0.1);
    expect(noisy.length / lines.length).toBeLessThan(0.5);
  });
});
