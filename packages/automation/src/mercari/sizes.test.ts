import { describe, expect, it } from 'vitest';

import { sampleListingContent } from '@listora/marketplaces/testing';

import { mercariCatalog } from './catalog/catalog.ts';
import { mercariSize, mercariSizeLabel } from './sizes.ts';

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

  it('never reads a waist as a dress size’s range', () => {
    expect(size('women', '26', 'waist_inseam')).toBeNull();
    expect(size('women', '32x30')).toBeNull();
    expect(size('pants', '26', 'waist_inseam')).toBe('26 in.');
  });
});

describe("Mercari's women's sizes, by the size list's parts", () => {
  const women = (sizeLabel: string, group: keyof typeof GROUP = 'women', sizeSystem = null) =>
    mercariSize(
      { ...item, department: 'women', sizeLabel, sizeSystem },
      mercariCatalog().sizeSets(GROUP[group]),
    );

  it('picks petite and tall sizes in their own part of the list', () => {
    expect(women('4P')).toEqual({ label: 'S (4-6)', set: 'Petite' });
    expect(women('S Petite')).toEqual({ label: 'S (4-6)', set: 'Petite' });
    expect(women('PXS')).toEqual({ label: 'XS (0-2)', set: 'Petite' });
    expect(women('XL Tall')).toEqual({ label: 'XL (16-18)', set: 'Tall' });
    expect(women('M')).toEqual({ label: 'M (8-10)', set: null });
    // Adult pants have no Petite part: the size itself.
    expect(women('27P', 'pants')).toBeNull();
    expect(women('S Petite', 'pants')).toEqual({ label: 'S', set: null });
  });

  it('reads plus sizes, inseam lengths, and waists with sizes by their parts', () => {
    expect(women('1X')).toEqual({ label: '1X (16-18)', set: null });
    expect(women('2X')).toEqual({ label: '2XL (20-22)', set: null });
    expect(women('0X')).toEqual({ label: 'L (12-14)', set: null });
    expect(women('16W')).toEqual({ label: 'XL (16-18)', set: null });
    expect(women('0S')).toEqual({ label: 'XS (0-2)', set: null });
    expect(women('8 Short')).toEqual({ label: 'M (8-10)', set: null });
    expect(women('27/4')).toEqual({ label: 'S (4-6)', set: null });
    expect(women('27/4', 'pants')).toEqual({ label: '27 in.', set: null });
    expect(women('27"', 'pants')).toEqual({ label: '27 in.', set: null });
    expect(women('27 in.', 'pants')).toEqual({ label: '27 in.', set: null });
  });

  it("gives a women's numeric size on adult pants the letter Mercari's own ranges give it", () => {
    expect(women('4', 'pants')).toEqual({ label: 'S', set: null });
    expect(women('0S', 'pants')).toEqual({ label: 'XS', set: null });
    expect(women('00', 'pants')).toEqual({ label: 'XXS and Below', set: null });
    expect(women('16W', 'pants')).toEqual({ label: 'XL', set: null });
    expect(women('13', 'pants')).toEqual({ label: 'L', set: null });
    expect(
      mercariSize(
        { ...item, department: 'men', sizeLabel: '4', sizeSystem: null },
        mercariCatalog().sizeSets(GROUP.pants),
      ),
    ).toBeNull();
  });
});
