import { describe, expect, it } from 'vitest';

import { scanCall } from './call.ts';
import { unsoldLikeIt } from './unsold.ts';

// Invented items; no real shop's data.
const LEGGINGS = 'clothing/bottoms/leggings';
const unsold = [
  { brand: 'Lululemon', category: LEGGINGS, sizeLabel: '6' },
  { brand: 'LULULEMON', category: LEGGINGS, sizeLabel: '4' },
  { brand: 'Lululemon', category: 'clothing/tops/tank_tops', sizeLabel: 'S' },
  { brand: 'Athleta', category: LEGGINGS, sizeLabel: '6' },
  { brand: null, category: LEGGINGS, sizeLabel: '6' },
];

describe('unsoldLikeIt', () => {
  it('counts the same brand and category, or the brand alone when the read has no category', () => {
    expect(unsoldLikeIt({ brand: 'lululemon', category: LEGGINGS }, unsold)).toEqual({
      count: 2,
      level: 'brand_and_category',
    });
    expect(unsoldLikeIt({ brand: 'Lululemon', category: null }, unsold)).toEqual({
      count: 3,
      level: 'brand',
    });
  });

  it('says nothing without a brand or with none like it', () => {
    expect(unsoldLikeIt({ brand: null, category: LEGGINGS }, unsold)).toBeUndefined();
    expect(unsoldLikeIt({ brand: 'Patagonia', category: null }, unsold)).toBeUndefined();
  });

  it('shows on the call as a signal and never moves it', () => {
    const input = {
      identityConfidence: 0.9,
      aiEstimate: { lowCents: 2000, midCents: 3000, highCents: 4000 },
      flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
      fees: () => 0,
    };
    const without = scanCall(input);
    const withUnsold = scanCall({ ...input, unsold: { count: 2, level: 'brand_and_category' } });
    expect(withUnsold.call).toBe(without.call);
    expect(withUnsold.confidence).toBe(without.confidence);
    expect(withUnsold.signals).toEqual([
      {
        kind: 'unsold',
        label: 'You have 2 like it unsold',
        basedOn: 'Your items of the same brand and kind in inventory, ready or listed',
      },
    ]);
  });
});
