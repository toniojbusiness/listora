# Pricing

The eBay API License forbids using eBay data to suggest prices without written consent. The
Depop rules allow Pricing Inspiration only inside that Depop listing. Without real sold data,
Listora shows a cost-based floor, an estimate labeled **"AI estimate - not based on sold
listings"**, and research links that open in the user's browser. The words "comps" and "sold"
appear only next to real sold data, and a test enforces this (T-14).

`@listora/pricing` implements these rules; `GET /v1/items/{itemId}/pricing` serves them.

- **Floor** ("Don't sell below"), per marketplace: the least price P with P = cost + fees(P) +
  shipping + minimum profit, so the breakdown adds up exactly. Shipping and minimum profit are
  query parameters (default 0). No cost means no floors.
- **Fee tables** live in `packages/pricing/src/fee-tables.ts`, one versioned table per
  marketplace schedule with its official source URL and the day it was checked. A fee change
  adds a table; every floor names its `feeTableVersion`. Estimates use the item price only and
  round each fee up. A test checks that every table's fees never fall as the price rises.
- **Actual fees.** With at least three recent single-item sales that have `actual` marketplace
  or payment `fee_line`s, a marketplace's table is scaled to what it really charged
  (`feeSource: actual_fees`). Each sale is compared with the fee table in effect on its
  `sold_at` (the marketplace's first table for older sales), so a fee change is never masked
  by sales at the old rate. A sale counts only when its fee data is complete: an `actual`
  line for every fee kind the table charges, and no zero-amount or refunded (negative) line.
  Ratios of actual to estimated fees outside 1/3 to 3 point at bad order data and are not
  used. eBay-sourced fee data (including the eBay Finances API) stays out of eBay floor
  computation until a legal review of the eBay API License (red flag RF3) says otherwise, so
  eBay floors use the published table; `ORDER_DATA_MAY_ADJUST_FEES.ebay` is the one switch
  to flip after that review.
- **Tiers** (quick sale, recommended, higher profit) are the AI estimate's low, mid, and high,
  each raised to the highest floor when below it, and labeled "(AI estimate)" or "(cost
  floor)". Sold data is shown as `soldComparables` but never sets a tier.
- **Snapshots.** `pricing_snapshot` holds source-labeled price data, validated against its
  source's payload schema on write and on read (a malformed row is skipped and logged). The
  estimate of the item's current analysis (the accepted one, else the latest succeeded) is
  recorded as one `ai_estimate` snapshot per analysis; it is read from the analysis output's
  `priceEstimate` (the contract's `AnalysisResult` shape). Sold data snapshots are shown while
  unexpired, the latest per source and marketplace context. Sources bound to one listing
  context must name it (`depop_inspiration` carries `marketplace: depop`, `ebay_mi` carries
  `ebay`), on write, on read, and in the label guard, so clients can show Depop Pricing
  Inspiration on the Depop listing only.
- **Label guard.** `buildPricingSuggestion` runs `labelGuardViolations` on every suggestion
  and throws instead of returning one that breaks the rules, so the API answers `500` rather
  than mislabeling a price.

## Data

- **Pricing:** `pricing_snapshot` (source-labeled; payloads per source in
  `@listora/pricing`, above).
