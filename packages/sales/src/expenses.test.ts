import { describe, expect, it } from 'vitest';

import { mileageDeductionCents, mileageRate, yearExpenses } from './expenses.ts';

describe('mileageRate', () => {
  it('uses the IRS rate Listora knows until the seller sets one', () => {
    expect(mileageRate(2026, null)).toEqual({
      year: 2026,
      tenthCentsPerMile: 725,
      setBySeller: false,
      irsTenthCentsPerMile: 725,
    });
    expect(mileageRate(2026, 700)).toMatchObject({ tenthCentsPerMile: 700, setBySeller: true });
  });

  it('has no rate for a year Listora knows none for', () => {
    expect(mileageRate(2031, null)).toMatchObject({
      tenthCentsPerMile: null,
      irsTenthCentsPerMile: null,
    });
  });
});

describe('mileageDeductionCents', () => {
  it('prices whole miles at tenths of a cent, half up to the cent', () => {
    expect(mileageDeductionCents(12, 725)).toBe(870);
    expect(mileageDeductionCents(1, 725)).toBe(73); // 72.5 cents
    expect(mileageDeductionCents(3, 655)).toBe(197); // 196.5 cents
    expect(mileageDeductionCents(0, 725)).toBe(0);
  });
});

describe('yearExpenses', () => {
  const rows = [
    { category: 'Mileage', amountCents: null, miles: 12 },
    { category: 'Parking', amountCents: 300, miles: null },
    { category: 'Mileage', amountCents: null, miles: 31 },
    { category: 'parking ', amountCents: 450, miles: null },
    { category: 'Supplies', amountCents: 1999, miles: null },
  ];

  it("prices the year's miles at once and groups spend by category", () => {
    const totals = yearExpenses(rows, mileageRate(2026, null));
    expect(totals.miles).toBe(43);
    expect(totals.trips).toBe(2);
    expect(totals.deductionCents).toBe(3118); // 43 * 72.5 = 3117.5
    expect(totals.spentCents).toBe(2749);
    expect(totals.categories).toEqual([
      { category: 'Supplies', spentCents: 1999, count: 1 },
      { category: 'Parking', spentCents: 750, count: 2 },
    ]);
    expect(totals.totalCents).toBe(5867);
  });

  it('leaves the deduction and total out while the year has no rate', () => {
    const totals = yearExpenses(rows, mileageRate(2031, null));
    expect(totals.deductionCents).toBeNull();
    expect(totals.totalCents).toBeNull();
    expect(totals.spentCents).toBe(2749);
  });

  it('is zero for a year without expenses', () => {
    expect(yearExpenses([], mileageRate(2026, null))).toMatchObject({
      miles: 0,
      trips: 0,
      deductionCents: 0,
      spentCents: 0,
      categories: [],
      totalCents: 0,
    });
  });
});
