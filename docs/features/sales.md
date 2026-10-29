# Sales: mark sold, the sale lifecycle, fees, and profit

Plan task T-26. A seller records a sale Listora did not see ("Mark as sold"), moves a sale
through its lifecycle (confirmed, shipped, or canceled or returned), and sees each sale's fees,
payout, profit, and ROI. Listora never relists by itself: after a cancel or return it asks the
seller whether to relist the item and where, then relists through the operation engine. Code:
`packages/sales` (`lifecycle.ts`, `fees.ts`, `money.ts`, and `recordSale` in `sales.ts`),
`apps/api/src/sales`, the worker's `sale-fees.ts`, the adapters' `readOrderFees`
(`packages/marketplaces`), sold items for the sales history (`packages/imports/src/sold.ts`), and
the iPhone's `SalesFeature`.

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

## Sales history

Connecting a marketplace brings in every sale the seller made there, not only the ones of
Listora's listings, and keeps it current: the sale checks of an automation connection
([automation.md](automation.md)) read the seller's sold orders, and each one becomes a sale.

- **The first check reads the whole history**: every sold order the marketplace's pages show,
  up to each adapter's history limit (Depop 600 sales, Poshmark 1,200, Mercari 25 pages and 60
  listing pages per tab), handed to the sale intake like any order. Later checks read the
  orders since the last. Migration `20261028095905_sales_history` made every existing
  connection's next check a full read, and a full read hands over again, once, an order an
  earlier check dropped (`history:order:<id>`, before sold items existed). An app built before
  this keeps working (the phone's call protocol is unchanged): its checks send no sold listing,
  so such a sale's sold item has only the order's title and price until the app updates.
- **A sold item without photos gets them later.** A check that reads an order already recorded,
  with its sold listing's photos, while the order's sold item has no photo at all, stores the
  order once more (`photos:order:<id>:<check>`, payload `purpose: 'photos'`) and queues
  `automation_sold_item_photos` (`packages/automation/src/sale-checks/sold-photos.ts`). The
  worker fetches up to 4 of them from the marketplace's image CDN (`soldItemPhotoMaker` in
  `@listora/imports`, as an import fetches photos, outside any transaction) and adds them to the
  item while it still has none, each processed like any photo (its 640 px thumbnail and listing
  size, [photos.md](photos.md)); the event ends `processed`, or `ignored` when none could be
  fetched or the item has photos by then, and the next check that reads the order tries again.
  It reads no extra page: the photos are the ones the check's own read showed. Migration
  `20261028152207_sold_item_photos` makes the next check of each Mercari connection with such a
  sold item a full read once more, so the sales an older app recorded get theirs (Poshmark's
  sales work is paused; its sold items get photos the same way at its next full read).
- **A sale of a listing Listora doesn't have** (sold before Listora was connected, or listed on
  the marketplace itself) becomes a **sold item**: the worker's `automation_sale_order` job makes
  the item from the sold listing as the sold pages showed it (`soldItemMaker` in
  `@listora/imports`: the title, text, brand, size, condition, category, and up to 4 photos,
  fetched from the marketplace's image CDN the way an import fetches them, outside the
  transaction), with that listing on its marketplace, `sold`, and records the sale on it.
  Without the listing, the order line's title makes it; with neither, nothing is recorded (the
  event is `ignored`). A photo that can't be fetched is left out; the sale is still recorded. A
  sold listing never joins an item Listora has, even one that looks the same: a wrong match
  would delist that item everywhere else. Nothing on the marketplace changes.
- **What the marketplace says of the order counts.** The sale price is what the buyer paid for
  each item (Depop's receipt: an accepted offer or a bundle discount, not the listing's price).
  An order the marketplace says shipped or was delivered (Depop's receipts, Mercari's sold tab)
  is recorded `shipped`. Fees the marketplace shows replace the estimate at once (Depop's
  receipt: what the items sold for less what the seller is paid, one actual "Depop's fees" line,
  so the payout is Depop's to the cent, the Boost fee included); elsewhere they stay estimated.
- **The sales history is recorded only.** A sale that sold before the connection's history ends
  (`sale_check_schedule.history_until`: when the marketplace was linked, its first check due at
  once; for a connection linked before this, the deploy that brought sales history in) has the
  detection source `history` ("Found in your Depop sales history."), of a Listora listing too. Its items are marked sold and nothing else happens: no
  auto-delist, delist run, or delist of any other listing, no notification, no Today ship card,
  and no Pack check order, unless the marketplace's order page says it still waits to ship
  ([pack-check.md](pack-check.md), "The to-ship list"). Only a sale that sold after the history
  ends is acted on.
- **One sale, reported twice.** A sale the seller marked sold by hand on a marketplace and then
  found there by a check (or its history) is the same order, not a double sale
  (`findSaleOfSameListing`, `@listora/sales`).

### In total and per marketplace

`getSalesSummary` (`GET /v1/sales/summary`) adds up the sales that stand (detected, confirmed,
shipped), all time: the number of sales (a bundle is one), the items sold, and the revenue (the
sale prices plus the shipping buyers paid, as the profit dashboard counts it), in total and per
marketplace, with when the first one sold. Each marketplace with a sale or a connected account
is listed, in the fixed `KnownMarketplace` order and never ranked
([profit.md](profit.md#marketplaces-side-by-side-never-ranked): eBay's licence forbids
comparing). The sales feed (`listSales`) lists sales newest sold first (then newest recorded), so
a history recorded at once still reads in order, or in another order by date, price, or profit
([sorting.md](sorting.md)); its cursor keeps the last sale's place in the order.

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
  and ROI, "How Listora found it" (which check saw the sale, where and when, and each delist's
  result and when it settled; [activity.md](activity.md)), and the actions the sale allows
  (cancel and return ask first).
- **Sales tab.** All your sales on a price tag (Hang Tag, [design.md](design.md)): the total
  across every marketplace in Fraunces, how many sales and items since when, and each marketplace
  on the tag's string, a bead each with its own sales and revenue (a marketplace without a sale
  yet hangs on a loose string, "No sales yet"). Then the sales, newest sold first or in the order
  the Sort pill above them picks ([sorting.md](sorting.md)), each with
  its sold item's photo (the item's thumbnail, `SaleItem.thumbnailUrl`; the marketplace's initial
  until it has one), price and profit ("Est. profit" while fees are estimated), and the way to
  the profit dashboard ([profit.md](profit.md)) and to the year's reports and CSV exports
  ([reports.md](reports.md)).

## Local development

Nothing needs a credential. The fake eBay serves the Finances API's `getTransactions` (13.6% of
the item price and shipping plus the per-order fee), and the fake Depop the order fee breakdown.
The local stack's control endpoint seeds an item live on eBay (`POST /items/listed`), which
`SaleFlowUITests` marks sold on Depop, cancels, and relists on eBay. The fake Depop site sells
listings with Depop's own receipts (an accepted offer, a bundle, shipped or not, canceled) and
lets the seller mark one as sold elsewhere (`FakeDepopSite.sell`, `sellBundle`, `markAsSold`).

Tests: `packages/imports/src/sold.int.test.ts` (sold items from a check's orders, with and
without the listing, never joining an item, without photos),
`packages/automation/src/sale-checks/sale-checks.int.test.ts` (the full history read and a
dropped order handed over again), `packages/sales/src/same-order.int.test.ts`,
`packages/imports/src/sold-photos.int.test.ts` (a sold item made without photos gets its sold
listing's from a later full read, once; a CDN that doesn't give them, and the next try; an item
that got photos meanwhile), `apps/api/src/sales/summary.int.test.ts` (with each sale item's
thumbnail), and the app's `SalesSummaryTests` and `SalesModelsTests`.

## Data

Migration `20261025123116_sale_lifecycle`:

- `sale`: status `shipped`; `confirmed_at`, `shipped_at`, `canceled_at`, `returned_at` (each
  required by its status); `shipping_cost_cents` (the label cost outside the payout).
- `sale_item`: `relist_decision` (`pending`, `relisted`, `declined`; null while the sale stands)
  and `relist_decided_at`.
- `fee_line`: `description` and, for estimated lines, `fee_table_version`.

Migration `20261028095905_sales_history`: `sale.detection_source` gains `history`;
`sale_check_schedule.history_until` (where the connection's sales history ends: the row's
creation at linking, and the deploy for every existing connection); and every
`sale_check_schedule.checked_through` is reset so each connection's next check reads its whole
sales history. Down drops the column and turns `history` sales back into `poll` ones.

Migration `20261028152207_sold_item_photos`: resets `sale_check_schedule.checked_through` of each
Mercari connection whose account has a sale there of an item without photos, so its
next check is a full read that brings their photos. Down does nothing.

## Open items

- Depop's fees come as one line; its receipt detail splits them (payment processing, the Boost
  fee, the Depop fee). The shipping the buyer paid is not recorded (it goes to Depop's label).
  Poshmark's and Mercari's checks show no fees, so theirs stay estimated.
- eBay: a sale of a listing Listora doesn't have is not recorded yet (Seller Hub's sold rows and
  the API's order poll name no title or photos to make the sold item of).
- A sold listing that is in fact an item Listora has (listed elsewhere through Listora) becomes a
  sold item of its own; asking the seller, as the import does, could join them.
