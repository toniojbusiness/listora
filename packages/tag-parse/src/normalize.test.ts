import { describe, expect, it } from 'vitest';

import { editDistance, normalizeText, repairDigits, repairLetters } from './normalize.ts';

describe('normalizeText', () => {
  it('reduces accents, compatibility forms, symbols, dashes, and spacing', () => {
    expect(normalizeText('  Algodón  100％  ')).toBe('ALGODON 100%');
    expect(normalizeText('Fabriqué en Chine')).toBe('FABRIQUE EN CHINE');
    expect(normalizeText('Lycra®  Spandex')).toBe('LYCRA SPANDEX');
    expect(normalizeText('CW2288–111')).toBe('CW2288-111');
  });
});

describe('repairDigits', () => {
  it('undoes letter-for-digit confusions when most characters are digits', () => {
    expect(repairDigits('I5O72')).toEqual({ text: '15072', repaired: true });
    expect(repairDigits('12345')).toEqual({ text: '12345', repaired: false });
  });

  it('refuses words and characters it cannot map', () => {
    expect(repairDigits('SOLID')).toBeNull();
    expect(repairDigits('12A45')).toBeNull();
  });
});

describe('repairLetters', () => {
  it('undoes digit-for-letter confusions in mostly alphabetic words only', () => {
    expect(repairLetters('C0TTON')).toEqual({ text: 'COTTON', repaired: true });
    expect(repairLetters('CW2288')).toEqual({ text: 'CW2288', repaired: false });
  });
});

describe('editDistance', () => {
  it('counts edits and stops early past the limit', () => {
    expect(editDistance('COTTON', 'COTTON', 1)).toBe(0);
    expect(editDistance('COTTOH', 'COTTON', 1)).toBe(1);
    expect(editDistance('COTON', 'COTTON', 1)).toBe(1);
    expect(editDistance('NYLON', 'COTTON', 1)).toBe(2);
  });
});
