import { describe, expect, it } from 'vitest';

import { ITEM_CONDITIONS } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { mercariCondition } from './conditions.ts';
import { parsePrice } from './pages/common.ts';
import {
  buildMercariPayload,
  MERCARI_LIMITS,
  splitSkuLine,
  validateMercariPayload,
  withSkuLine,
} from './payload.ts';
import { itemIdFromPath, MERCARI_PATHS } from './site.ts';

function payload(overrides: Parameters<typeof sampleListingContent>[0] = {}) {
  // Without the sample's `Size` aspect, which would name the size itself (the review's pick).
  const content = sampleListingContent({
    ...overrides,
    variant: { aspects: [], ...overrides.variant },
  });
  return buildMercariPayload(content.item, content.variant);
}

describe('Mercari conditions', () => {
  it('maps every canonical condition onto one of Mercari’s, never Poor', () => {
    const labels = ITEM_CONDITIONS.map((condition) => mercariCondition(condition).label);
    expect(labels).toEqual(['New', 'Like new', 'Good', 'Like new', 'Good', 'Fair']);
  });
});

describe('Mercari payload', () => {
  it("takes a Size aspect that is one of the category's labels for a tag size it doesn't have", () => {
    const sized = (tag: string, value: string) =>
      payload({
        item: { sizeLabel: tag },
        variant: { aspects: [{ name: 'Size', values: [value] }] },
      }).size;
    expect(sized('UK 14', 'XXL (50-52)')).toBe('XXL (50-52)');
    // A tag size the list has wins, and an aspect that isn't a label is nothing.
    expect(sized('M', 'XXL (50-52)')).toBe('M (38-40)');
    expect(sized('UK 14', 'Huge')).toBeNull();
  });

  it('builds the form fields purely from the listing content', () => {
    expect(payload()).toMatchObject({
      category: ['Men', 'Coats & jackets'],
      categoryId: 33,
      size: 'M (38-40)',
      sized: true,
      imei: false,
      brand: "Levi's",
      condition: { id: 2, label: 'Like new' },
      shipping: { payer: 'buyer', method: 'prepaid_label' },
      photos: [{ photoId: 'photo-front' }, { photoId: 'photo-back' }, { photoId: 'photo-tag' }],
    });
    // The variant's own condition and category win over the item's.
    expect(
      payload({ variant: { condition: 'new_with_tags', categoryRef: 'Women > Shoes > Boots' } }),
    ).toMatchObject({
      category: ['Women', 'Shoes', 'Boots'],
      condition: { label: 'New' },
      sized: true,
      size: null,
      sizeExamples: ['3.5 and below', '4 (35)', '4.5 (35)', '5 (35.5)'],
    });
    // A category whose form asks no size sends none.
    expect(
      payload({ item: { category: 'clothing/intimates', department: 'men', sizeLabel: 'XL' } }),
    ).toMatchObject({ category: ['Men', 'Other'], size: null, sized: false });
  });

  it('accepts a listing Mercari takes', () => {
    expect(validateMercariPayload(payload())).toEqual([]);
  });

  it('refuses used underwear, which Mercari prohibits, and takes new underwear', () => {
    const boxers = (condition: 'pre_owned_good' | 'new_without_tags') =>
      validateMercariPayload(
        payload({
          item: {
            category: 'clothing/intimates/underwear',
            department: 'men',
            sizeLabel: 'XL',
            condition,
          },
        }),
      );
    expect(boxers('pre_owned_good')).toEqual([
      {
        field: 'item.condition',
        code: 'not_allowed',
        message: "Mercari doesn't take used underwear.",
      },
    ]);
    expect(boxers('new_without_tags')).toEqual([]);
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
        item: { department: null, condition: null, photos: many },
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

  it('asks for five words of description, as Mercari’s form does', () => {
    expect(
      validateMercariPayload(payload({ variant: { description: 'Great jacket, barely worn' } })),
    ).toMatchObject([{ field: 'variant.description', code: 'too_short' }]);
    expect(
      validateMercariPayload(
        payload({ variant: { description: 'Great jacket, barely worn twice' } }),
      ),
    ).toEqual([]);
  });

  it('refuses what Mercari prohibits before anything is sent', () => {
    const refused = (title: string) =>
      validateMercariPayload(payload({ variant: { title } })).map((issue) => issue.message);
    expect(refused('Replica designer bag')).toEqual([
      "Mercari doesn't allow replicas, imitations, or counterfeit items (its Prohibited Items list).",
    ]);
    expect(refused('Airsoft rifle with scope')).toMatchObject([expect.stringContaining('weapons')]);
    expect(refused('Vape pen starter kit')).toMatchObject([expect.stringContaining('vaping')]);
    // Words that only look alike pass.
    expect(refused('Bomber jacket with knife pleats')).toEqual([]);
    expect(refused('Faux leather moto jacket')).toEqual([]);
  });

  it('sends a phone whose form wants its IMEI to the seller', () => {
    const phones = 'Electronics > Cell phones & accessories > Cell phones & smartphones';
    expect(validateMercariPayload(payload({ variant: { categoryRef: phones } }))).toMatchObject([
      { field: 'variant.categoryRef', code: 'not_supported' },
    ]);
    expect(validateMercariPayload({ ...payload(), imei: true })).toMatchObject([
      { field: 'variant.categoryRef', code: 'not_supported' },
    ]);
  });

  it("asks girls' or boys' for a kids' item it can't tell, naming both", () => {
    const issues = validateMercariPayload(
      payload({ item: { category: 'clothing/tops/t_shirts', department: 'kids', sizeLabel: '6' } }),
    );
    expect(issues).toEqual([
      {
        field: 'variant.categoryRef',
        code: 'required',
        message:
          "Mercari files kids' items as girls' or boys'. Choose 'Kids > Girls tops & t-shirts > Girls (4+)' or 'Kids > Boys tops & t-shirts > Boys (4+)'.",
      },
    ]);
    expect(
      validateMercariPayload(
        payload({
          item: { category: 'clothing/tops/t_shirts', department: 'kids', sizeLabel: '6' },
          variant: { categoryRef: 'Kids > Girls tops & t-shirts > Girls (4+)' },
        }),
      ),
    ).toEqual([]);
  });

  it('keeps room for the SKU line within Mercari’s description limit', () => {
    const room = MERCARI_LIMITS.descriptionMaxLength - '\n\nSKU: '.length - 64;
    const words = (length: number) => 'd '.repeat(length).slice(0, length);
    const fits = payload({ variant: { description: words(room) } });
    expect(validateMercariPayload(fits)).toEqual([]);
    expect(withSkuLine(fits.description, 'S'.repeat(64)).length).toBeLessThanOrEqual(
      MERCARI_LIMITS.descriptionMaxLength,
    );
    const over = payload({ variant: { description: words(room + 1) } });
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
