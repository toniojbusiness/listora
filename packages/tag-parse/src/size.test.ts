import { describe, expect, it } from 'vitest';

import { prepareLines } from './normalize.ts';
import { parseSizes } from './size.ts';

const sizesOf = (...texts: string[]) =>
  parseSizes(prepareLines(texts.map((text) => ({ text })))).map(
    (parsed) => `${parsed.value.system}:${parsed.value.value}`,
  );

describe('size parsing', () => {
  it.each([
    ['SIZE M', ['letter:M']],
    ['Size: xl', ['letter:XL']],
    ['TALLA/SIZE/TAILLE: L', ['letter:L']],
    ['M', ['letter:M']],
    ['S/P/CH', ['letter:S']],
    ['M (8-10)', ['letter:M']],
    ['XL TALL', ['letter:XL']],
    ['SIZE MEDIUM', ['letter:M']],
    ['SIZE X-LARGE', ['letter:XL']],
    ['SIZE EXTRA LARGE', ['letter:XL']],
    ['2XL', ['letter:XXL']],
    ['SIZE 8', ['numeric:8']],
    ['SIZE: 00', ['numeric:00']],
    ['TALLA 10', ['numeric:10']],
    ['8', ['numeric:8']],
    ['US 8 / UK 12 / EU 40', ['us:8', 'uk:12', 'eu:40']],
    ['US 9.5 UK 8.5 EUR 43', ['us:9.5', 'uk:8.5', 'eu:43']],
    ['US: 10,5', ['us:10.5']],
    ['38 EU', ['eu:38']],
    ['W32 L30', ['waist_inseam:32x30']],
    ['32W 30L', ['waist_inseam:32x30']],
    ['W32/L34', ['waist_inseam:32x34']],
    ['WAIST 36 INSEAM 28', ['waist_inseam:36x28']],
    ['32X34', ['waist_inseam:32x34']],
    ['SIZE: 30 x 32', ['waist_inseam:30x32']],
    ['ONE SIZE', ['one_size:OS']],
    ['ONE SIZE FITS MOST', ['one_size:OS']],
    ['O/S', ['one_size:OS']],
    ['SIZE: OS', ['one_size:OS']],
    ['SIZE M MADE IN CHINA RN 41235', ['letter:M']],
    ['5XL', ['letter:5XL']],
    ['SIZE: 0S', ['one_size:OS']],
    ['X5', ['letter:XS']],
    ['5', ['numeric:5']],
    ['U5 0 / UK 4 / EU 32', ['us:0', 'uk:4', 'eu:32']],
    ['US 4 UK 8EU 36', ['us:4', 'uk:8', 'eu:36']],
    ['_M (8-10)', ['letter:M']],
    ['US 10.5 M', ['us:10.5']],
    ['US 10.5M', ['us:10.5']],
    ['US 9 W', ['us:9']],
    ['US 11 D / UK 10.5 / EU 45', ['us:11', 'uk:10.5', 'eu:45']],
    ['SIZE US 8 M', ['us:8']],
    ['US 7 2E', ['us:7']],
    ['42 EU N', ['eu:42']],
  ])('reads %j', (text, expected) => {
    expect(sizesOf(text)).toEqual(expected);
  });

  it.each([
    'XL ATHLETICS',
    'FITS LIKE A LARGE',
    'SMALL BATCH COFFEE',
    'MADE IN CHINA',
    '100% COTTON',
    'PRICE $24',
    '30',
    '10 X 12 IN BOX',
    'US 99',
    'EU 2023',
    'MADE IN USA 12345',
    'OVERSIZED FIT',
    '50',
  ])('finds no size in %j', (text) => {
    expect(sizesOf(text)).toEqual([]);
  });

  it('labels the next line when the label stands alone', () => {
    const parsed = parseSizes(prepareLines([{ text: 'TALLA/SIZE' }, { text: 'M' }]));
    expect(parsed[0]).toMatchObject({
      value: { system: 'letter', value: 'M' },
      confidence: 0.9,
      source: { lineIndexes: [0, 1] },
    });
  });

  it('gives weaker evidence lower confidence', () => {
    const confidence = (text: string) =>
      parseSizes(prepareLines([{ text }]))[0]?.confidence ?? Number.NaN;
    expect(confidence('SIZE M')).toBe(0.9);
    expect(confidence('M')).toBe(0.8);
    expect(confidence('32X30')).toBe(0.75);
    expect(confidence('8')).toBe(0.6);
  });
});
