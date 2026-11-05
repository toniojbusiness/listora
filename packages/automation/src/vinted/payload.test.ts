import { describe, expect, it } from 'vitest';

import { sampleListingContent, type SampleContentOverrides } from '@listora/marketplaces/testing';

import { buildVintedPayload, validateVintedPayload } from './payload.ts';

const payload = (overrides: SampleContentOverrides = {}) => {
  const content = sampleListingContent(overrides);
  return buildVintedPayload(content.item, content.variant);
};
const issues = (overrides: SampleContentOverrides = {}) =>
  validateVintedPayload(payload(overrides)).map((issue) => `${issue.code}: ${issue.message}`);

describe('the Vinted payload', () => {
  it("names Vinted's condition, never claiming more than the item's", () => {
    const conditions = {
      new_with_tags: 'New with tags',
      new_without_tags: 'New without tags',
      new_with_defects: 'Good',
      pre_owned_excellent: 'Very good',
      pre_owned_good: 'Good',
      pre_owned_fair: 'Satisfactory',
    } as const;
    for (const [condition, vinted] of Object.entries(conditions)) {
      expect(payload({ item: { condition: condition as keyof typeof conditions } }).condition).toBe(
        vinted,
      );
    }
    // The listing's own condition wins.
    expect(payload({ variant: { condition: 'new_with_tags' } }).condition).toBe('New with tags');
  });

  it("names at most two colours, in Vinted's names, each once", () => {
    expect(payload({ item: { colors: ['gray', 'tan', 'beige', 'navy'] } }).colors).toEqual([
      'Grey',
      'Beige',
    ]);
    expect(payload({ item: { colors: ['chartreuse'] } }).colors).toEqual([]);
  });

  it("takes the size the listing names over the item's label", () => {
    expect(payload().size).toBe('M');
    expect(payload({ variant: { aspects: [{ name: 'Size', values: ['L / 12-14'] }] } }).size).toBe(
      'L / 12-14',
    );
    expect(payload({ item: { sizeLabel: null }, variant: { aspects: [] } }).size).toBeNull();
  });

  it("keeps Vinted's recommended package size unless the listing names one", () => {
    expect(payload().packageSize).toBeNull();
    expect(
      payload({ variant: { aspects: [{ name: 'package size', values: ['Medium'] }] } }).packageSize,
    ).toBe('medium');
    expect(
      payload({ variant: { aspects: [{ name: 'Package size', values: ['Huge'] }] } }).packageSize,
    ).toBeNull();
  });

  it('takes the category the listing names, else the mapped one', () => {
    expect(payload().category).toEqual([
      'Men',
      'Clothing',
      'Outerwear',
      'Jackets',
      'Denim jackets',
    ]);
    expect(payload({ variant: { categoryRef: 'Women > Clothing > Skirts' } }).category).toEqual([
      'Women',
      'Clothing',
      'Skirts',
    ]);
  });

  it("refuses what Vinted's form would refuse, naming Vinted", () => {
    expect(issues()).toEqual([]);
    expect(issues({ variant: { title: 'ab' } })).toEqual([
      'too_short: Vinted titles need at least 3 characters.',
    ]);
    expect(issues({ variant: { description: ' ' } })).toEqual([
      'required: Vinted needs a description.',
    ]);
    expect(issues({ variant: { description: 'x'.repeat(1_950) } })).toEqual([
      'too_long: Vinted descriptions can be at most 1929 characters here (Listora adds a SKU line to the 2000 Vinted allows).',
    ]);
    expect(issues({ variant: { price: { amountCents: 50, currency: 'USD' } } })).toEqual([
      'out_of_range: Vinted prices are from $1 to $5,000.',
    ]);
    expect(issues({ item: { condition: null } })).toEqual([
      'required: Vinted needs the item condition.',
    ]);
  });

  it('asks for a category Listora has none for, with an example', () => {
    expect(issues({ item: { department: 'kids' } })).toEqual([
      "required: Listora has no Vinted category for this item. Choose one, for example 'Women > Clothing > Dresses > Mini-dresses'.",
    ]);
    expect(
      issues({
        item: { category: 'clothing/outerwear/jackets', productName: null },
        variant: { title: 'Plain Jacket' },
      }),
    ).toEqual([
      "required: Vinted files this by its kind. Choose its category, for example 'Men > Clothing > Outerwear > Jackets > Denim jackets'.",
    ]);
  });
});
