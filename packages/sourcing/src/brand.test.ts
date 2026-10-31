import { describe, expect, it } from 'vitest';

import { brandKey } from './brand.ts';

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
