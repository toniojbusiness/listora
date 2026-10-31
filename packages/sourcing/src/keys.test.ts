import { describe, expect, it } from 'vitest';

import { brandKey, MAX_BRAND_KEY_LENGTH, sizeBucket } from './keys.ts';

describe('brandKey', () => {
  it('compares brands without case, accents, spaces, or punctuation', () => {
    expect(brandKey("Levi's")).toBe('levis');
    expect(brandKey('LEVI’S')).toBe('levis');
    expect(brandKey('  levis ')).toBe('levis');
    expect(brandKey('Agnès b.')).toBe('agnesb');
    expect(brandKey('& Other Stories')).toBe('andotherstories');
    expect(brandKey('Free People')).toBe(brandKey('free-people'));
  });

  it('keeps letters of every script and caps the length', () => {
    expect(brandKey('ユニクロ')).toBe('ユニクロ');
    expect(brandKey('a'.repeat(500))).toHaveLength(MAX_BRAND_KEY_LENGTH);
  });

  it('is null when nothing is left', () => {
    expect(brandKey(null)).toBeNull();
    expect(brandKey(undefined)).toBeNull();
    expect(brandKey('')).toBeNull();
    expect(brandKey(' - ')).toBeNull();
  });
});

describe('sizeBucket', () => {
  it('spells letter sizes short and drops case and spaces', () => {
    expect(sizeBucket('Medium')).toBe('m');
    expect(sizeBucket('M')).toBe('m');
    expect(sizeBucket('X-Large')).toBe('xl');
    expect(sizeBucket('extra small')).toBe('xs');
    expect(sizeBucket('2XL')).toBe('xxl');
    expect(sizeBucket('One Size')).toBe('os');
  });

  it('keeps other sizes as written, without spaces', () => {
    expect(sizeBucket('32 x 30')).toBe('32x30');
    expect(sizeBucket('8')).toBe('8');
    expect(sizeBucket('US 9.5')).toBe('us95');
  });

  it('is null without a size', () => {
    expect(sizeBucket(null)).toBeNull();
    expect(sizeBucket('  ')).toBeNull();
  });
});
