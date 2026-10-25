/**
 * The eBay automation adapter's mapping tables and payload: conditions by kind of category, the
 * payload as the eBay API adapter builds it (so either mode makes the same listing), eBay's
 * validation, and how the scripts read eBay's prices, times, and addresses.
 */
import { describe, expect, it } from 'vitest';

import { buildEbayPayload, type ItemCondition } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { ebayFormCondition, EBAY_CONDITION_LABELS } from './conditions.ts';
import { formatEbayTime } from './fake/fake-ebay-site.ts';
import { ebayTimeIn, parsePrice } from './pages/common.ts';
import {
  buildEbayAutomationPayload,
  ebayPriceField,
  validateEbayAutomationPayload,
} from './payload.ts';
import { EBAY_PATHS, itemIdFromPath } from './site.ts';

const CONDITIONS: readonly ItemCondition[] = [
  'new_with_tags',
  'new_without_tags',
  'new_with_defects',
  'pre_owned_excellent',
  'pre_owned_good',
  'pre_owned_fair',
];

function payloadFor(overrides: Parameters<typeof sampleListingContent>[0] = {}) {
  const content = sampleListingContent(overrides);
  return buildEbayAutomationPayload(content.item, content.variant);
}

describe('eBay conditions on the listing form', () => {
  it('maps each Listora condition to the grade the category offers, as API mode does', () => {
    const forCategory = (category: string) =>
      CONDITIONS.map(
        (condition) =>
          payloadFor({ item: { category, condition, sizeLabel: '9' } }).condition?.label,
      );
    expect(forCategory('clothing/outerwear/denim_jackets')).toEqual([
      'New with tags',
      'New without tags',
      'New with defects',
      'Pre-owned - Excellent',
      'Pre-owned - Good',
      'Pre-owned - Fair',
    ]);
    expect(forCategory('shoes/boots')).toEqual([
      'New with box',
      'New without box',
      'New with defects',
      'Pre-owned',
      'Pre-owned',
      'Pre-owned',
    ]);
    expect(forCategory('accessories/hats')).toEqual([
      'New with tags',
      'New without tags',
      'New with defects',
      'Pre-owned',
      'Pre-owned',
      'Pre-owned',
    ]);
  });

  it('offers no label for an id the category does not take', () => {
    expect(ebayFormCondition(2990, 'shoes')).toBeNull();
    expect(ebayFormCondition(null, 'clothing')).toBeNull();
    expect(ebayFormCondition(3010, 'clothing')).toEqual({ id: 3010, label: 'Pre-owned - Fair' });
    expect(Object.keys(EBAY_CONDITION_LABELS.apparel)).toHaveLength(6);
  });
});

describe('the eBay automation payload', () => {
  it("carries exactly what the eBay API adapter would send, so a mode switch keeps the listing's details", () => {
    const content = sampleListingContent();
    const automated = buildEbayAutomationPayload(content.item, content.variant);
    const api = buildEbayPayload(content.item, content.variant);
    expect(automated).toMatchObject({
      title: api.title,
      descriptionHtml: api.descriptionHtml,
      categoryId: api.categoryId,
      condition: { id: api.conditionId },
      conditionDescription: api.conditionDescription,
      itemSpecifics: api.itemSpecifics,
      price: { amountCents: api.priceCents, currency: api.currency },
    });
    expect(automated.photos.map((photo) => photo.url)).toEqual(api.photoUrls);
  });

  it('takes the shoe size list for shoes and none for accessories', () => {
    expect(payloadFor({ item: { category: 'shoes/boots', sizeLabel: '10 1/2' } })).toMatchObject({
      size: 'shoes',
      itemSpecifics: expect.arrayContaining([
        { name: 'US Shoe Size', values: ['10.5'] },
      ]) as unknown,
    });
    expect(payloadFor({ item: { category: 'accessories/hats' } }).size).toBe('none');
  });

  it("validates eBay's rules without repeating the assisted ones", () => {
    expect(validateEbayAutomationPayload(payloadFor())).toEqual([]);
    const issues = (overrides: Parameters<typeof sampleListingContent>[0]) =>
      validateEbayAutomationPayload(payloadFor(overrides)).map((issue) => issue.message);
    expect(issues({ variant: { price: { amountCents: 50, currency: 'USD' } } })).toEqual([
      'eBay prices must be at least $0.99.',
    ]);
    // The assisted adapter already says these.
    expect(issues({ item: { photos: [] } })).toEqual([]);
    expect(issues({ variant: { price: { amountCents: 0, currency: 'USD' } } })).toEqual([]);
    expect(issues({ item: { department: 'unisex', category: 'other/other' } })).toEqual([
      'eBay needs a category for this item.',
    ]);
    expect(
      issues({ item: { category: 'shoes/boots', sizeLabel: '42', sizeSystem: 'eu' } }),
    ).toEqual(['eBay needs the US shoe size, for example 9 or 10.5.']);
    expect(issues({ item: { condition: null } })).toEqual(["eBay needs the item's condition."]);
  });

  it('types prices in dollars and cents', () => {
    expect(ebayPriceField(4500)).toBe('45.00');
    expect(ebayPriceField(99)).toBe('0.99');
    expect(ebayPriceField(104_505)).toBe('1045.05');
  });
});

describe("reading eBay's pages", () => {
  it('reads prices as eBay shows them', () => {
    expect(parsePrice('US $45.00')).toBe(4500);
    expect(parsePrice('$1,045.50')).toBe(104_550);
    expect(parsePrice('US $7')).toBe(700);
    expect(parsePrice('C $45.00')).toBeNull();
    expect(parsePrice('£45.00')).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  it("reads eBay's times in US time zones, to the second", () => {
    expect(ebayTimeIn('Last updated on Oct 25, 2026 09:12:45 PDT View all revisions')).toEqual(
      new Date('2026-10-25T16:12:45Z'),
    );
    expect(ebayTimeIn('Ended: Jan 05, 2027 23:59:59 PST')).toEqual(
      new Date('2027-01-06T07:59:59Z'),
    );
    expect(ebayTimeIn('Oct 25, 2026 09:12:45 EDT')).toEqual(new Date('2026-10-25T13:12:45Z'));
    expect(ebayTimeIn('Feb 31, 2026 09:12:45 PST')).toBeNull();
    expect(ebayTimeIn('Oct 25, 2026 25:12:45 PDT')).toBeNull();
    expect(ebayTimeIn('Oct 25, 2026 09:12:45 XYZ')).toBeNull();
    expect(ebayTimeIn('2 days ago')).toBeNull();
  });

  it("reads back the fake eBay site's times on both sides of a daylight saving change", () => {
    for (const iso of ['2026-07-01T12:00:05Z', '2026-12-01T12:00:05Z', '2026-11-01T09:30:00Z']) {
      const time = new Date(iso);
      expect(ebayTimeIn(formatEbayTime(time)), iso).toEqual(time);
    }
    expect(formatEbayTime(new Date('2026-07-01T07:00:00Z'))).toBe('Jul 01, 2026 00:00:00 PDT');
  });

  it('knows listing addresses and item numbers', () => {
    expect(itemIdFromPath('/itm/326000000001')).toBe('326000000001');
    expect(itemIdFromPath('/itm/levis-trucker-jacket/326000000001')).toBe('326000000001');
    expect(itemIdFromPath('/itm/abc')).toBeNull();
    expect(itemIdFromPath('/sh/ovw')).toBeNull();
    expect(EBAY_PATHS.form('AddItem', { categoryId: '57988' })).toBe(
      '/lstng?mode=AddItem&categoryId=57988',
    );
    expect(EBAY_PATHS.form('ReviseItem', { itemId: '326000000001', categoryId: null })).toBe(
      '/lstng?mode=ReviseItem&itemId=326000000001',
    );
    expect(EBAY_PATHS.active(0)).toBe('/sh/lst/active');
    expect(EBAY_PATHS.sold(20)).toBe('/sh/lst/sold?offset=20');
  });
});
