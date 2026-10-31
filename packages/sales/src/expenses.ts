/**
 * A year's business expenses for taxes (docs/features/expenses.md): miles driven, priced at the
 * year's standard mileage rate, and money spent, by category. Pure: the API reads the rows.
 */

/**
 * The IRS business standard mileage rates Listora knows, in tenths of a cent per mile (IRS
 * notices for each year; 725 is 72.5 cents). A year not listed has no rate until the seller sets
 * one, so its miles are never priced at a guessed rate.
 */
export const IRS_MILEAGE_RATES: Readonly<Record<number, number>> = {
  2023: 655,
  2024: 670,
  2025: 700,
  2026: 725,
};

/** A year's rate: the seller's own when set, otherwise the IRS rate Listora knows, if any. */
export interface MileageRateChoice {
  year: number;
  tenthCentsPerMile: number | null;
  setBySeller: boolean;
  irsTenthCentsPerMile: number | null;
}

export function mileageRate(year: number, sellerTenthCents: number | null): MileageRateChoice {
  const irs = IRS_MILEAGE_RATES[year] ?? null;
  return {
    year,
    tenthCentsPerMile: sellerTenthCents ?? irs,
    setBySeller: sellerTenthCents !== null,
    irsTenthCentsPerMile: irs,
  };
}

/** Miles at a rate in tenths of a cent, rounded half up to the cent. */
export function mileageDeductionCents(miles: number, tenthCentsPerMile: number): number {
  return Math.floor((miles * tenthCentsPerMile + 5) / 10);
}

export interface ExpenseRow {
  category: string;
  /** Money spent; null for miles. */
  amountCents: number | null;
  /** Miles driven; null for money spent. */
  miles: number | null;
}

export interface YearExpenseTotals {
  miles: number;
  trips: number;
  rate: MileageRateChoice;
  /** Null while the year has no rate. */
  deductionCents: number | null;
  spentCents: number;
  /** Money spent per category, the largest first, then by name. */
  categories: { category: string; spentCents: number; count: number }[];
  /** The deduction plus the money spent; null while the deduction is. */
  totalCents: number | null;
}

/**
 * The year's totals. The deduction prices all the year's miles at once (not entry by entry), so
 * it is exactly the year's miles at the rate. Categories are grouped as written, ignoring case.
 */
export function yearExpenses(
  rows: readonly ExpenseRow[],
  rate: MileageRateChoice,
): YearExpenseTotals {
  let miles = 0;
  let trips = 0;
  let spentCents = 0;
  const categories = new Map<string, { category: string; spentCents: number; count: number }>();
  for (const row of rows) {
    if (row.miles !== null) {
      miles += row.miles;
      trips += 1;
    }
    if (row.amountCents !== null) {
      spentCents += row.amountCents;
      const key = row.category.trim().toLocaleLowerCase('en-US');
      const entry = categories.get(key) ?? {
        category: row.category.trim(),
        spentCents: 0,
        count: 0,
      };
      entry.spentCents += row.amountCents;
      entry.count += 1;
      categories.set(key, entry);
    }
  }
  const deductionCents =
    rate.tenthCentsPerMile === null ? null : mileageDeductionCents(miles, rate.tenthCentsPerMile);
  return {
    miles,
    trips,
    rate,
    deductionCents,
    spentCents,
    categories: [...categories.values()].sort(
      (a, b) => b.spentCents - a.spentCents || a.category.localeCompare(b.category, 'en-US'),
    ),
    totalCents: deductionCents === null ? null : deductionCents + spentCents,
  };
}
