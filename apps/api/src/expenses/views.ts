import type { Expense, MileageRate } from '@listora/api-contract';
import type { MileageRateChoice } from '@listora/sales';

import type { ExpenseRow } from './repository.ts';

export function expenseView(row: ExpenseRow): Expense {
  return {
    id: row.id,
    incurredOn: row.incurred_on,
    category: row.category,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.amount_cents === null
      ? {}
      : { amount: { amountCents: row.amount_cents, currency: row.currency } }),
    ...(row.miles === null ? {} : { miles: row.miles }),
    ...(row.sourcing_run_id === null ? {} : { sourcingRunId: row.sourcing_run_id }),
    createdAt: row.created_at.toISOString(),
  };
}

export function mileageRateView(rate: MileageRateChoice): MileageRate {
  return {
    year: rate.year,
    setBySeller: rate.setBySeller,
    ...(rate.tenthCentsPerMile === null ? {} : { tenthCentsPerMile: rate.tenthCentsPerMile }),
    ...(rate.irsTenthCentsPerMile === null
      ? {}
      : { irsTenthCentsPerMile: rate.irsTenthCentsPerMile }),
  };
}
