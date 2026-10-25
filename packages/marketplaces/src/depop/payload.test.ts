/**
 * Depop payloads and validation, pinned by golden files (`npx vitest -u` rewrites them after a
 * deliberate change; review the diff like code), and the Selling API body they become.
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ListingContent } from '../content.ts';
import { sampleListingContent, type SampleContentOverrides } from '../testing.ts';
import { productBody } from './adapter.ts';
import { buildDepopPayload, depopAmount, depopCents, validateDepopPayload } from './payload.ts';
import { depopColours, depopCondition, depopDepartment, depopProductType } from './taxonomy.ts';

const golden = (file: string) => fileURLToPath(new URL(`__golden__/${file}`, import.meta.url));

/** A t-shirt: a category whose Depop product type Depop's documentation names. */
function tee(overrides: SampleContentOverrides = {}): ListingContent {
  return sampleListingContent({
    item: { category: 'clothing/tops/t_shirts', ...overrides.item },
    variant: overrides.variant ?? {},
  });
}

const issues = (content: ListingContent) =>
  validateDepopPayload(buildDepopPayload(content.item, content.variant));

describe('buildDepopPayload', () => {
  const cases: Record<string, ListingContent> = {
    tee: tee(),
    hashtagsAndSize: tee({
      variant: {
        hashtags: ['vintage', 'levis'],
        aspects: [
          { name: 'size_set_id', values: ['52'] },
          { name: 'size_id', values: ['10'] },
          { name: 'material', values: ['cotton'] },
          { name: 'Size', values: ['M'] },
        ],
      },
    }),
    unbrandedWomenNewWithTags: tee({
      item: {
        brand: null,
        department: 'women',
        condition: 'new_with_tags',
        colors: ['gray', 'multicolor', 'black'],
      },
    }),
    categoryRefWins: sampleListingContent({
      variant: { categoryRef: 'jackets', condition: 'pre_owned_fair' },
    }),
    homeItem: sampleListingContent({ item: { category: 'home/decor', department: null } }),
  };

  it('builds payloads purely, in posting order, pinned in a golden file', async () => {
    const payloads = Object.fromEntries(
      Object.entries(cases).map(([name, content]) => [
        name,
        buildDepopPayload(content.item, content.variant),
      ]),
    );
    expect(payloads['tee']?.pictureUrls).toEqual([
      'https://media.listora.test/p/front.jpg',
      'https://media.listora.test/p/back.jpg',
      'https://media.listora.test/p/tag.jpg',
    ]);
    await expect(`${JSON.stringify(payloads, null, 2)}\n`).toMatchFileSnapshot(
      golden('payloads.json'),
    );
  });

  it('becomes the Selling API body with the seller address, shipping, and hashtag line', async () => {
    const payload = buildDepopPayload(
      cases['hashtagsAndSize']?.item ?? tee().item,
      cases['hashtagsAndSize']?.variant ?? tee().variant,
    );
    const bodies = {
      depopShipping: productBody(payload, {
        address: { countryCode: 'US', state: 'California' },
        shipping: {
          type: 'depop',
          addressId: 100001,
          providerId: 'USPS',
          parcelSizeId: 'SMALL',
          payer: 'buyer',
        },
      }),
      manualShipping: productBody(payload, {
        address: { countryCode: 'GB', state: null },
        shipping: { type: 'manual', nationalCostCents: 350 },
      }),
    };
    expect(bodies.depopShipping['description']).toBe(
      'Classic trucker jacket in medium wash. Light fading at the cuffs.\n\n#vintage #levis',
    );
    expect(bodies.depopShipping).not.toHaveProperty('is_boosted');
    await expect(`${JSON.stringify(bodies, null, 2)}\n`).toMatchFileSnapshot(golden('bodies.json'));
  });
});

describe('validateDepopPayload', () => {
  it('accepts a listing Depop takes', () => {
    expect(issues(tee())).toEqual([]);
  });

  it('refuses what Depop refuses, pinned in a golden file', async () => {
    const photo = (index: number) => ({
      photoId: `photo-${String(index)}`,
      position: index,
      role: 'detail' as const,
      url: `https://media.listora.test/p/${String(index)}.jpg`,
    });
    const results = {
      ninePhotos: issues(
        tee({ item: { photos: Array.from({ length: 9 }, (_, index) => photo(index)) } }),
      ),
      ninetyNineCents: issues(tee({ variant: { price: { amountCents: 99, currency: 'USD' } } })),
      tooLongWithHashtags: issues(
        tee({ variant: { description: 'x'.repeat(990), hashtags: ['vintage', 'denim'] } }),
      ),
      emailAddress: issues(tee({ variant: { description: 'Questions? me@example.com' } })),
      hashtagLineInCopy: issues(tee({ variant: { description: 'Great tee\n\n#vintage #y2k' } })),
      sixHashtags: issues(
        tee({
          variant: {
            description: 'Mentions #summer inline.',
            hashtags: ['a1', 'b2', 'c3', 'd4', 'e5'],
          },
        }),
      ),
      badHashtag: issues(tee({ variant: { hashtags: ['two words'] } })),
      blankDescription: issues(tee({ variant: { description: '  ' } })),
      unisex: issues(tee({ item: { department: 'unisex' } })),
      unmappedCategory: issues(sampleListingContent()),
      notATaxonomyId: issues(tee({ variant: { categoryRef: 'Denim Jackets' } })),
      halfASize: issues(tee({ variant: { aspects: [{ name: 'size_id', values: ['10'] }] } })),
      sizeNotANumber: issues(
        tee({
          variant: {
            aspects: [
              { name: 'size_set_id', values: ['52'] },
              { name: 'size_id', values: ['M'] },
            ],
          },
        }),
      ),
      noCondition: issues(tee({ item: { condition: null } })),
    };
    for (const [name, found] of Object.entries(results)) {
      expect(found.length, name).toBeGreaterThan(0);
      for (const issue of found) expect(issue.message, name).toContain('Depop');
    }
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      golden('validations.json'),
    );
  });
});

describe('Depop taxonomy and amounts', () => {
  it('maps only categories whose product type Depop documents', () => {
    expect(depopProductType('clothing/tops/t_shirts')).toBe('tshirts');
    expect(depopProductType('clothing/bottoms/joggers')).toBe('joggers-tracksuits');
    expect(depopProductType('clothing/outerwear/jackets')).toBeNull();
    expect(depopProductType(null)).toBeNull();
  });

  it('maps departments, conditions, and colours to Depop terms', () => {
    expect(depopDepartment('men', 'clothing/tops/t_shirts')).toBe('menswear');
    expect(depopDepartment('kids', null)).toBe('kidswear');
    expect(depopDepartment('unisex', 'clothing/tops/t_shirts')).toBeNull();
    expect(depopDepartment('women', 'home/decor')).toBe('everything-else');
    expect(depopCondition('new_without_tags')).toBe('brand_new');
    expect(depopCondition('pre_owned_fair')).toBe('used_fair');
    expect(depopColours(['Gray', 'beige', 'multicolor', 'black'])).toEqual(['grey', 'multi']);
  });

  it('reads and writes decimal amounts exactly', () => {
    expect(depopAmount(4500)).toBe('45.00');
    expect(depopAmount(5)).toBe('0.05');
    expect(depopCents('25.99')).toBe(2599);
    expect(depopCents('5.0')).toBe(500);
    expect(depopCents('12')).toBe(1200);
    expect(depopCents('1.234')).toBeNull();
    expect(depopCents(12)).toBeNull();
  });
});
