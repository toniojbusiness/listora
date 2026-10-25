# Sales: mark sold, the sale lifecycle, fees, and profit

Plan task T-26. A seller records a sale Listora did not see ("Mark as sold"), moves a sale
through its lifecycle (confirmed, shipped, or canceled or returned), and sees each sale's fees,
payout, profit, and ROI. Listora never relists by itself: after a cancel or return it asks the
seller whether to relist the item and where, then relists through the operation engine. Code:
`packages/sales` (`lifecycle.ts`, `fees.ts`, `money.ts`, and `recordSale` in `sales.ts`),
`apps/api/src/sales`, the worker's `sale-fees.ts`, the adapters' `readOrderFees`
(`packages/marketplaces`), and the iPhone's `SalesFeature`.

## Mark as sold: the same intake as a detected sale

`createSale` (`POST /v1/sales`) takes the marketplace, one or more items with each one's sale
price (a bundle is one order), the shipping the buyer paid, the sold time (now by default, never
in the future), and an optional order number. It stores an `inbound_event` (source `manual`) and
calls `recordSale`, exactly as eBay's webhook and the order poll do
([auto-delist.md](auto-delist.md)), so the sale's auto-delist starts in the same transaction:
every other listing that may be live gets its delist operation or an urgent assisted task, and
an item that already sold opens a double-sale incident. It answers `422` for an item listed twice,
a listing that is not that item's on the marketplace, or a negative amount; `404` for another
account's item; and `409 already_exists` for an order number Listora already recorded.

## The lifecycle

```text
detected ──confirm──▶ confirmed ──mark_shipped──▶ shipped ──record_return──▶ returned
   │  └──────────mark_shipped──────────▲   │
   └──cancel──▶ canceled ◀──cancel─────────┘   confirmed ──record_return──▶ returned
```

`Sale.availableActions` lists what a sale allows now (`availableSaleActions`), and the app shows
only those. Each step is a POST with an `Idempotency-Key`; a step the status does not allow is
`409 invalid_state_transition`. Every change locks the sale, then its items, and writes the
items' audit log.

- **Confirm** (`confirmSale`) records `confirmed_at`.
- **Ship** (`markSaleShipped`) records `shipped_at`, the label cost the seller paid outside the
  payout (`shippingCost`, optional), and moves the items to `shipped`.
- **Cancel** (`cancelSale`, before shipping) and **return** (`recordSaleReturn`, once confirmed
  or shipped). The sale no longer stands, so:
  - its delists that reached no marketplace yet are canceled (`cancelUnsentDelists` in
    `@listora/operations`: queued or waiting to retry and never sent through an API, or waiting
    for the seller, whose task is dismissed). A delist that may have reached the marketplace
    finishes, and its read-back records what is true. Canceled delists raise no SLA alerts;
  - a double-sale incident the sale was part of is resolved;
  - each item with no other sale that stands goes back to `listed` (a listing is still active)
    or `ready`, and its relist decision (`sale_item.relist_decision`) becomes `pending`.

## Relist only by the seller's choice

While a decision is `pending`, the sale's item carries `relist.options`: the item's newest
listing on each marketplace with its honest status and `canRelist`, which is true only where the
item screen would offer Relist (an ended or sold listing Listora wrote, with nothing running, in
API mode). `getItem` adds `relistPrompt`, and the app asks "Relist it?". `decideSaleRelist`
records the answer per item: the listings to relist, each queued as a `relist` operation with
the listing actions' own checks (`relistListing` in `apps/api/src/listings/actions.ts`), or
none (`declined`). A listing that is not offered is `422`; a second answer is `409`. Assisted
marketplaces are relisted by the seller in the marketplace's app until assisted actions land
with the task inbox (T-21).

## Fee lines

Every sale has its fees as `fee_line` rows (marketplace, payment, shipping label, promotion,
tax, other), each `estimated` or `actual`:

- **Estimated at once.** `recordSale` adds one line per rule of the marketplace's fee table in
  effect on the sold day (`estimateFeeLines` in `@listora/pricing`, [pricing.md](pricing.md)),
  computed on the order's total sale price (so eBay's per-order fee is charged once per order),
  with the rule's name and the table's version.
- **Actual when the marketplace reports them.** For a sale with an order id on a marketplace
  whose adapter has `readOrderFees` and an API connection, recording it queues the `sale_fees`
  job. The job asks the marketplace and, once it answers, replaces the estimated lines with the
  actual ones in one transaction, so a sale never mixes the two. eBay's fees come from the
  Finances API (`getTransactions` by order id: the `SALE` transaction's marketplace fees,
  `SHIPPING_LABEL`, and Promoted Listings `AD_FEE` charges; [ebay.md](ebay.md)); Depop's from
  the order's `seller_fee_breakdown` ([depop.md](depop.md)). Not reported yet, or a temporary
  failure: the job runs again after 2 minutes, then 10, 1 hour, 6 hours, and 24 hours, and then
  stops. No access (a connection granted before Listora asked for `sell.finances`), an unknown
  order, or no fee at all: the sale keeps its estimate.

## Payout, profit, and ROI

`saleMoney` (`money.ts`) computes, in integer cents:

- **Payout** (`netProceeds`): the sale price plus the shipping the buyer paid, minus every fee.
- **Profit**: the payout minus the label cost the seller paid outside the payout (zero until
  known) minus the items' cost; absent until every item has a cost.
- **ROI** (`roiBasisPoints`): the profit over the cost, in basis points; absent for a zero cost.
- **Estimates.** `feesEstimated` is true while any line is estimated, and the app labels the
  payout and profit "(estimated)".
- **Bundles.** Order-level amounts (shipping charged, order fees, label cost) are split across
  the items by sale price, largest remainder first, so the items' shares add up exactly.

`Sale` shows the order's money and each item's share; `Item.saleSummary` shows the item's share
of its latest sale that stands.

## On the iPhone

- **Item screen.** "Mark as sold" (for a draft, ready, or listed item) opens the form: where it
  sold (the marketplaces it is listed on first), what each item sold for (the list price to start
  with; "Add item" adds bundle items), the shipping the buyer paid, the day, and an optional order
  number. It keeps one Idempotency-Key per filled-in form, so a lost answer never records two
  sales. A sold item shows a "Sold" card with its profit, ROI, and the delist run's status; after
  a cancel or return it shows "Relist it?".
- **Sale screen.** The header and status, "Relist it?" with one choice per relistable listing,
  the delist on every other marketplace as the server words it (it keeps reading the server while
  a delist runs), the fees with "Estimated" or "From <marketplace>", payout, label, cost, profit,
  and ROI, and the actions the sale allows (cancel and return ask first).
- **Sales tab.** Recent sales, newest first, with price and profit ("Est. profit" while fees are
  estimated), and the way to the profit dashboard ([profit.md](profit.md)).

## Local development

Nothing needs a credential. The fake eBay serves the Finances API's `getTransactions` (13.6% of
the item price and shipping plus the per-order fee), and the fake Depop the order fee breakdown.
The local stack's control endpoint seeds an item live on eBay (`POST /items/listed`), which
`SaleFlowUITests` marks sold on Depop, cancels, and relists on eBay.

## Data

Migration `20261025123116_sale_lifecycle`:

- `sale`: status `shipped`; `confirmed_at`, `shipped_at`, `canceled_at`, `returned_at` (each
  required by its status); `shipping_cost_cents` (the label cost outside the payout).
- `sale_item`: `relist_decision` (`pending`, `relisted`, `declined`; null while the sale stands)
  and `relist_decided_at`.
- `fee_line`: `description` and, for estimated lines, `fee_table_version`.
