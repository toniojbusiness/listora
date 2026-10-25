import { describe, expect, it } from 'vitest';

import { sampleListingContent } from '../testing.ts';
import { ebaySize, ebaySizeSpecifics, matchAllowedValue } from './sizes.ts';

const item = (sizeLabel: string | null, sizeSystem: string | null = null) =>
  sampleListingContent({ item: { sizeLabel, sizeSystem } }).item;

describe('eBay standard sizes', () => {
  it('writes clothing sizes the way eBay does', () => {
    const cases: [string, string | null, string | null, string | null][] = [
      // label, system, Size, Size Type
      ['Small', 'letter', 'S', 'Regular'],
      ['medium', 'letter', 'M', 'Regular'],
      ['M', null, 'M', 'Regular'],
      ['XL', 'letter', 'XL', 'Regular'],
      ['2XL', 'letter', 'XXL', 'Regular'],
      ['XXXL', 'letter', '3XL', 'Regular'],
      ['MP', 'letter', 'M', 'Petite'],
      ['Medium Petite', 'letter', 'M', 'Petite'],
      ['XLT', 'letter', 'XL', 'Tall'],
      ['2X', 'letter', '2X', 'Plus'],
      ['8', 'numeric', '8', 'Regular'],
      ['00', 'numeric', '00', 'Regular'],
      ['6P', 'numeric', '6', 'Petite'],
      ['One Size', 'one_size', 'One Size', null],
      ['OS', null, 'One Size', null],
    ];
    for (const [label, system, size, sizeType] of cases) {
      expect(ebaySize(item(label, system), 'clothing'), label).toEqual({
        value: size,
        sizeType,
        inseam: null,
      });
    }
  });

  it('splits waist and inseam sizes', () => {
    for (const label of ['32x30', '32 x 30', 'W32 L30', '32/30']) {
      expect(ebaySize(item(label, 'waist_inseam'), 'clothing'), label).toEqual({
        value: '32',
        sizeType: 'Regular',
        inseam: '30 in',
      });
    }
  });

  it('writes US shoe sizes with halves, and refuses sizes it cannot convert', () => {
    expect(ebaySize(item('10 1/2', 'us'), 'shoes')?.value).toBe('10.5');
    expect(ebaySize(item('9', null), 'shoes')?.value).toBe('9');
    expect(ebaySize(item('US 11.5', 'us'), 'shoes')?.value).toBe('11.5');
    expect(ebaySize(item('42', 'eu'), 'shoes')).toBeNull();
    expect(ebaySize(item('8', 'uk'), 'shoes')).toBeNull();
  });

  it('gives no size it cannot tell', () => {
    for (const label of ['', 'Fits like a medium', 'XXXXXXL', 'N/A', 'See description']) {
      expect(ebaySize(item(label), 'clothing'), label).toBeNull();
    }
    expect(ebaySize(item('M'), 'none')).toBeNull();
    expect(ebaySizeSpecifics(item('M'), 'none')).toEqual([]);
  });

  it('names the size item specifics per kind of category', () => {
    expect(ebaySizeSpecifics(item('32x30', 'waist_inseam'), 'clothing')).toEqual([
      { name: 'Size', values: ['32'] },
      { name: 'Size Type', values: ['Regular'] },
      { name: 'Inseam', values: ['30 in'] },
    ]);
    expect(ebaySizeSpecifics(item('9.5', 'us'), 'shoes')).toEqual([
      { name: 'US Shoe Size', values: ['9.5'] },
    ]);
  });

  it("matches a size to the spelling in eBay's allowed list", () => {
    const allowed = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXXL', 'One Size', '10', '10.5'];
    expect(matchAllowedValue('M', allowed)).toBe('M');
    expect(matchAllowedValue('m', allowed)).toBe('M');
    expect(matchAllowedValue('XXL', allowed)).toBe('2XL');
    expect(matchAllowedValue('3XL', allowed)).toBe('XXXL');
    expect(matchAllowedValue('OS', allowed)).toBe('One Size');
    expect(matchAllowedValue('10.0', allowed)).toBe('10');
    expect(matchAllowedValue('XXS', allowed)).toBeNull();
    expect(matchAllowedValue('Medium-ish', allowed)).toBeNull();
  });
});
