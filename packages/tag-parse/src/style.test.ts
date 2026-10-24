import { describe, expect, it } from 'vitest';

import { prepareLines } from './normalize.ts';
import { parseStyleNumbers } from './style.ts';

const stylesOf = (...texts: string[]) =>
  parseStyleNumbers(prepareLines(texts.map((text) => ({ text })))).map((parsed) => parsed.value);

describe('style numbers', () => {
  it.each([
    ['STYLE # 418722', '418722'],
    ['STYLE NO. AB1234', 'AB1234'],
    ['Style: cw2288-111', 'CW2288-111'],
    ['STYLE 4417-02', '4417-02'],
    ['ART. NO. GX4417-02', 'GX4417-02'],
    ['ITEM # 20931-004', '20931-004'],
    ['MODEL: TR-4410', 'TR-4410'],
    ['PROD. NO. DY7227-097', 'DY7227-097'],
    ['REF. M-20931', 'M-20931'],
    ['STYLE:Z-84247', 'Z-84247'],
    ['STYLE # 41872 SIZE M', '41872'],
  ])('reads %j', (text, expected) => {
    expect(stylesOf(text)).toEqual([expected]);
  });

  it('repairs misread digits but keeps a letter prefix', () => {
    const parsed = parseStyleNumbers(
      prepareLines([
        { text: 'STYLE # 41B72' },
        { text: 'ITEM # SI4205-225' },
        { text: 'PROD. NO. DY7227-O97' },
      ]),
    );
    expect(parsed.map((p) => [p.value, p.confidence])).toEqual([
      ['41872', 0.7],
      ['SI4205-225', 0.85],
      ['DY7227-097', 0.7],
    ]);
  });

  it.each([
    'STYLE MEETS COMFORT',
    'LIFESTYLE 2024',
    'REFERENCE GUIDE',
    'PRODUCT OF ITALY',
    'MODELO 12',
    'CW2288-111',
    'STYLE # A1',
  ])('finds no style number in %j', (text) => {
    expect(stylesOf(text)).toEqual([]);
  });
});
