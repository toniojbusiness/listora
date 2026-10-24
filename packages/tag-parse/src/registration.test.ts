import { describe, expect, it } from 'vitest';

import { prepareLines } from './normalize.ts';
import { parseCaNumbers, parseRnNumbers } from './registration.ts';

const lines = (...texts: string[]) => prepareLines(texts.map((text) => ({ text })));
const values = (parsed: readonly { value: string }[]) => parsed.map((p) => p.value);

describe('RN numbers', () => {
  it.each([
    ['RN 12345', '12345'],
    ['RN# 123456', '123456'],
    ['RN #54321', '54321'],
    ['RN#54321', '54321'],
    ['RN: 54321', '54321'],
    ['R.N. 54321', '54321'],
    ['RN NO. 54321', '54321'],
    ['rn 54321', '54321'],
    ['MADE IN CHINA RN 77821 CA 11223', '77821'],
  ])('reads %j', (text, expected) => {
    expect(values(parseRnNumbers(lines(text)))).toEqual([expected]);
  });

  it('repairs OCR letter-for-digit misreads at lower confidence', () => {
    const [parsed] = parseRnNumbers(lines('RN#I5O722'));
    expect(parsed).toMatchObject({ value: '150722', confidence: 0.8 });
    expect(parseRnNumbers(lines('RN 150722'))[0]?.confidence).toBe(0.95);
  });

  it.each(['RN 1234', 'RN 1234567', 'PATTERN 20817', 'BRN 22145', 'RETURN 12345', 'RN SOLID'])(
    'finds nothing in %j',
    (text) => {
      expect(parseRnNumbers(lines(text))).toEqual([]);
    },
  );

  it('rejects a number that is mostly OCR lookalike letters', () => {
    expect(parseRnNumbers(lines('RN OISSB'))).toEqual([]);
  });

  it('joins a label that ends its line with the number on the next line', () => {
    const [parsed] = parseRnNumbers(lines('RN#', '41235'));
    expect(parsed).toMatchObject({
      value: '41235',
      confidence: 0.85,
      source: { kind: 'ocr', lineIndexes: [0, 1], text: 'RN#\n41235' },
    });
  });

  it('records the source line and scales confidence by the OCR line confidence', () => {
    const [parsed] = parseRnNumbers(
      prepareLines([{ text: 'BRAND' }, { text: 'RN 12345', confidence: 0.5, photoId: 'tag-1' }]),
    );
    expect(parsed).toEqual({
      value: '12345',
      confidence: 0.475,
      source: { kind: 'ocr', lineIndexes: [1], text: 'RN 12345', photoId: 'tag-1' },
    });
  });
});

describe('CA numbers', () => {
  it.each([
    ['CA 12345', '12345'],
    ['CA# 12345', '12345'],
    ['CA#12345', '12345'],
    ['CA: 12345', '12345'],
    ['CA NO. 12345', '12345'],
    ['RN 54321 CA 12345', '12345'],
    ['MADE IN USA CA 12345', '12345'],
  ])('reads %j', (text, expected) => {
    expect(values(parseCaNumbers(lines(text)))).toEqual([expected]);
  });

  it.each([
    'LOS ANGELES, CA 90012',
    'SAN FRANCISCO, CA 94105 USA',
    'SAN DIEGO CA 92101-4213',
    'OAKLAND CA 94612 U.S.A.',
    'CA 1234',
    'CARE 12345',
    'MADE IN AMERICA 12345',
  ])('finds nothing in %j', (text) => {
    expect(parseCaNumbers(lines(text))).toEqual([]);
  });

  it('keeps an address ZIP code out even when the label wraps', () => {
    expect(parseCaNumbers(lines('LOS ANGELES, CA', '90012'))).toEqual([]);
    expect(values(parseCaNumbers(lines('CA', '55103')))).toEqual(['55103']);
  });
});
