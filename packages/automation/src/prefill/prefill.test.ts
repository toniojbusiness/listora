/**
 * The marketplace pre-fill against the real category trees and forms in the repository (Depop's
 * taxonomy, Poshmark's catalog, Mercari's catalog): what the review shows is exactly what each
 * marketplace's payload builder sends, in-between items get the marketplace's default, and only
 * genuinely open questions reach the AI or the seller.
 */
import { CATEGORY_TREE } from '@listora/analysis';
import { sampleListingContent } from '@listora/marketplaces/testing';
import { describe, expect, it } from 'vitest';

import { buildDepopAutomationPayload } from '../depop/payload.ts';
import { buildMercariPayload } from '../mercari/payload.ts';
import { buildPoshmarkPayload } from '../poshmark/payload.ts';
import { AI_PICK_CONFIDENCE } from './choose.ts';
import { prefillItem } from './prefill.ts';
import { distinguishingLabels, rankSizes } from './rank.ts';
import type {
  ItemPrefill,
  MarketplacePrefill,
  PrefillField,
  PrefillItem,
  PrefillMarketplace,
  PrefillPick,
} from './types.ts';

const ITEM: PrefillItem = {
  title: null,
  productName: null,
  keywords: [],
  description: null,
  category: null,
  department: null,
  sizeLabel: null,
  sizeSystem: null,
  brand: null,
  condition: 'pre_owned_good',
  colors: ['black'],
  materials: ['cotton'],
};

function prefill(
  item: Partial<PrefillItem>,
  answers: Record<string, string> = {},
  picks: Record<string, PrefillPick> = {},
): ItemPrefill {
  return prefillItem({
    item: { ...ITEM, ...item },
    answers: new Map(Object.entries(answers)),
    picks: new Map(Object.entries(picks)),
  });
}

function on(result: ItemPrefill, marketplace: PrefillMarketplace): MarketplacePrefill {
  const found = result.marketplaces.find((entry) => entry.marketplace === marketplace);
  if (found === undefined) throw new Error(`no ${marketplace} pre-fill`);
  return found;
}

function field(entry: { fields: readonly PrefillField[] }, key: string): PrefillField {
  const found = entry.fields.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no ${key} field`);
  return found;
}

/** What the marketplace's payload builder sends for the item with the pre-fill's listing refs. */
function payloadOf(item: PrefillItem, entry: MarketplacePrefill) {
  const { listing } = entry;
  const content = sampleListingContent({
    item: {
      department: item.department,
      category: item.category,
      sizeLabel: item.sizeLabel,
      sizeSystem: item.sizeSystem,
      brand: item.brand,
      colors: [...item.colors],
      materials: [...item.materials],
      condition: item.condition,
    },
    variant: {
      categoryRef: listing.categoryRef,
      aspects: listing.size === null ? [] : [{ name: 'Size', values: [listing.size] }],
    },
  });
  switch (entry.marketplace) {
    case 'depop': {
      const payload = buildDepopAutomationPayload(content.item, content.variant);
      return { category: payload.category, size: payload.size };
    }
    case 'poshmark': {
      const payload = buildPoshmarkPayload(content.item, content.variant);
      const catalog = payload.catalog;
      return {
        category:
          catalog === null
            ? null
            : [
                catalog.department,
                catalog.category,
                ...(catalog.subcategory === null ? [] : [catalog.subcategory]),
              ],
        size: payload.size,
      };
    }
    case 'mercari': {
      const payload = buildMercariPayload(content.item, content.variant);
      return { category: payload.category, size: payload.size };
    }
  }
}

/** A size each kind of category's lists have, so every form shape gets one. */
function sizeFor(canonical: string, department: string): string | null {
  if (canonical.startsWith('shoes')) return department === 'kids' ? '11' : '9';
  if (canonical.startsWith('clothing/intimates/bras')) return '34B';
  if (canonical.startsWith('clothing')) return department === 'kids' ? '4T' : 'M';
  return null;
}

describe('the marketplace pre-fill', () => {
  it('fills a plain item on every marketplace from the real trees, with nothing to ask', () => {
    const item = {
      title: 'Madewell button down shirt',
      category: 'clothing/tops/shirts',
      department: 'women',
      sizeLabel: 'M',
      sizeSystem: 'letter',
      brand: 'Madewell',
    };
    const result = prefill(item);
    expect(result.decisions).toEqual([]);
    expect(result.item).toEqual([]);
    const depop = on(result, 'depop');
    expect(depop.ready).toBe(true);
    expect(field(depop, 'category').value?.path).toEqual(['Women', 'Tops', 'Shirts']);
    expect(field(depop, 'category').source).toBe('listora');
    expect(field(depop, 'size').value?.value).toBe('M');
    expect(field(depop, 'condition').value?.value).toBe('Used - Good');
    expect(field(depop, 'brand').value?.value).toBe('Madewell');
    expect(field(depop, 'colors').value?.value).toBe('Black');
    expect(field(depop, 'material').value?.value).toBe('Cotton');
    expect(field(on(result, 'poshmark'), 'size').value?.label).toBe('M (Standard)');
    expect(field(on(result, 'poshmark'), 'condition').value?.value).toBe('Good');
    expect(field(on(result, 'mercari'), 'category').value?.path).toEqual([
      'Women',
      'Tops & blouses',
      'Button down shirt',
    ]);
    expect(field(on(result, 'mercari'), 'size').value?.value).toBe('M (8-10)');
    for (const entry of result.marketplaces) {
      expect(entry.fields.some((candidate) => candidate.needsAnswer)).toBe(false);
      // Nothing beyond the payload's own mapping: listings stay as they were.
      expect(entry.listing).toEqual({ categoryRef: null, size: null });
    }
  });

  it("refines a mapped category into the subcategory the item's own name says", () => {
    const item = {
      title: "Levi's skinny jeans",
      category: 'clothing/bottoms/jeans',
      department: 'women',
      sizeLabel: '27',
      sizeSystem: 'numeric',
    };
    const result = prefill(item);
    const mercari = on(result, 'mercari');
    expect(field(mercari, 'category').value?.path).toEqual(['Women', 'Jeans', 'Skinny Jeans']);
    expect(mercari.listing.categoryRef).toBe('Women > Jeans > Skinny Jeans');
    expect(field(mercari, 'size').value?.value).toBe('27 in.');
    expect(field(on(result, 'poshmark'), 'category').value?.path).toEqual([
      'Women',
      'Jeans',
      'Skinny',
    ]);
    // A name that says no more than the category keeps it whole.
    expect(
      field(on(prefill({ ...item, title: 'Blue jeans' }), 'mercari'), 'category').value?.path,
    ).toEqual(['Women', 'Jeans']);
  });

  it("refines women's dresses and skirts by a length or a name's alternative, and petite sizes", () => {
    const dress = (title: string, sizeLabel = 'S') =>
      prefill({
        title,
        category: 'clothing/dresses/dresses',
        department: 'women',
        sizeLabel,
        sizeSystem: null,
      });
    // Mercari's mini dresses are "Above knee, mini": either name says it.
    expect(field(on(dress('Floral mini dress'), 'mercari'), 'category').value?.path).toEqual([
      'Women',
      'Dresses',
      'Above knee, mini',
    ]);
    expect(field(on(dress('Boho maxi dress'), 'poshmark'), 'category').value?.path).toEqual([
      'Women',
      'Dresses',
      'Maxi',
    ]);
    const skirt = prefill({
      title: 'Black pencil skirt',
      category: 'clothing/bottoms/skirts',
      department: 'women',
      sizeLabel: '4',
      sizeSystem: 'numeric',
    });
    expect(field(on(skirt, 'mercari'), 'category').value?.path).toEqual([
      'Women',
      'Skirts',
      'Straight, pencil',
    ]);
    // A petite size is the size Mercari's list shows (its Petite part is the payload's pick).
    expect(field(on(dress('Wrap dress', '4P'), 'mercari'), 'size').value?.value).toBe('S (4-6)');
  });

  it('never refines on a word the item does not say, or one its category already says', () => {
    const women = { department: 'women', sizeLabel: 'M', sizeSystem: 'letter' };
    // A ruffle neck is no V-neck, and "shorts" says nothing more than Mercari's Shorts.
    const sweater = prefill({
      ...women,
      title: 'Ruffle neck sweater',
      category: 'clothing/tops/sweaters',
    });
    expect(field(on(sweater, 'mercari'), 'category').value?.path).toEqual(['Women', 'Sweaters']);
    expect(field(on(sweater, 'poshmark'), 'category').value?.path).toEqual(['Women', 'Sweaters']);
    const shorts = prefill({ ...women, title: 'Navy shorts', category: 'clothing/bottoms/shorts' });
    expect(field(on(shorts, 'mercari'), 'category').value?.path).toEqual(['Women', 'Shorts']);
  });

  it("lets the AI place an item whose words name no category, from the tree's every kind", () => {
    const lamp = prefill({
      title: 'Vintage brass table lamp',
      keywords: ['lamp', 'brass', 'lighting'],
      category: 'other/other',
      department: null,
    });
    const options = (key: string) =>
      lamp.decisions.find((entry) => entry.key === key)?.options.map((option) => option.value) ??
      [];
    // Refined by the item's own words inside each kind: Home decor's lamps.
    expect(options('mercari.category')).toContain('Home > Home decor > Home Decor Lamps');
    expect(options('depop.category')).toContain('Everything else > Home > Home accessories');
    expect(options('poshmark.category').some((value) => value.startsWith('Home/'))).toBe(true);
  });

  it("gives a unisex item each marketplace's default department, as a choice", () => {
    const result = prefill({
      title: 'Comfort Colors tee',
      category: 'clothing/tops/t_shirts',
      department: 'unisex',
      sizeLabel: 'XL',
      sizeSystem: 'letter',
    });
    expect(result.decisions).toEqual([]);
    for (const marketplace of ['depop', 'poshmark', 'mercari'] as const) {
      const category = field(on(result, marketplace), 'category');
      expect(category.source).toBe('default');
      expect(category.needsAnswer).toBe(false);
      expect(category.value?.path?.[0]).toBe('Men');
      expect(category.options.map((option) => option.path?.[0])).toEqual(['Men', 'Women']);
      expect(category.note).toMatch(/unisex/);
    }
    // Only the departments differ, so the chips say just that.
    expect(field(on(result, 'depop'), 'category').options.map((option) => option.label)).toEqual([
      'Men',
      'Women',
    ]);
  });

  it("takes the seller's tap on another department and lists it there", () => {
    const item = {
      title: 'Comfort Colors tee',
      category: 'clothing/tops/t_shirts',
      department: 'unisex',
      sizeLabel: 'XL',
      sizeSystem: 'letter',
    };
    const result = prefill(item, { 'depop.category': 'Women > Tops > T-shirts' });
    const depop = on(result, 'depop');
    expect(field(depop, 'category').source).toBe('you');
    expect(depop.listing.categoryRef).toBe('Women > Tops > T-shirts');
    expect(payloadOf({ ...ITEM, ...item }, depop)).toEqual({
      category: ['Women', 'Tops', 'T-shirts'],
      size: 'XL',
    });
    // An answer the marketplace doesn't offer is ignored, never sent.
    const wrong = prefill(item, { 'depop.category': 'Women > Hovercraft > Fast' });
    expect(field(on(wrong, 'depop'), 'category').source).toBe('default');
  });

  it('asks girls or boys once for a kids item no word decides, and every marketplace follows', () => {
    const item = {
      title: 'Dinosaur graphic tee',
      category: 'clothing/tops/t_shirts',
      department: 'kids',
      sizeLabel: '8',
      sizeSystem: 'numeric',
    };
    const open = prefill(item);
    const [gender] = open.item;
    expect(gender?.key).toBe('kids_gender');
    expect(gender?.needsAnswer).toBe(true);
    expect(gender?.options.map((option) => option.value)).toEqual(['girls', 'boys']);
    // The marketplaces wait for that one answer rather than asking it again.
    const mercari = field(on(open, 'mercari'), 'category');
    expect(mercari.needsAnswer).toBe(false);
    expect(mercari.value).toBeNull();
    expect(field(on(open, 'poshmark'), 'size').needsAnswer).toBe(false);
    expect(open.decisions.map((decision) => decision.key)).toEqual(['kids_gender']);
    // Depop's web form files kids by age only.
    expect(on(open, 'depop').ready).toBe(true);

    const told = prefill(item, { kids_gender: 'boys' });
    expect(field(on(told, 'mercari'), 'category').value?.path).toEqual([
      'Kids',
      'Boys tops & t-shirts',
      'Boys (4+)',
    ]);
    const poshmark = on(told, 'poshmark');
    expect(field(poshmark, 'size').value?.label).toBe('8 (Boys)');
    expect(payloadOf({ ...ITEM, ...item }, poshmark).size).toMatchObject({
      set: 'Boys',
      size: '8B',
    });
    expect(told.marketplaces.every((entry) => entry.ready)).toBe(true);
  });

  it("reads girls or boys from the item's own words, without asking", () => {
    const result = prefill({
      title: "Girls' unicorn tee",
      category: 'clothing/tops/t_shirts',
      department: 'kids',
      sizeLabel: '8',
      sizeSystem: 'numeric',
    });
    expect(result.item[0]?.source).toBe('listora');
    expect(result.decisions).toEqual([]);
    expect(field(on(result, 'mercari'), 'category').value?.path?.[1]).toBe('Girls tops & t-shirts');
  });

  it('puts a sure AI pick in place, and leads with an unsure one in the question', () => {
    const item = {
      title: 'LEGO Star Wars X-wing building set',
      keywords: ['lego', 'building blocks', 'toy'],
      category: 'other/other',
      department: 'kids',
    };
    const open = prefill(item);
    const decision = open.decisions.find((entry) => entry.key === 'mercari.category');
    expect(decision?.options.length).toBeGreaterThan(1);
    // The candidates are Mercari's own categories, the best match first.
    expect(decision?.options[0]?.path?.[0]).toBe('Toys & Collectibles');
    expect(decision?.options.some((option) => option.value.includes('LEGO'))).toBe(true);
    const lego = 'Toys & Collectibles > Building Toys > LEGO Toys';
    const sure = prefill(item, {}, { 'mercari.category': { value: lego, confidence: 0.92 } });
    const picked = field(on(sure, 'mercari'), 'category');
    expect(picked.source).toBe('ai');
    expect(picked.value?.value).toBe(lego);
    expect(sure.decisions.some((entry) => entry.key === 'mercari.category')).toBe(false);

    const unsure = prefill(
      item,
      {},
      { 'mercari.category': { value: lego, confidence: AI_PICK_CONFIDENCE - 0.1 } },
    );
    const asked = field(on(unsure, 'mercari'), 'category');
    expect(asked.needsAnswer).toBe(true);
    expect(asked.options[0]?.value).toBe(lego);
    expect(asked.options.length).toBeLessThanOrEqual(4);
    // Asked once: a question the AI already answered is not asked again.
    expect(unsure.decisions.some((entry) => entry.key === 'mercari.category')).toBe(false);
    const none = prefill(item, {}, { 'mercari.category': { value: null, confidence: 0 } });
    expect(field(on(none, 'mercari'), 'category').needsAnswer).toBe(true);
    expect(none.decisions.some((entry) => entry.key === 'mercari.category')).toBe(false);
  });

  it('asks the size of a tag no list has, closest first, and takes the AI reading of it', () => {
    const item = {
      title: 'Floral blouse',
      category: 'clothing/tops/blouses',
      department: 'women',
      sizeLabel: 'UK 10',
      sizeSystem: 'uk',
    };
    const open = prefill(item);
    const size = field(on(open, 'depop'), 'size');
    expect(size.needsAnswer).toBe(true);
    expect(size.options[0]?.value).toBe('10');
    expect(size.choices?.length).toBeGreaterThan(size.options.length);
    expect(open.decisions.map((decision) => decision.key)).toEqual([
      'depop.size',
      'poshmark.size',
      'mercari.size',
    ]);
    const read = prefill(item, {}, { 'depop.size': { value: '6', confidence: 0.85 } });
    const depop = on(read, 'depop');
    expect(field(depop, 'size').source).toBe('ai');
    expect(depop.listing.size).toBe('6');
    expect(payloadOf({ ...ITEM, ...item }, depop).size).toBe('6');
  });

  it('never offers a Mercari category whose form asks for an IMEI', () => {
    const result = prefill({
      title: 'iPhone 12 cell phone smartphone',
      keywords: ['iphone', 'cell phone', 'smartphone'],
      category: 'other/other',
      department: null,
    });
    const options = result.decisions.find((entry) => entry.key === 'mercari.category')?.options;
    expect(options?.length).toBeGreaterThan(0);
    expect(options?.some((option) => option.value.endsWith('Cell phones & smartphones'))).toBe(
      false,
    );
  });

  it('sends exactly what it shows, for every canonical category in every department', () => {
    const canonical = Object.entries(CATEGORY_TREE).flatMap(([category, subcategories]) => [
      category,
      ...subcategories.map((subcategory) => `${category}/${subcategory}`),
    ]);
    let checked = 0;
    for (const category of canonical) {
      for (const department of ['women', 'men', 'unisex', 'kids']) {
        const item = {
          ...ITEM,
          title: category.split('/').at(-1)?.replaceAll('_', ' ') ?? null,
          category,
          department,
          sizeLabel: sizeFor(category, department),
          sizeSystem: 'letter',
        };
        // The seller's girls-or-boys answer, where it is asked.
        const result = prefill(item, { kids_gender: 'girls' });
        for (const entry of result.marketplaces) {
          const shown = field(entry, 'category').value;
          if (shown === null) continue;
          const sent = payloadOf(item, entry);
          expect(sent.category, `${entry.marketplace} ${department} ${category}`).toEqual(
            shown.path,
          );
          const size = entry.fields.find((candidate) => candidate.key === 'size')?.value;
          if (size !== undefined && size !== null && entry.marketplace !== 'poshmark') {
            expect(sent.size, `${entry.marketplace} ${department} ${category}`).toBe(size.value);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(canonical.length * 4 * 2);
  });
});

describe('the pre-fill rankers', () => {
  it('labels options by what tells them apart', () => {
    expect(
      distinguishingLabels([
        ['Men', 'Tops', 'T-shirts'],
        ['Women', 'Tops', 'T-shirts'],
      ]),
    ).toEqual(['Men', 'Women']);
    expect(
      distinguishingLabels([
        ['Kids', 'Girls tops & t-shirts', 'Girls (4+)'],
        ['Kids', 'Boys tops & t-shirts', 'Boys (4+)'],
      ]),
    ).toEqual(['Girls tops & t-shirts > Girls (4+)', 'Boys tops & t-shirts > Boys (4+)']);
    expect(distinguishingLabels([['Other', 'Other']])).toEqual(['Other > Other']);
  });

  it('ranks sizes by how close they are to the tag', () => {
    expect(rankSizes('M', ['XS (0-2)', 'S (4-6)', 'M (8-10)', 'L (12-14)'])[0]).toBe('M (8-10)');
    expect(rankSizes('31', ['28 in.', '30 in.', '32 in.']).slice(0, 2)).toEqual([
      '30 in.',
      '32 in.',
    ]);
    expect(rankSizes(null, ['S', 'M'])).toEqual(['S', 'M']);
  });
});
