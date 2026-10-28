import { describe, expect, it } from 'vitest';

import { eachCostCents, haulShare, haulShares } from './shares.ts';

describe('haul shares', () => {
  it('splits $50 over 30 items as $1.67 and $1.66 that add back up to $50', () => {
    const shares = haulShares(5_000, 30);
    expect(shares).toHaveLength(30);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(5_000);
    // 5000 = 30 x 166 + 20: the first 20 items to join carry the leftover cents.
    expect(shares.slice(0, 20)).toEqual(Array<number>(20).fill(167));
    expect(shares.slice(20)).toEqual(Array<number>(10).fill(166));
    expect(eachCostCents(5_000, 30)).toBe(167);
  });

  it('gives every item the same share when the total divides evenly', () => {
    expect(haulShares(1_200, 3)).toEqual([400, 400, 400]);
    expect(eachCostCents(1_200, 3)).toBe(400);
  });

  it('adds back up to the total for every split', () => {
    for (const total of [0, 1, 2, 99, 100, 101, 999, 5_000, 12_345, 1_000_001]) {
      for (const count of [1, 2, 3, 7, 30, 97, 1_000]) {
        const shares = haulShares(total, count);
        expect(
          shares.reduce((sum, share) => sum + share, 0),
          `${String(total)}/${String(count)}`,
        ).toBe(total);
        // No two shares differ by more than a cent, and the larger come first.
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
        expect([...shares].sort((a, b) => b - a)).toEqual(shares);
      }
    }
  });

  it('spreads fewer cents than items over the first items, the rest cost nothing', () => {
    expect(haulShares(2, 3)).toEqual([1, 1, 0]);
    expect(eachCostCents(2, 3)).toBe(1);
  });

  it('rounds the shown each cost half up', () => {
    expect(eachCostCents(1_000, 3)).toBe(333);
    expect(eachCostCents(1_001, 2)).toBe(501);
    expect(eachCostCents(1, 2)).toBe(1);
    expect(eachCostCents(0, 5)).toBe(0);
  });

  it('refuses a haul that cannot exist', () => {
    expect(() => haulShare(100, 0, 0)).toThrow(RangeError);
    expect(() => haulShare(-1, 2, 0)).toThrow(RangeError);
    expect(() => haulShare(1.5, 2, 0)).toThrow(RangeError);
    expect(() => haulShare(100, 2, -1)).toThrow(RangeError);
    expect(() => eachCostCents(100, 0)).toThrow(RangeError);
  });
});
