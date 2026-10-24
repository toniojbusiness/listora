import { describe, expect, it } from 'vitest';

import { emptyTagValues, parseTagText, valuesOf } from './parse.ts';
import { TAG_FIELDS } from './types.ts';

describe('parseTagText', () => {
  it('extracts every field from a full care label', () => {
    const facts = parseTagText({
      lines: [
        { text: 'NORTHWIND APPAREL' },
        { text: 'STYLE # CW2288-111' },
        { text: 'SIZE M' },
        { text: '60% COTTON 40% POLYESTER' },
        { text: 'MADE IN VIET NAM' },
        { text: 'RN 123456 CA 54321' },
        { text: 'MACHINE WASH COLD' },
        { text: 'LOS ANGELES, CA 90012' },
      ],
      barcodes: [{ payload: '0036000291452', symbology: 'VNBarcodeSymbologyEAN13' }],
    });
    expect(valuesOf(facts)).toEqual({
      rn: ['123456'],
      ca: ['54321'],
      gtin: [{ format: 'upc_a', digits: '036000291452' }],
      size: [{ system: 'letter', value: 'M' }],
      fiber: [
        { part: null, material: 'cotton', percent: 60 },
        { part: null, material: 'polyester', percent: 40 },
      ],
      origin: ['VN'],
      style: ['CW2288-111'],
    });
  });

  it('returns empty fields for empty input', () => {
    expect(valuesOf(parseTagText({ lines: [] }))).toEqual(emptyTagValues());
    expect(Object.keys(emptyTagValues())).toEqual([...TAG_FIELDS]);
  });

  it('keeps the barcode as the source when its printed digits are also read', () => {
    const facts = parseTagText({
      lines: [{ text: '0 36000 29145 2' }],
      barcodes: [{ payload: '0036000291452', symbology: 'VNBarcodeSymbologyEAN13' }],
    });
    expect(facts.gtin).toHaveLength(1);
    expect(facts.gtin[0]).toMatchObject({ confidence: 0.99, source: { kind: 'barcode' } });
  });

  it('keeps the most confident source for a repeated value and ranks by confidence', () => {
    const facts = parseTagText({
      lines: [{ text: 'M' }, { text: 'SIZE M' }, { text: 'US 8' }],
    });
    expect(facts.size.map((parsed) => [parsed.value.value, parsed.confidence])).toEqual([
      ['M', 0.9],
      ['8', 0.9],
    ]);
    expect(facts.size[0]?.source).toMatchObject({ lineIndexes: [1] });
  });

  it('is deterministic', () => {
    const input = {
      lines: [{ text: 'RN#I5O72' }, { text: '100% C0TTON' }, { text: 'MADE IN CH1NA' }],
    };
    expect(parseTagText(input)).toEqual(parseTagText(input));
  });

  it('reads accented and full-width OCR output', () => {
    const facts = valuesOf(
      parseTagText({ lines: [{ text: '95％ Algodón 5％ Elastano' }, { text: 'Hecho en México' }] }),
    );
    expect(facts.fiber).toEqual([
      { part: null, material: 'cotton', percent: 95 },
      { part: null, material: 'spandex', percent: 5 },
    ]);
    expect(facts.origin).toEqual(['MX']);
  });

  it('treats non-finite OCR confidence as zero instead of propagating NaN', () => {
    const facts = parseTagText({ lines: [{ text: 'RN 12345', confidence: Number.NaN }] });
    expect(facts.rn[0]?.confidence).toBe(0);
  });
});
