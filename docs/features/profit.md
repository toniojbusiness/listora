# Profit dashboard

A captain-picked feature on top of the sales records and fee lines ([sales.md](sales.md)). The
seller picks a period (a calendar week, month, or year, or a custom range) and sees revenue, fees,
shipping, cost of goods, net profit, ROI, the number of sales, the averages, sell-through, a chart
over time, their own totals per marketplace, the best and worst brands and categories, and dead
stock. Code: `profitReport` in `packages/sales/src/profit.ts` (the math, pure),
`apps/api/src/profit` (`getProfit` and its queries), and the iPhone's `SalesFeature`
(`ProfitView`, `ProfitModel`, `ProfitPeriod`). No AI and no marketplace call is involved.

## The report

`getProfit` (`GET /v1/profit?from=&to=&timeZone=`) takes the period's first and last day
(inclusive) in the seller's IANA time zone. It answers `422` for an unknown time zone, a period
that ends before it starts, or one longer than 3660 days.

- **Which sales count.** Sales that stand (detected, confirmed, or shipped) that sold within the
  period's days in the seller's time zone. A canceled or returned sale counts nowhere.
- **The same money as the sale screen.** Each item's share of its order's shipping charged,
  order-level fees, and label cost is split by sale price with `splitByWeight`, exactly as
  `saleMoney` splits them, so an item's profit here equals its `Sale` profit to the cent.
- **The lines add up.** Revenue is the sale prices plus the shipping buyers paid. Fees are every
  fee line except shipping labels. Shipping is the labels the marketplace deducted
  (`shipping_label` lines) plus labels bought outside the payout (`Sale.shippingCost`). Net profit
  is revenue minus fees, shipping, and cost of goods. ROI is net profit over cost of goods.
- **Missing costs.** An item sold without a cost counts as zero cost. `missingCostCount` says how
  many there are, and the app warns that the profit is overstated until the costs are entered.
- **Estimates.** `feesEstimated` is true while any of the period's fee lines is an estimate; the
  app then labels the net profit "(estimated)".
- **Averages.** Average sale price and average profit per item are over the items sold. Days to
  sell run from the item's first listing before the sale or, never listed through Listora, from
  when it was added (zero when it was added after it sold).
- **Sell-through.** Items sold over items sold plus the items listed now that were added by the
  period's end. It is an approximation for past periods: Listora does not keep a history of what
  was listed when.
- **Series.** One bucket per day up to 31 days, per week (Monday to Sunday) up to 184 days, and
  per month beyond. Empty buckets are included; the first starts on the period's first day.
- **Brands and categories.** Matched ignoring case and surrounding spaces, ranked by net profit:
  the best five, then the worst five of the rest (never the same group in both). Items without a
  brand or category are left out.
- **Dead stock.** Draft, ready, and listed items by age today, whatever the period: days since
  the purchase date or, without one, since the item was added. Over 60 and over 90 days: the
  count, the cost tied up, and how many have no cost; and the five oldest items over 60 days.

### Marketplaces side by side, never ranked

eBay's API License Agreement forbids displaying eBay's performance relative to another service's
(for example sales volume or velocity) without eBay's written consent. So the per-marketplace
breakdown is only the seller's own totals (sales, items, revenue, fees, shipping, cost, net
profit) in the fixed `KnownMarketplace` order, with no ranking, share, chart, best or worst, or
days to sell. Comparisons wait for the legal review.

## Speed

One request runs four queries in parallel: the period's sold items (a range scan on
`sale_sold_at_idx`, one row per sold item), its fee lines summed per sale, item, and label or not,
the count of listed items, and the dead-stock aggregates. The splitting and ranking run in memory
over the period's sold items, which keeps the dashboard and the sale screen equal to the cent.

## On the iPhone

The Sales tab has a Profit button in the toolbar and a "Profit dashboard" card above the sales.
The screen opens on this month in the phone's calendar and time zone. Week, Month, and Year step
back and forward through whole periods (never past the one that contains today); Custom picks the
first and last day. It shows the net profit with the lines that make it up, the counts and
averages, a Swift Charts bar chart of net profit or revenue over the period, the marketplace
totals, the best and worst brands and categories with bars proportional to their profit, and dead
stock. Every number is the server's; while a new period loads, the old one is dimmed, and a
failure keeps it with a Retry.

## Local development

Nothing needs a credential. `ProfitDashboardUITests` records a sale through the local stack's API
and checks that the screen shows the server's totals.

## Data

Migration `20261025132636_profit_dashboard` adds `sale_sold_at_idx` on `sale (account_id,
sold_at)`. Expenses (`expense`) are not in the report yet.
