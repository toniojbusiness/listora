import { describe, expect, it } from 'vitest';

import { medianCents, quartiles } from './stats.ts';

describe('quartiles', () => {
  it('interpolates between neighbours and rounds to whole cents', () => {
    expect(quartiles([1_000, 2_000, 3_000, 4_000])).toEqual({
      count: 4,
      lowCents: 1_750,
      medianCents: 2_500,
      highCents: 3_250,
    });
    expect(quartiles([700, 300, 500])).toEqual({
      count: 3,
      lowCents: 400,
      medianCents: 500,
      highCents: 600,
    });
  });

  it('makes one price its own range and nothing of no prices', () => {
    expect(quartiles([1_234])).toEqual({
      count: 1,
      lowCents: 1_234,
      medianCents: 1_234,
      highCents: 1_234,
    });
    expect(quartiles([])).toBeUndefined();
    expect(medianCents([])).toBeUndefined();
  });

  it('refuses a price that is not whole cents', () => {
    expect(() => quartiles([10.5])).toThrow(RangeError);
    expect(() => quartiles([-1])).toThrow(RangeError);
  });
});
