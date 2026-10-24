import { describe, expect, it } from 'vitest';

import { prepareLines } from './normalize.ts';
import { matchCountry, parseOrigins } from './origin.ts';

const originsOf = (...texts: string[]) =>
  parseOrigins(prepareLines(texts.map((text) => ({ text })))).map((parsed) => parsed.value);

describe('country of origin', () => {
  it.each([
    ['MADE IN CHINA', ['CN']],
    ['Made in Viet Nam', ['VN']],
    ['MADE IN VIETNAM', ['VN']],
    ['MADE IN P.R.C.', ['CN']],
    ['MADE IN THE USA', ['US']],
    ['MADE IN U.S.A. OF IMPORTED MATERIALS', ['US']],
    ['MADE IN UNITED STATES', ['US']],
    ['MADE IN SOUTH KOREA', ['KR']],
    ['MADE IN SRI LANKA', ['LK']],
    ['MADE IN EL SALVADOR', ['SV']],
    ['MADE IN TURKIYE', ['TR']],
    ['MADEIN CHINA', ['CN']],
    ['Productof Bangladesh', ['BD']],
    ['PRODUCT OF ITALY', ['IT']],
    ['ASSEMBLED IN MEXICO', ['MX']],
    ['HECHO EN MEXICO', ['MX']],
    ['Hecho en México', ['MX']],
    ['FABRIQUE EN CHINE', ['CN']],
    ['FABRIQUÉ AU CANADA', ['CA']],
    ['FATTO IN ITALIA', ['IT']],
    ['HERGESTELLT IN DEUTSCHLAND', ['DE']],
    ['MADE IN CHINA RN 12345', ['CN']],
    ['MADE IN CHINA / FABRIQUE EN CHINE / HECHO EN CHINA', ['CN', 'CN', 'CN']],
  ])('reads %j', (text, expected) => {
    expect(originsOf(text)).toEqual(expected);
  });

  it('continues a phrase that ends its line onto the next line', () => {
    const parsed = parseOrigins(prepareLines([{ text: 'MADE IN' }, { text: 'VIET NAM' }]));
    expect(parsed).toEqual([
      {
        value: 'VN',
        confidence: 0.85,
        source: { kind: 'ocr', lineIndexes: [0, 1], text: 'MADE IN\nVIET NAM' },
      },
    ]);
  });

  it('accepts one OCR misread in a country name at lower confidence', () => {
    const parsed = parseOrigins(
      prepareLines([{ text: 'MADE IN CH1NA' }, { text: 'MADE IN INDOMESIA' }]),
    );
    expect(parsed.map((p) => [p.value, p.confidence])).toEqual([
      ['CN', 0.8],
      ['ID', 0.8],
    ]);
  });

  it.each([
    'DESIGNED IN CALIFORNIA',
    'IMPORTED',
    'MADE IN',
    'MADE IN CXQNA',
    'MADE WITH LOVE',
    'MADE IN HEAVEN',
  ])('finds no origin in %j', (text) => {
    expect(originsOf(text)).toEqual([]);
  });

  it('matches a country name directly, ignoring an article and what follows it', () => {
    expect(matchCountry('THE U.S.A. OF IMPORTED FABRIC')).toEqual({
      code: 'US',
      approximate: false,
    });
    expect(matchCountry('INDIE')).toEqual({ code: 'IN', approximate: true });
    expect(matchCountry('IRAN')).toBeNull();
  });
});
