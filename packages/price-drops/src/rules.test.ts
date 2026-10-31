import { describe, expect, it } from 'vitest';

import {
  assertDropTerms,
  dropDefaults,
  dropDueAt,
  dropFloor,
  DROP_NOTICE_HOURS,
  FALLBACK_TERMS,
  InvalidDropRuleError,
  nextDropPrice,
} from './rules.ts';

const DAY = 24 * 60 * 60_000;
const at = (iso: string) => new Date(iso);

describe('nextDropPrice', () => {
  it('takes the percent off, rounded down to whole dollars', () => {
    expect(nextDropPrice(4000, { percent: 10, floorCents: 1000 })).toBe(3600);
    expect(nextDropPrice(4500, { percent: 15, floorCents: 1000 })).toBe(3800); // 38.25
    expect(nextDropPrice(2550, { percent: 10, floorCents: 500 })).toBe(2200); // 22.95
  });

  it('never goes below the floor, rounded up to a whole dollar', () => {
    expect(nextDropPrice(4000, { percent: 50, floorCents: 3000 })).toBe(3000);
    expect(nextDropPrice(4000, { percent: 50, floorCents: 2950 })).toBe(3000);
  });

  it("never goes below the item's own lowest price either", () => {
    expect(nextDropPrice(4000, { percent: 50, floorCents: 1000 }, 3500)).toBe(3500);
    expect(nextDropPrice(4000, { percent: 10, floorCents: 3800 }, 1000)).toBe(3800);
  });

  it('is null at the floor, or under it, so a drop never raises a price', () => {
    expect(nextDropPrice(3000, { percent: 10, floorCents: 3000 })).toBeNull();
    expect(nextDropPrice(2500, { percent: 10, floorCents: 3000 })).toBeNull();
    // A price within a dollar of its floor still drops to it.
    expect(nextDropPrice(3050, { percent: 10, floorCents: 3000 })).toBe(3000);
  });

  it('drops even a small price by at least a dollar while above the floor', () => {
    expect(nextDropPrice(500, { percent: 1, floorCents: 100 })).toBe(400);
  });
});

describe('dropFloor', () => {
  it('is the higher of the two floors, in whole dollars', () => {
    expect(dropFloor(2501, null)).toBe(2600);
    expect(dropFloor(2000, 2401)).toBe(2500);
  });
});

describe('dropDueAt', () => {
  it('is the days after the listing went unsold', () => {
    const since = at('2026-10-01T12:00:00Z');
    expect(dropDueAt(since, 21, at('2026-09-01T00:00:00Z'))).toEqual(
      new Date(since.getTime() + 21 * DAY),
    );
  });

  it('is never sooner than a day after the rule took effect', () => {
    const armed = at('2026-10-31T09:00:00Z');
    expect(dropDueAt(at('2026-08-01T00:00:00Z'), 21, armed)).toEqual(
      new Date(armed.getTime() + DROP_NOTICE_HOURS * 60 * 60_000),
    );
  });
});

describe('dropDefaults', () => {
  it("uses the brand's median days to sell with three or more of its sales", () => {
    expect(dropDefaults([5, 50, 60, 70], { name: 'Patagonia', days: [10.2, 18, 30] })).toEqual({
      percent: 10,
      afterDays: 18,
      basis: { sales: 3, medianDays: 18, brand: 'Patagonia' },
    });
  });

  it('uses all the sales when the brand has too few', () => {
    expect(dropDefaults([12, 14, 40], { name: 'Levi', days: [3] })).toEqual({
      percent: 10,
      afterDays: 14,
      basis: { sales: 3, medianDays: 14 },
    });
  });

  it('holds the days to a week and three months', () => {
    expect(dropDefaults([0, 1, 2]).afterDays).toBe(7);
    expect(dropDefaults([200, 300, 400]).afterDays).toBe(90);
  });

  it('falls back to 10% after 21 days with too few sales', () => {
    expect(dropDefaults([4, 9])).toEqual({ ...FALLBACK_TERMS });
    expect(dropDefaults([])).toEqual({ percent: 10, afterDays: 21 });
  });
});

describe('assertDropTerms', () => {
  it('accepts terms in range', () => {
    expect(() => {
      assertDropTerms({ percent: 10, afterDays: 21, floorCents: 3000 });
    }).not.toThrow();
  });

  it.each([
    [{ percent: 0, afterDays: 21, floorCents: 3000 }, 'percent'],
    [{ percent: 51, afterDays: 21, floorCents: 3000 }, 'percent'],
    [{ percent: 10.5, afterDays: 21, floorCents: 3000 }, 'percent'],
    [{ percent: 10, afterDays: 0, floorCents: 3000 }, 'afterDays'],
    [{ percent: 10, afterDays: 366, floorCents: 3000 }, 'afterDays'],
    [{ percent: 10, afterDays: 21, floorCents: 99 }, 'floor'],
  ])('refuses %o, naming %s', (terms, field) => {
    expect(() => {
      assertDropTerms(terms);
    }).toThrow(InvalidDropRuleError);
    try {
      assertDropTerms(terms);
    } catch (error) {
      expect((error as InvalidDropRuleError).field).toBe(field);
    }
  });
});
