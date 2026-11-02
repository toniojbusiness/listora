import { describe, expect, it } from 'vitest';

import { brandKey, snapBrand } from './brand.ts';

describe('brandKey', () => {
  it.each([
    ['Abercrombie & Fitch', 'abercrombie'],
    ['abercrombie and fitch', 'abercrombie'],
    ['Abercrombie', 'abercrombie'],
    ["Levi's", 'levi'],
    ['LEVI', 'levi'],
    ['Levis', 'levi'],
    ['Hollister Co.', 'hollister'],
    ['Chloé', 'chloe'],
    ['American Eagle Outfitters', 'american eagle'],
    ['Old Navy', 'old navy'],
    ['The North Face', 'north'],
  ])('keys %s as %s', (brand, key) => {
    expect(brandKey(brand)).toBe(key);
  });

  it('keeps brands that share a common first word apart', () => {
    expect(brandKey('American Eagle')).not.toBe(brandKey('American Apparel'));
    expect(brandKey('Free People')).not.toBe(brandKey('Free Assembly'));
  });

  it('has no key for an empty brand', () => {
    expect(brandKey(null)).toBeUndefined();
    expect(brandKey(undefined)).toBeUndefined();
    expect(brandKey(' & ')).toBeUndefined();
  });
});

describe('snapBrand', () => {
  const own = ['Fernhill', 'Fernhill', 'FERNHILL', 'Quillonade', 'Marrow & Pike', 'Ostra', null];

  it('snaps a near miss to the one own brand it nearly spells, in the spelling used most', () => {
    expect(snapBrand('Fernhil', own)).toEqual({ brand: 'Fernhill', readAs: 'Fernhil' });
    expect(snapBrand('Quillonda', own)).toEqual({ brand: 'Quillonade', readAs: 'Quillonda' });
    expect(snapBrand('Marow', own)).toEqual({ brand: 'Marrow & Pike', readAs: 'Marow' });
  });

  it('leaves a read that already matches an own brand, or none, as it is', () => {
    expect(snapBrand('FERNHILL', own)).toBeUndefined();
    expect(snapBrand('Marrow and Pike', own)).toBeUndefined();
    expect(snapBrand(null, own)).toBeUndefined();
    expect(snapBrand('Fernhil', [])).toBeUndefined();
  });

  it('never snaps a short name, a far one, or one that is near two own brands', () => {
    // "Ostr" and "Ostra" are a letter apart, but four-letter names are too easily another brand.
    expect(snapBrand('Ostr', own)).toBeUndefined();
    expect(snapBrand('Ferngully', own)).toBeUndefined();
    expect(snapBrand('Brightun', ['Brighton', 'Brightan'])).toBeUndefined();
    expect(snapBrand('Brightun', ['Brighton'])).toEqual({ brand: 'Brighton', readAs: 'Brightun' });
  });

  it('holds a long name to two edits', () => {
    expect(snapBrand('Quillonadexx', own)).toEqual({ brand: 'Quillonade', readAs: 'Quillonadexx' });
    expect(snapBrand('Quillonadexxx', own)).toBeUndefined();
  });
});
