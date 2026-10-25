/**
 * The eBay payload builder and its validation beyond the conformance suite's sample item:
 * categories, conditions, standard sizes, item specifics, and the rules eBay enforces, all
 * pinned by golden files (`npx vitest -u` rewrites them after a deliberate change).
 */
import { describe, expect, it } from 'vitest';

import type { ItemSnapshot, ListingContent } from '../content.ts';
import { sampleListingContent, type SampleContentOverrides } from '../testing.ts';
import { buildEbayPayload, validateEbayPayload } from './payload.ts';

const golden = (file: string): string => new URL(`__golden__/${file}`, import.meta.url).pathname;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function content(overrides: SampleContentOverrides): ListingContent {
  return sampleListingContent(overrides);
}

const womensJeans: Partial<ItemSnapshot> = {
  brand: 'Madewell',
  productName: 'Perfect Vintage Jean',
  styleNumber: null,
  department: 'women',
  category: 'clothing/bottoms/jeans',
  sizeLabel: '27x30',
  sizeSystem: 'waist_inseam',
  colors: ['navy'],
  materials: ['98% cotton', '2% elastane'],
  pattern: 'solid',
  condition: 'pre_owned_good',
  conditionNotes: null,
  flaws: ['small mark on the back pocket'],
};

const CASES = {
  mensJacket: content({}),
  womensJeansWaistInseam: content({ item: womensJeans, variant: { aspects: [] } }),
  womensPlusTop: content({
    item: {
      department: 'women',
      category: 'clothing/tops/blouses',
      sizeLabel: '2X',
      sizeSystem: 'letter',
      colors: ['cream'],
    },
    variant: { aspects: [] },
  }),
  mensSneakersHalfSize: content({
    item: {
      brand: 'Nike',
      category: 'shoes/sneakers',
      sizeLabel: '10 1/2',
      sizeSystem: 'us',
      colors: ['white'],
      materials: ['leather'],
      condition: 'new_with_tags',
      conditionNotes: 'Never worn, box included.',
    },
    variant: { aspects: [] },
  }),
  unbrandedHandbag: content({
    item: {
      brand: null,
      styleNumber: null,
      department: 'women',
      category: 'bags/totes',
      sizeLabel: null,
      sizeSystem: null,
      condition: 'pre_owned_excellent',
    },
    variant: { aspects: [] },
  }),
  variantCategoryAndAspects: content({
    variant: {
      categoryRef: '15687',
      condition: 'pre_owned_fair',
      aspects: [
        { name: 'size', values: ['L'] },
        { name: 'Style', values: ['Trucker'] },
      ],
    },
  }),
  multilineDescription: content({
    variant: { description: 'Line one & more.\nLine "two" <b>not bold</b>.' },
  }),
};

describe('buildEbayPayload', () => {
  it('builds payloads purely, pinned in a golden file', async () => {
    const payloads = Object.fromEntries(
      Object.entries(CASES).map(([name, { item, variant }]) => {
        const frozen = structuredClone({ item, variant });
        const payload = buildEbayPayload(frozen.item, frozen.variant);
        expect(frozen).toEqual({ item, variant });
        expect(buildEbayPayload(item, variant)).toEqual(payload);
        return [name, payload];
      }),
    );
    await expect(json(payloads)).toMatchFileSnapshot(golden('payloads.json'));
  });

  it('maps conditions to the category scheme', () => {
    const condition = (overrides: SampleContentOverrides) => {
      const { item, variant } = content(overrides);
      return buildEbayPayload(item, variant).conditionId;
    };
    // Apparel has three pre-owned grades; elsewhere every pre-owned item is 3000 "Used".
    expect(condition({ item: { condition: 'pre_owned_excellent' } })).toBe(2990);
    expect(condition({ item: { condition: 'pre_owned_good' } })).toBe(3000);
    expect(condition({ item: { condition: 'pre_owned_fair' } })).toBe(3010);
    expect(condition({ item: { condition: 'new_with_tags' } })).toBe(1000);
    expect(condition({ item: { condition: 'new_without_tags' } })).toBe(1500);
    expect(condition({ item: { condition: 'new_with_defects' } })).toBe(1750);
    const shoes = { category: 'shoes/boots' };
    expect(condition({ item: { ...shoes, condition: 'pre_owned_excellent' } })).toBe(3000);
    expect(condition({ item: { ...shoes, condition: 'pre_owned_fair' } })).toBe(3000);
    // The variant's condition wins over the item's.
    expect(condition({ variant: { condition: 'new_with_tags' } })).toBe(1000);
  });

  it('sends no condition description with a brand-new condition, which eBay ignores', () => {
    const { item, variant } = content({ item: { condition: 'new_with_tags' } });
    expect(buildEbayPayload(item, variant).conditionDescription).toBeNull();
  });
});

describe('validateEbayPayload', () => {
  const issuesFor = (overrides: SampleContentOverrides) => {
    const { item, variant } = content(overrides);
    return validateEbayPayload(buildEbayPayload(item, variant));
  };

  it('accepts every golden case except where the item lacks what eBay needs', () => {
    for (const [name, { item, variant }] of Object.entries(CASES)) {
      expect(validateEbayPayload(buildEbayPayload(item, variant)), name).toEqual([]);
    }
  });

  it("states eBay's rules in user-readable issues, pinned in a golden file", async () => {
    const cases = {
      blankTitle: issuesFor({ variant: { title: '   ' } }),
      untrimmedTitle: issuesFor({ variant: { title: ' Jacket' } }),
      htmlTitle: issuesFor({ variant: { title: 'Jacket <b>sale</b>' } }),
      blankDescription: issuesFor({ variant: { description: '' } }),
      untrimmedDescription: issuesFor({ variant: { description: 'Jacket.\n' } }),
      tooManyPhotos: issuesFor({
        item: {
          photos: Array.from({ length: 25 }, (_, position) => ({
            photoId: `photo-${String(position)}`,
            position,
            role: 'detail' as const,
            url: `https://media.listora.test/p/${String(position)}.jpg`,
          })),
        },
      }),
      noCategory: issuesFor({ item: { category: 'home/decor', department: null } }),
      noCondition: issuesFor({ item: { condition: null } }),
      nonStandardSize: issuesFor({
        item: { sizeLabel: 'Fits like a medium', sizeSystem: null },
        variant: { aspects: [] },
      }),
      noShoeSize: issuesFor({
        item: { category: 'shoes/boots', sizeLabel: '42', sizeSystem: 'eu' },
        variant: { aspects: [] },
      }),
      longConditionNotes: issuesFor({ item: { conditionNotes: 'x'.repeat(1001) } }),
      longAspectValue: issuesFor({
        variant: { aspects: [{ name: 'Style', values: ['x'.repeat(66)] }] },
      }),
      tooManyAspects: issuesFor({
        variant: {
          aspects: Array.from({ length: 45 }, (_, index) => ({
            name: `Aspect ${String(index)}`,
            values: ['x'],
          })),
        },
      }),
    };
    for (const [name, issues] of Object.entries(cases)) {
      expect(issues.length, name).toBeGreaterThan(0);
      for (const issue of issues) expect(issue.message).toContain('eBay');
    }
    await expect(json(cases)).toMatchFileSnapshot(golden('validations.json'));
  });
});
