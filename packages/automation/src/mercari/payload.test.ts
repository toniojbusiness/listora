import { describe, expect, it } from 'vitest';

import { ITEM_CONDITIONS } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { mapMercariCategory, mappedMercariCategories, parseCategoryRef } from './categories.ts';
import { mercariCondition } from './conditions.ts';
import { parsePrice } from './pages/common.ts';
import {
  buildMercariPayload,
  MERCARI_LIMITS,
  splitSkuLine,
  validateMercariPayload,
  withSkuLine,
} from './payload.ts';
import { SHIPPING_WEIGHTS } from './shipping.ts';
import { itemIdFromPath, MERCARI_PATHS } from './site.ts';
import { mercariSize, sizeOptionMatches } from './sizes.ts';

const item = sampleListingContent().item;

function payload(overrides: Parameters<typeof sampleListingContent>[0] = {}) {
  const content = sampleListingContent(overrides);
  return buildMercariPayload(content.item, content.variant);
}

describe('Mercari categories', () => {
  it('maps by the most specific canonical path, per department', () => {
    expect(mapMercariCategory('clothing/tops/t_shirts', 'women')?.path).toEqual([
      'Women',
      'Tops & blouses',
      'T-shirts',
    ]);
    expect(mapMercariCategory('clothing/tops/t_shirts', 'men')?.path).toEqual([
      'Men',
      'Tops',
      'T-shirts',
    ]);
    // An unlisted subcategory falls back to its category.
    expect(mapMercariCategory('clothing/outerwear/denim_jackets', 'men')).toMatchObject({
      path: ['Men', 'Coats & jackets'],
      size: 'clothing',
    });
    expect(mapMercariCategory('shoes/boots', 'women')).toMatchObject({ size: 'shoes' });
    expect(mapMercariCategory('jewelry/rings', 'women')).toMatchObject({ size: 'none' });
  });

  it('maps nothing for kids, unisex, unknown departments, and unmapped categories', () => {
    expect(mapMercariCategory('clothing/tops/t_shirts', 'kids')).toBeNull();
    expect(mapMercariCategory('clothing/tops/t_shirts', 'unisex')).toBeNull();
    expect(mapMercariCategory('clothing/tops/t_shirts', null)).toBeNull();
    expect(mapMercariCategory('home/decor', 'women')).toBeNull();
    expect(mapMercariCategory(null, 'women')).toBeNull();
  });

  it('gives every mapped category two or three levels and a shipping weight Mercari offers', () => {
    for (const category of mappedMercariCategories()) {
      expect(category.path.length, category.path.join(' > ')).toBeGreaterThanOrEqual(2);
      expect(category.path.length).toBeLessThanOrEqual(3);
      expect(SHIPPING_WEIGHTS).toContain(category.weight);
    }
  });

  it('reads a category the listing names itself', () => {
    expect(parseCategoryRef('Women > Shoes > Boots')).toEqual(['Women', 'Shoes', 'Boots']);
    expect(parseCategoryRef(' Men>Jeans ')).toEqual(['Men', 'Jeans']);
    for (const bad of ['Women', 'A > > B', 'A > B > C > D', '']) {
      expect(parseCategoryRef(bad), bad).toBeNull();
    }
  });
});

describe('Mercari conditions and sizes', () => {
  it('maps every canonical condition onto one of Mercari’s, never Poor', () => {
    const labels = ITEM_CONDITIONS.map((condition) => mercariCondition(condition).label);
    expect(labels).toEqual(['New', 'Like new', 'Good', 'Like new', 'Good', 'Fair']);
  });

  it('spells sizes the way Mercari’s size lists do', () => {
    const size = (sizeLabel: string, kind: 'clothing' | 'shoes', sizeSystem = 'us') =>
      mercariSize({ ...item, sizeLabel, sizeSystem }, kind);
    expect(size('Small', 'clothing')).toBe('S');
    expect(size('2XL', 'clothing')).toBe('XXL');
    expect(size('xxxl', 'clothing')).toBe('3XL');
    expect(size('8', 'clothing')).toBe('8');
    expect(size('W32 L30', 'clothing')).toBe('32');
    expect(size('32x34', 'clothing')).toBe('32');
    expect(size('OS', 'clothing')).toBe('One size');
    expect(size('10 1/2', 'shoes')).toBe('10.5');
    expect(size('US 9', 'shoes')).toBe('9');
    expect(size('42', 'shoes', 'eu')).toBeNull();
    expect(size('chest 40', 'clothing')).toBeNull();
    expect(mercariSize({ ...item, sizeLabel: 'M' }, 'none')).toBeNull();
  });

  it('matches a size option by its own label or a label that starts with it', () => {
    expect(sizeOptionMatches('M', 'M')).toBe(true);
    expect(sizeOptionMatches('M (8-10)', 'M')).toBe(true);
    expect(sizeOptionMatches('MP', 'M')).toBe(false);
    expect(sizeOptionMatches('10.5', '10')).toBe(false);
  });
});

describe('Mercari payload', () => {
  it('builds the form fields purely from the listing content', () => {
    expect(payload()).toMatchObject({
      category: ['Men', 'Coats & jackets'],
      size: 'M',
      sized: true,
      brand: "Levi's",
      condition: { id: 2, label: 'Like new' },
      shipping: { payer: 'buyer', method: 'prepaid_label', weight: '3 lb' },
      photos: [{ photoId: 'photo-front' }, { photoId: 'photo-back' }, { photoId: 'photo-tag' }],
    });
    // The variant's own condition and category win over the item's.
    expect(
      payload({ variant: { condition: 'new_with_tags', categoryRef: 'Women > Shoes > Boots' } }),
    ).toMatchObject({
      category: ['Women', 'Shoes', 'Boots'],
      condition: { label: 'New' },
      shipping: { weight: '5 lb' },
      sized: true,
      size: null,
    });
  });

  it('accepts a listing Mercari takes', () => {
    expect(validateMercariPayload(payload())).toEqual([]);
  });

  it('refuses what Mercari’s form would, naming Mercari', () => {
    const many = Array.from({ length: 13 }, (_, position) => ({
      photoId: `p${String(position)}`,
      position,
      role: 'detail' as const,
      url: `https://media.listora.test/p/${String(position)}.jpg`,
    }));
    const issues = validateMercariPayload(
      payload({
        item: { category: 'home/decor', condition: null, photos: many },
        variant: {
          title: 'x'.repeat(81),
          description: ' ',
          price: { amountCents: 4550, currency: 'USD' },
        },
      }),
    );
    expect(issues.map((issue) => `${issue.field}:${issue.code}`)).toEqual([
      'variant.title:too_long',
      'variant.description:required',
      'variant.price:invalid',
      'item.photos:too_many',
      'variant.categoryRef:required',
      'item.condition:required',
    ]);
    for (const issue of issues) expect(issue.message).toContain('Mercari');
  });

  it('keeps room for the SKU line within Mercari’s description limit', () => {
    const room = MERCARI_LIMITS.descriptionMaxLength - '\n\nSKU: '.length - 64;
    const fits = payload({ variant: { description: 'd'.repeat(room) } });
    expect(validateMercariPayload(fits)).toEqual([]);
    expect(withSkuLine(fits.description, 'S'.repeat(64)).length).toBeLessThanOrEqual(
      MERCARI_LIMITS.descriptionMaxLength,
    );
    const over = payload({ variant: { description: 'd'.repeat(room + 1) } });
    expect(validateMercariPayload(over)).toMatchObject([
      { field: 'variant.description', code: 'too_long' },
    ]);
  });

  it('refuses prices outside $1 to $2,000 and sizes it cannot match', () => {
    const range = (amountCents: number) =>
      validateMercariPayload(payload({ variant: { price: { amountCents, currency: 'USD' } } }));
    expect(range(200_100)).toMatchObject([{ code: 'out_of_range' }]);
    expect(range(200_000)).toEqual([]);
    expect(range(100)).toEqual([]);
    expect(validateMercariPayload(payload({ item: { sizeLabel: null } }))).toMatchObject([
      { field: 'item.sizeLabel', code: 'required' },
    ]);
    expect(
      validateMercariPayload(payload({ item: { category: 'jewelry/rings', sizeLabel: null } })),
    ).toEqual([]);
  });
});

describe('the SKU line', () => {
  it('ends a description and is split off a shown one again', () => {
    const shown = withSkuLine('Classic jacket.\n\nLight fading.', 'AJ-000184');
    expect(shown).toBe('Classic jacket.\n\nLight fading.\n\nSKU: AJ-000184');
    expect(splitSkuLine(shown)).toEqual({
      description: 'Classic jacket.\n\nLight fading.',
      sku: 'AJ-000184',
    });
    // A page that collapsed the blank line, and trailing whitespace.
    expect(splitSkuLine('Jacket.\nSKU: AJ-1 \n')).toEqual({ description: 'Jacket.', sku: 'AJ-1' });
    expect(splitSkuLine('Jacket without a line.')).toEqual({
      description: 'Jacket without a line.',
      sku: null,
    });
    // A SKU mentioned mid-text is not the line.
    expect(splitSkuLine('SKU: AJ-1 is in the photo.').sku).toBeNull();
  });
});

describe('Mercari pages', () => {
  it('reads prices as Mercari shows them', () => {
    expect(parsePrice('$45')).toBe(4500);
    expect(parsePrice('$1,250')).toBe(125_000);
    expect(parsePrice('$45.50')).toBe(4550);
    expect(parsePrice('45')).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  it('knows a listing address by its id, and nothing else', () => {
    expect(MERCARI_PATHS.item('m12345678901')).toBe('/us/item/m12345678901/');
    expect(itemIdFromPath('/us/item/m12345678901/')).toBe('m12345678901');
    expect(itemIdFromPath('/us/item/m12345678901')).toBe('m12345678901');
    expect(itemIdFromPath('/us/item/12345/')).toBeNull();
    expect(itemIdFromPath('/mypage/')).toBeNull();
    expect(MERCARI_PATHS.listings('inactive', 2)).toBe('/mypage/listings/inactive/?page=2');
  });
});
