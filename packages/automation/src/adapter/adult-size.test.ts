import { describe, expect, it } from 'vitest';

import { readAdultSize, type AdultSize } from './adult-size.ts';

const size = (parts: Partial<AdultSize>): AdultSize => ({
  letter: null,
  number: null,
  waist: null,
  fit: null,
  ...parts,
});

describe('readAdultSize', () => {
  it('reads petite, plus, and tall sizes in the ways tags write them', () => {
    const cases: [string, AdultSize][] = [
      ['4P', size({ number: '4', fit: 'petite' })],
      ['0p', size({ number: '0', fit: 'petite' })],
      ['6 Petite', size({ number: '6', fit: 'petite' })],
      ['S Petite', size({ letter: 'S', fit: 'petite' })],
      ['Petite M', size({ letter: 'M', fit: 'petite' })],
      ['PS', size({ letter: 'S', fit: 'petite' })],
      ['P/XS', size({ letter: 'XS', fit: 'petite' })],
      ['XSP', size({ letter: 'XS', fit: 'petite' })],
      ['16W', size({ number: '16', fit: 'plus' })],
      ['26 W', size({ number: '26', fit: 'plus' })],
      ['1X', size({ letter: 'XL', fit: 'plus' })],
      ['2x', size({ letter: 'XXL', fit: 'plus' })],
      ['0X', size({ number: '14', fit: 'plus' })],
      ['XL Plus', size({ letter: 'XL', fit: 'plus' })],
      ['18 Plus Size', size({ number: '18', fit: 'plus' })],
      ['XL Tall', size({ letter: 'XL', fit: 'tall' })],
      ['LT', size({ letter: 'L', fit: 'tall' })],
    ];
    for (const [label, expected] of cases) expect(readAdultSize(label), label).toEqual(expected);
  });

  it('reads waists in inches, a waist with a size, and drops inseam lengths', () => {
    const cases: [string, AdultSize][] = [
      ['27"', size({ waist: '27' })],
      ['27 in.', size({ waist: '27' })],
      ['27in', size({ waist: '27' })],
      ['W27', size({ waist: '27' })],
      ['Waist 30', size({ waist: '30' })],
      ['27/4', size({ waist: '27', number: '4' })],
      ['25 / 0S', size({ waist: '25', number: '0' })],
      ['0S', size({ number: '0' })],
      ['4R', size({ number: '4' })],
      ['10L', size({ number: '10' })],
      ['8 Short', size({ number: '8' })],
      ['M Long', size({ letter: 'M' })],
    ];
    for (const [label, expected] of cases) expect(readAdultSize(label), label).toEqual(expected);
  });

  it('leaves plain sizes and anything else to the marketplaces own readers', () => {
    for (const label of ['M', '8', '00', 'XXL', '32x30', '34B', '10.5', '2T', '', 'Large-ish']) {
      expect(readAdultSize(label), label).toBeNull();
    }
    expect(readAdultSize(null)).toBeNull();
    // Not a waist: out of any adult's range.
    expect(readAdultSize('12"')).toBeNull();
  });
});
