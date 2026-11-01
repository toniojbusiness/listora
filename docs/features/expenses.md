# Expenses

Mileage and sourcing expenses for taxes: the miles of each thrift run and its other spend
(parking, tolls, a bin store's entry fee), plus any expense the seller adds by hand, totaled in
Reports ([reports.md](reports.md)) with the miles priced at the year's standard mileage rate,
which the seller can change. Code: `yearExpenses`, `mileageRate`, and `IRS_MILEAGE_RATES` in
`packages/sales/src/expenses.ts` (the math, pure), `apps/api/src/expenses` (the routes, the
repository, the checks), the checkout in `apps/api/src/sourcing-runs/routes.ts`, and the
iPhone's `SalesFeature` (`ReportsExpensesSection`, `ExpensesView`, `AddExpenseSheet`,
`MileageRateSheet`, `ReportsModel`) and `AddItemFeature` (`ScanCheckoutView`). No AI and no
marketplace call is involved.

## How it works

- **A run's start and end** are the sourcing run's own (`sourcing_run.started_at`, `ended_at`,
  [thrift-scan.md](thrift-scan.md#checkout-m4)). At checkout the seller may enter the miles driven
  (whole miles, up to 2,000) and one other spend with what it was for. In the same transaction as
  the haul, `checkoutSourcingRun` records the miles (more than 0) as a `Mileage` expense with the
  run's place as its description, and each `otherSpend` entry as a spend expense, all on the
  haul's day and linked to the run. A bad entry (nothing spent, not USD, an empty category) is a
  `422` naming it, and nothing is recorded: no haul, no expense. A retried checkout replays the
  first answer (its Idempotency-Key), so the trip's expenses are never recorded twice.
- **By hand**, from Reports > Expenses > Add: miles or money spent, a day in the year shown, what
  it was for, and an optional note (`createExpense`). An expense is exactly one of miles and an
  amount of at least 1 cent in USD; both or neither is `422`. Swipe to delete
  (`deleteExpense`); `replaceExpense` changes one. Each change shows only once the server answered,
  and the report and the list are read again; a failure says why and nothing changed.
- **A mileage row stores miles, never dollars.** The deduction is the year's miles at the year's
  rate, so a rate changed later reprices the whole year. The rate is in tenths of a cent per mile
  (`725` is 72.5 cents). Until the seller sets one (`setMileageRate`, Reports > Expenses > Rate),
  a year uses the IRS business rate Listora knows for it (`IRS_MILEAGE_RATES`: 65.5 cents for 2023,
  67 for 2024, 70 for 2025, 72.5 for 2026). For a year Listora knows no rate for and the seller set
  none, the miles are counted but not priced: the deduction, the expense total, and the profit
  after expenses are left out, never guessed. Add each new year's IRS rate to the table when the
  IRS announces it.
- **In Reports** (`getYearReport`'s `expenses`): the year's miles, trips, the rate (the seller's
  or the IRS's) and the deduction, rounded half up to the cent over all the year's miles at once;
  the money spent in total and per category (grouped ignoring case, the largest first); the total;
  and `netAfterExpenses`, the year's profit less the total, only when both are known. Expenses
  count by the day each was incurred (a calendar date, so no time zone).
- **The CSV** (`exportExpenses`, `listora-expenses-<year>.csv`, the same format as the other
  exports, [reports.md](reports.md#the-csv-files)): Date, Category, Description, Miles, Mileage
  deduction (that row's miles at the rate, so rows can differ by a cent from the year's total),
  Amount, and Sourcing trip (the run's place).

## On the iPhone (Hang Tag)

The Reports screen keeps its tag for the sales; the expenses are ruled under the marketplaces,
with no box: Mileage ("43 miles, 2 trips · 72.5¢ a mile, IRS rate") and its deduction, each
spend category, Total expenses in Fraunces, and Profit after expenses (red when negative). A
number the server left out reads "Not known yet" with why. The header's Rate opens the year's
rate in cents a mile (the IRS rate for the year as a hint). "Add or review expenses" opens the
year's ruled list, with Add and swipe to delete. The Export section adds "Expenses in <year>".
The checkout sheet adds "Other trip spend (optional)" and, once it has an amount, "What it was
for" ("Trip spend" when left empty).

The app needs a new build for these screens and the checkout field; the server's part applies
with a deploy and its migration.

## Local development

Nothing needs a credential. `packages/sales/src/expenses.test.ts` covers the math (the rate
choice, rounding, categories, a year without a rate), `apps/api/src/expenses/expenses.int.test.ts`
the API on a real Postgres (miles and money, the checks, the rate, the report and the CSV, other
accounts), `apps/api/src/sourcing-runs/sourcing-runs.int.test.ts` the checkout's expenses (and a
bad spend refusing the whole checkout), and `ReportsModelTests` and `ScanCheckoutTests` the app's
side against fakes.

## Data

- `expense` (schema v1) gains `kind` (`mileage` or `spend`), `miles` (mileage only),
  `sourcing_run_id` (the run it was entered at checkout for; set null if the run goes), and
  `amount_cents` becomes nullable: a mileage row has miles and no amount, a spend row an amount
  and no miles (`expense_kind_whole`). One mileage row per run (`expense_run_mileage_idx`), and
  the year's rows by day (`expense_incurred_on_idx`).
- `mileage_rate`: the seller's rate per year, `tenth_cents_per_mile`, 0 to 10,000.
- Migration `20261101014333_mileage_expenses` also records the miles of runs checked out before
  it as their mileage expenses, on the haul's day.

## Follow-ups

- Editing an expense on the iPhone (the API's `replaceExpense` exists; the app deletes and adds).
- Receipts (a photo per expense) and more than one other spend at checkout.
- The rate per vehicle or the actual-expense method; Listora offers only the standard rate.
