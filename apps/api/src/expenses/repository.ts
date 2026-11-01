/**
 * Expenses and mileage rates (docs/features/expenses.md). Every function takes the request's
 * `Tenant` and filters on its account.
 */
import type { DbExecutor, ExpenseTable } from '@listora/db';
import { mileageRate, type MileageRateChoice } from '@listora/sales';
import type { Insertable, Selectable } from 'kysely';

import type { Tenant } from '../tenancy.ts';

export type ExpenseRow = Selectable<ExpenseTable>;

/** An expense as written: miles or money, never both (`expense_kind_whole`). */
export interface ExpenseValues {
  incurredOn: string;
  category: string;
  description: string | null;
  amountCents: number | null;
  miles: number | null;
  sourcingRunId?: string | null;
}

function columns(
  tenant: Tenant,
  values: ExpenseValues,
): Omit<Insertable<ExpenseTable>, 'id' | 'created_at' | 'updated_at'> {
  return {
    account_id: tenant.accountId,
    incurred_on: values.incurredOn,
    category: values.category,
    description: values.description,
    kind: values.miles === null ? 'spend' : 'mileage',
    amount_cents: values.amountCents,
    miles: values.miles,
    currency: 'USD',
    sourcing_run_id: values.sourcingRunId ?? null,
  };
}

export async function insertExpenses(
  db: DbExecutor,
  tenant: Tenant,
  values: readonly ExpenseValues[],
): Promise<ExpenseRow[]> {
  if (values.length === 0) return [];
  return db
    .insertInto('expense')
    .values(values.map((value) => columns(tenant, value)))
    .returningAll()
    .execute();
}

export async function updateExpense(
  db: DbExecutor,
  tenant: Tenant,
  id: string,
  values: ExpenseValues,
): Promise<ExpenseRow | undefined> {
  // The run an expense was entered for stays as it is.
  const { incurred_on, category, description, kind, amount_cents, miles } = columns(tenant, values);
  const changes = { incurred_on, category, description, kind, amount_cents, miles };
  return db
    .updateTable('expense')
    .set(changes)
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteExpense(db: DbExecutor, tenant: Tenant, id: string): Promise<boolean> {
  const result = await db
    .deleteFrom('expense')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', id)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** The year's expenses with the place of the run each was entered for, oldest day first. */
export async function yearExpenseRows(
  db: DbExecutor,
  tenant: Tenant,
  year: number,
): Promise<(ExpenseRow & { run_place: string | null })[]> {
  return db
    .selectFrom('expense')
    .leftJoin('sourcing_run', (join) =>
      join
        .onRef('sourcing_run.account_id', '=', 'expense.account_id')
        .onRef('sourcing_run.id', '=', 'expense.sourcing_run_id'),
    )
    .selectAll('expense')
    .select('sourcing_run.place as run_place')
    .where('expense.account_id', '=', tenant.accountId)
    .where('expense.incurred_on', '>=', `${String(year)}-01-01`)
    .where('expense.incurred_on', '<=', `${String(year)}-12-31`)
    .orderBy('expense.incurred_on')
    .orderBy('expense.id')
    .limit(5000)
    .execute();
}

/** The year's rate: the seller's own, else the IRS rate Listora knows. */
export async function loadMileageRate(
  db: DbExecutor,
  tenant: Tenant,
  year: number,
): Promise<MileageRateChoice> {
  const row = await db
    .selectFrom('mileage_rate')
    .select('tenth_cents_per_mile')
    .where('account_id', '=', tenant.accountId)
    .where('year', '=', year)
    .executeTakeFirst();
  return mileageRate(year, row?.tenth_cents_per_mile ?? null);
}

export async function saveMileageRate(
  db: DbExecutor,
  tenant: Tenant,
  year: number,
  tenthCentsPerMile: number,
): Promise<void> {
  await db
    .insertInto('mileage_rate')
    .values({ account_id: tenant.accountId, year, tenth_cents_per_mile: tenthCentsPerMile })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'year'])
        .doUpdateSet({ tenth_cents_per_mile: tenthCentsPerMile }),
    )
    .execute();
}
