# Reports

For taxes and bookkeeping: a calendar year's sales, revenue, marketplace fees, shipping, cost of
goods, and profit, in total, by month, and by marketplace, plus CSV files of the year's sales and
of the inventory, shared from the iPhone through the share sheet. Code: `yearReport` in
`packages/sales/src/reports.ts` (the math, pure), `apps/api/src/reports` (`getYearReport`,
`exportSales`, `exportInventory`, the CSV writer), and the iPhone's `SalesFeature` (`ReportsView`,
`ReportsModel`, `ReportsService`). No AI and no marketplace call is involved.

## The year

`getYearReport` (`GET /v1/reports/year?year=&timeZone=`) covers January 1 to December 31 in the
seller's IANA time zone. A year outside 2000 to 2100 or an unknown time zone is `422`.

- **Which sales count.** Sales that stand (detected, confirmed, or shipped) sold within the year
  in the seller's time zone. A canceled sale and a returned (refunded) one count nowhere, in the
  report or the export.
- **The same money as every other screen.** Each sold item's money is `soldItemMoney`, the split
  the profit dashboard ([profit.md](profit.md)) and the sale screen use, so the three agree to the
  cent. Revenue is the sale prices plus the shipping buyers paid; shipping is the labels the
  marketplace deducted plus labels bought outside the payout; fees are every other fee line.
- **Haul costs.** An item from a haul costs its share ([hauls.md](hauls.md#shares-and-rounding)):
  $10 over 3 items is $3.34, $3.33, and $3.33, so the shares add back up to the haul.
- **Nothing guessed.** A total leaves out a number Listora cannot compute reliably:
  - `fees` while any of its sales' fees are still the fee table's estimate or have no fee line
    at all (`feesUnknownCount` says how many sales); the marketplace's own fees replace the
    estimate when its API reports them ([sales.md](sales.md#fee-lines)), so today only sales on
    an API-connected eBay or Depop account have them;
  - `costOfGoods` while any sold item has no cost (`missingCostCount`);
  - `netProfit` while either is left out.

  Revenue, shipping, and the counts are always given. Unlike the profit dashboard, which counts
  a missing cost as zero and labels estimated fees, a report for taxes shows only what is final.

- **Months and marketplaces.** All twelve months, January first, empty ones with zero totals.
  The marketplaces with a sale, side by side in the fixed order and never ranked, as on the
  profit dashboard ([profit.md](profit.md#marketplaces-side-by-side-never-ranked)).

## The CSV files

`exportSales` (`GET /v1/reports/sales-export?year=&timeZone=`) and `exportInventory`
(`GET /v1/reports/inventory-export?timeZone=`) answer `CsvExport`: the file's name, its row count,
and its text. The contract is JSON throughout, so the file travels as a string and the app saves
it.

- **Format.** RFC 4180 (commas, double quotes where a cell needs them, CRLF), UTF-8 with a byte
  order mark so Excel and Numbers read accents right. Amounts are plain decimal dollars (`12.50`)
  and days `YYYY-MM-DD`. A text cell a spreadsheet would run as a formula (starting with `=`, `+`,
  `-`, `@`, a tab, or a carriage return) gets a leading apostrophe; numbers never do.
- **Sales** (`listora-sales-<year>.csv`): one row per item sold on a sale that stands, oldest
  first, a bundle's items together. Sold on, Marketplace, Order number, SKU, Title, Brand,
  Category, Sale price, and the item's share of Shipping charged, Fees, and Shipping cost, then
  Cost of goods, Cost basis ("Own cost", "Share of a $10.00 haul of 3", or "No cost entered"),
  and Profit. Fees is empty unless they are the marketplace's own, and "Fees from" says which
  ("eBay", "Estimate, not final", or "Not known"); Profit is empty unless both fees and cost are
  known. The rows' known profits add up to the report's.
- **Inventory** (`listora-inventory-<today>.csv`): every item the seller has, by SKU. SKU, Title,
  Brand, Category, Size, Condition, Status, Quantity, Added on, Purchase date, Purchased from,
  Cost, Cost basis, and List price.

## On the iPhone

The Sales tab has a "Reports and exports" row under the profit dashboard's. The screen opens on
this year in the phone's time zone, with arrows to step back through years (never past this one).
The year's revenue is on a price tag in Fraunces, with its sales and items, then Fees, Shipping,
Cost of goods, and Profit; a number the server left out reads "Not known yet" with why ("2 sales'
fees aren't final from the marketplace", "1 sold item has no cost"). Below the tag, ruled rows
(no boxes): each month with sales, then each marketplace, with its revenue and its profit or why
the profit waits. "Export for taxes" prepares the sales file for the year shown and the inventory
file; once saved in the app's temporary folder (with complete file protection), Share opens the
share sheet (Save to Files, Mail, AirDrop, and so on). Changing the year drops the sales file made
for the last one. Every number is the server's; a failure keeps the last report with a Retry, and
a failed export says why with Try again.

The app needs a new build for this screen.

## Local development

Nothing needs a credential. `packages/sales/src/reports.test.ts` covers the math (months,
marketplaces, the left-out numbers, a bundle equal to its sale's own money),
`apps/api/src/reports/csv.test.ts` the CSV writer (quoting, the formula guard, dollars), and
`apps/api/src/reports/reports.int.test.ts` the API on a real Postgres (a $10 haul of 3 sold as
$3.34 and $3.33, a returned and a canceled sale left out, estimated fees and a missing cost left
out, the time zone at New Year, both files, other accounts). `ReportsModelTests` covers the app's
model against a fake server (the year, the files saved byte for byte, failures).

## Data

No new table or migration: the reports read `sale`, `sale_item`, `fee_line`, `inventory_item`, and
`haul`, the year through `sale_sold_at_idx` ([profit.md](profit.md#data)).

## Follow-ups

- Expenses (`expense`) and mileage are not in the report yet, nor sales tax collected.
- Poshmark's and Mercari's fees stay estimated (their checks show none), so their sales' fees and
  profit stay out of the report until Listora reads them.
