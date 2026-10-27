import { describe, expect, it } from 'vitest';

import { sampleListingContent } from '@listora/marketplaces/testing';

import { mercariCatalog } from './catalog/catalog.ts';
import { mercariSizeLabel } from './sizes.ts';

const item = sampleListingContent().item;
/** Mercari's size groups (catalog/catalog.json). */
const GROUP = {
  women: 1,
  men: 2,
  pants: 3,
  suits: 4,
  womenShoes: 5,
  kids: 8,
  kidsShoes: 10,
  menShoes: 11,
  bras: 12,
} as const;

const size = (
  group: keyof typeof GROUP,
  sizeLabel: string | null,
  sizeSystem: string | null = null,
) =>
  mercariSizeLabel({ ...item, sizeLabel, sizeSystem }, mercariCatalog().sizeLabels(GROUP[group]));

describe('Mercari sizes', () => {
  it('reads letter sizes by each list’s own names', () => {
    expect(size('women', 'Medium')).toBe('M (8-10)');
    expect(size('women', '2XL')).toBe('2XL (20-22)');
    expect(size('women', 'xxxl')).toBe('3XL (24-26)');
    expect(size('men', 'XXL')).toBe('XXL (50-52)');
    expect(size('men', 'Small')).toBe('S (34-36)');
    expect(size('pants', 'XXL')).toBe('2X');
    expect(size('pants', '4XL')).toBe('4XL+');
    expect(size('bras', 'M')).toBe('M');
  });

  it('reads numbers as a size itself, then as a range a size covers', () => {
    expect(size('women', '8')).toBe('M (8-10)');
    expect(size('women', '0')).toBe('XS (0-2)');
    expect(size('women', '00')).toBe('XXS (00)');
    expect(size('men', '40')).toBe('M (38-40)');
    expect(size('pants', 'W32 L30')).toBe('32 in.');
    expect(size('pants', '29')).toBe('29 in.');
    expect(size('suits', '40')).toBe('40R');
    expect(size('suits', '42L')).toBe('42L');
    expect(size('womenShoes', '8.5')).toBe('8.5 (39)');
    expect(size('womenShoes', '10 1/2')).toBe('10.5 (41)');
    expect(size('menShoes', 'US 10')).toBe('10 (43)');
    expect(size('menShoes', '5.5')).toBe('5.5 (38.5)');
    expect(size('womenShoes', '39', 'eu')).toBe('8.5 (39)');
    expect(size('womenShoes', '6', 'uk')).toBeNull();
    expect(size('kids', '6')).toBe('S (6-7)');
    expect(size('kids', '8')).toBe('M (8)');
    expect(size('kidsShoes', '1.5')).toBe('1.5');
  });

  it('reads months, toddler sizes, bras, and one size', () => {
    expect(size('kids', '6-9 months')).toBe('6-9 Months');
    expect(size('kids', '18M')).toBe('12-18 Months');
    expect(size('kids', '24 mos')).toBe('24 Months');
    expect(size('kids', 'NB')).toBe('Newborn');
    expect(size('kids', '3T')).toBe('3T');
    expect(size('bras', '34B')).toBe('34B');
    expect(size('bras', '34DD')).toBe('34E (DD)');
    expect(size('bras', '36 DDD')).toBe('36F (DDD)');
    expect(size('women', 'OS', 'one_size')).toBe('One Size');
    expect(size('men', 'one size')).toBe('One Size');
  });

  it('has no size for what no label is', () => {
    expect(size('women', null)).toBeNull();
    expect(size('women', 'chest 40')).toBeNull();
    expect(size('men', '3T')).toBeNull();
    expect(mercariSizeLabel({ ...item, sizeLabel: 'M' }, [])).toBeNull();
  });
});
