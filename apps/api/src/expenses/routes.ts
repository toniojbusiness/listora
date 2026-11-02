import type { ExpenseList } from '@listora/api-contract';
import { inTransaction } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import type { ApiRouteContext } from '../features.ts';
import {
  deleteExpense,
  insertExpenses,
  loadMileageRate,
  saveMileageRate,
  updateExpense,
  yearExpenseRows,
} from './repository.ts';
import { expenseValues } from './values.ts';
import { expenseView, mileageRateView } from './views.ts';

/**
 * Expenses for taxes (docs/features/expenses.md): `listExpenses`, `createExpense`,
 * `replaceExpense`, `deleteExpense`, and the year's standard mileage rate (`getMileageRate`,
 * `setMileageRate`). Reports totals them (`getYearReport`, `exportExpenses`).
 */
export function registerExpenseRoutes(app: FastifyInstance, deps: ApiRouteContext): void {
  contractRoute(app, deps, 'listExpenses', async ({ tenant, db, query }) => {
    const rows = await yearExpenseRows(db, tenant, query.year);
    const body: ExpenseList = { year: query.year, expenses: rows.map(expenseView) };
    return { status: 200, body };
  });

  contractRoute(app, deps, 'createExpense', async ({ tenant, db, body }) => {
    const [row] = await insertExpenses(db, tenant, [expenseValues(body)]);
    if (!row) throw new Error('The expense insert returned no row.');
    return { status: 201, body: expenseView(row) };
  });

  contractRoute(app, deps, 'replaceExpense', async ({ tenant, db, params, body }) => {
    const row = await updateExpense(db, tenant, params.expenseId, expenseValues(body));
    if (!row) throw notFound('Expense');
    return { status: 200, body: expenseView(row) };
  });

  contractRoute(app, deps, 'deleteExpense', async ({ tenant, db, params }) => {
    if (!(await deleteExpense(db, tenant, params.expenseId))) throw notFound('Expense');
    return { status: 204 };
  });

  contractRoute(app, deps, 'getMileageRate', async ({ tenant, db, query }) => ({
    status: 200,
    body: mileageRateView(await loadMileageRate(db, tenant, query.year)),
  }));

  contractRoute(app, deps, 'setMileageRate', async ({ tenant, db, query, body }) =>
    inTransaction(db, async (trx) => {
      await saveMileageRate(trx, tenant, query.year, body.tenthCentsPerMile);
      return {
        status: 200,
        body: mileageRateView(await loadMileageRate(trx, tenant, query.year)),
      };
    }),
  );
}
