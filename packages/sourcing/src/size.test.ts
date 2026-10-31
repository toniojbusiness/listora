import { describe, expect, it } from 'vitest';

import { sizeBucket } from './size.ts';

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
