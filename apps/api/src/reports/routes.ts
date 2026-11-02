import type {
  CsvExport,
  Money,
  ReportTotals as ReportTotalsView,
  YearReport,
} from '@listora/api-contract';
import type { ItemStatus } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import {
  mileageDeductionCents,
  soldItemMoney,
  yearDays,
  yearExpenses,
  yearReport,
  type ReportTotals,
  type SoldItemMoney,
  type YearExpenseTotals,
} from '@listora/sales';
import { assertNever } from '@listora/shared';
import type { FastifyInstance } from 'fastify';

import { contractRoute } from '../contract/routes.ts';
import { validationFailed } from '../errors.ts';
import { loadMileageRate, yearExpenseRows } from '../expenses/repository.ts';
import { mileageRateView } from '../expenses/views.ts';
import type { ApiRouteContext } from '../features.ts';
import { feeRows, soldItemRows, type ProfitPeriodQuery } from '../profit/repository.ts';
import { dayIn, isTimeZone } from '../profit/routes.ts';
import { csvFile, dollars, integer, type CsvCell } from './csv.ts';
import {
  inventoryExportRows,
  salesExportRows,
  type HaulBasis,
  type InventoryExportRow,
  type SalesExportRow,
} from './repository.ts';

/**
 * The Reports screen (docs/features/reports.md): `getYearReport`, the year by month and by
 * marketplace, and the CSV exports of the year's sales (`exportSales`) and of the inventory
 * (`exportInventory`). They read only Listora's own rows: no marketplace or AI call. A number
 * Listora cannot compute reliably is left out, never guessed (`yearReport` in @listora/sales).
 */
export function registerReportRoutes(app: FastifyInstance, deps: ApiRouteContext): void {
  contractRoute(app, deps, 'getYearReport', async ({ tenant, db, query }) => {
    const period = yearPeriod(query);
    const [items, fees, expenseRows, rate] = await Promise.all([
      soldItemRows(db, tenant, period),
      feeRows(db, tenant, period),
      yearExpenseRows(db, tenant, query.year),
      loadMileageRate(db, tenant, query.year),
    ]);
    const report = yearReport({ year: query.year, items, fees });
    const expenses = yearExpenses(
      expenseRows.map((row) => ({
        category: row.category,
        amountCents: row.amount_cents,
        miles: row.miles,
      })),
      rate,
    );
    const net = report.total.netProfitCents;
    const body: YearReport = {
      year: report.year,
      timeZone: period.timeZone,
      total: totalsView(report.total),
      months: report.months.map((row) => ({ month: row.month, totals: totalsView(row) })),
      marketplaces: report.marketplaces.map((row) => ({
        marketplace: row.marketplace,
        totals: totalsView(row),
      })),
      expenses: expensesView(expenses),
      ...optional(
        'netAfterExpenses',
        net === null || expenses.totalCents === null ? null : money(net - expenses.totalCents),
      ),
    };
    return { status: 200, body };
  });

  contractRoute(app, deps, 'exportExpenses', async ({ tenant, db, query }) => {
    const [rows, rate] = await Promise.all([
      yearExpenseRows(db, tenant, query.year),
      loadMileageRate(db, tenant, query.year),
    ]);
    const perMile = rate.tenthCentsPerMile;
    const body: CsvExport = {
      fileName: `listora-expenses-${String(query.year)}.csv`,
      rowCount: rows.length,
      content: csvFile(
        EXPENSE_COLUMNS,
        rows.map((row) => [
          row.incurred_on,
          row.category,
          row.description,
          row.miles === null ? null : integer(row.miles),
          row.miles === null || perMile === null
            ? null
            : dollars(mileageDeductionCents(row.miles, perMile)),
          dollars(row.amount_cents),
          row.run_place,
        ]),
      ),
    };
    return { status: 200, body };
  });

  contractRoute(app, deps, 'exportSales', async ({ tenant, db, query }) => {
    const period = yearPeriod(query);
    const [rows, fees] = await Promise.all([
      salesExportRows(db, tenant, period),
      feeRows(db, tenant, period),
    ]);
    const items = soldItemMoney(rows, fees);
    const body: CsvExport = {
      fileName: `listora-sales-${String(query.year)}.csv`,
      rowCount: items.length,
      content: csvFile(SALES_COLUMNS, items.map(saleCells)),
    };
    return { status: 200, body };
  });

  contractRoute(app, deps, 'exportInventory', async ({ tenant, db, query }) => {
    const timeZone = checkedTimeZone(query.timeZone);
    const rows = await inventoryExportRows(db, tenant, timeZone);
    const body: CsvExport = {
      fileName: `listora-inventory-${dayIn(timeZone, deps.now())}.csv`,
      rowCount: rows.length,
      content: csvFile(INVENTORY_COLUMNS, rows.map(inventoryCells)),
    };
    return { status: 200, body };
  });
}

/**
 * One row per expense. A row's mileage deduction is its own miles at the year's rate, so the
 * rows can differ by a cent from the year's total, which prices all the year's miles at once.
 */
const EXPENSE_COLUMNS = [
  'Date',
  'Category',
  'Description',
  'Miles',
  'Mileage deduction',
  'Amount',
  'Sourcing trip',
] as const;

const SALES_COLUMNS = [
  'Sold on',
  'Marketplace',
  'Order number',
  'SKU',
  'Title',
  'Brand',
  'Category',
  'Sale price',
  'Shipping charged',
  'Fees',
  'Fees from',
  'Shipping cost',
  'Cost of goods',
  'Cost basis',
  'Profit',
] as const;

/**
 * One sold item: its price and its share of the order's shipping, fees, and label, as the sale
 * screen splits them. Fees and profit stay empty unless the marketplace's own fees are known;
 * cost and profit unless the item has a cost.
 */
function saleCells(item: SoldItemMoney<SalesExportRow>): CsvCell[] {
  const { row } = item;
  const feesKnown = item.feeSource === 'actual';
  const costKnown = row.costCents !== null;
  return [
    row.soldOn,
    MARKETPLACE_NAMES[row.marketplace],
    row.orderNumber,
    row.sku,
    row.title,
    row.brand,
    row.category,
    dollars(row.salePriceCents),
    dollars(item.revenueCents - row.salePriceCents),
    feesKnown ? dollars(item.feesCents) : null,
    feeSourceText(item),
    dollars(item.shippingCents),
    dollars(row.costCents),
    costBasis(row.costCents, row.haul),
    feesKnown && costKnown ? dollars(item.netProfitCents) : null,
  ];
}

function feeSourceText(item: SoldItemMoney<SalesExportRow>): string {
  switch (item.feeSource) {
    case 'actual':
      return MARKETPLACE_NAMES[item.row.marketplace];
    case 'estimated':
      return 'Estimate, not final';
    case 'none':
      return 'Not known';
    default:
      return assertNever(item.feeSource);
  }
}

const INVENTORY_COLUMNS = [
  'SKU',
  'Title',
  'Brand',
  'Category',
  'Size',
  'Condition',
  'Status',
  'Quantity',
  'Added on',
  'Purchase date',
  'Purchased from',
  'Cost',
  'Cost basis',
  'List price',
] as const;

function inventoryCells(row: InventoryExportRow): CsvCell[] {
  return [
    row.sku,
    row.title,
    row.brand,
    row.category,
    row.sizeLabel,
    row.condition,
    statusText(row.status),
    integer(row.quantity),
    row.addedOn,
    row.purchaseDate,
    row.purchaseSource,
    dollars(row.costCents),
    costBasis(row.costCents, row.haul),
    dollars(row.listPriceCents),
  ];
}

/** Where an item's cost comes from: its own, or its share of a haul. */
function costBasis(costCents: number | null, haul: HaulBasis | null): string {
  if (costCents === null) return 'No cost entered';
  if (haul === null) return 'Own cost';
  const total = dollars(haul.totalCents)?.csvNumber ?? '';
  return `Share of a $${total} haul of ${String(haul.itemCount)}`;
}

function statusText(status: ItemStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'ready':
      return 'Ready';
    case 'listed':
      return 'Listed';
    case 'sold_pending_delist':
    case 'sold':
      return 'Sold';
    case 'shipped':
      return 'Shipped';
    case 'archived':
      return 'Archived';
    default:
      return assertNever(status);
  }
}

/** The year's days in the seller's zone; the contract already holds the year to 2000-2100. */
function yearPeriod(query: { year: number; timeZone: string }): ProfitPeriodQuery {
  return { ...yearDays(query.year), timeZone: checkedTimeZone(query.timeZone) };
}

/** The zone, or `422` for one the runtime does not know. */
function checkedTimeZone(timeZone: string): string {
  if (!isTimeZone(timeZone)) {
    throw validationFailed(
      [{ field: 'timeZone', message: 'must be an IANA time zone, for example America/New_York' }],
      'The time zone is not known.',
    );
  }
  return timeZone;
}

function totalsView(totals: ReportTotals): ReportTotalsView {
  return {
    salesCount: totals.salesCount,
    itemsSold: totals.itemsSold,
    revenue: money(totals.revenueCents),
    shipping: money(totals.shippingCents),
    ...optional('fees', moneyOrNull(totals.feesCents)),
    feesUnknownCount: totals.feesUnknownCount,
    ...optional('costOfGoods', moneyOrNull(totals.costOfGoodsCents)),
    missingCostCount: totals.missingCostCount,
    ...optional('netProfit', moneyOrNull(totals.netProfitCents)),
  };
}

function expensesView(totals: YearExpenseTotals): YearReport['expenses'] {
  return {
    mileage: {
      miles: totals.miles,
      trips: totals.trips,
      rate: mileageRateView(totals.rate),
      ...optional('deduction', moneyOrNull(totals.deductionCents)),
    },
    spent: money(totals.spentCents),
    categories: totals.categories.map((entry) => ({
      category: entry.category,
      spent: money(entry.spentCents),
      count: entry.count,
    })),
    ...optional('total', moneyOrNull(totals.totalCents)),
  };
}

function money(amountCents: number): Money {
  return { amountCents, currency: 'USD' };
}

function moneyOrNull(amountCents: number | null): Money | null {
  return amountCents === null ? null : money(amountCents);
}

/** `{ [key]: value }`, or nothing for null: the contract omits a value it does not have. */
function optional<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return (value === null ? {} : { [key]: value }) as Partial<Record<K, V>>;
}
