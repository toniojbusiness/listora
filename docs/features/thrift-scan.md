# Thrift scan: the Buy / Your call / Skip call, and the seller's own sales

The thrift scan helps a seller decide at the store, in seconds, whether an item is worth buying
to resell: one shot of the item (and an optional tag close-up), a short AI read, a price range
from the seller's own sales or the AI, and a call of **Buy**, **Your call**, or **Skip** with a
confidence word. Built so far: the rules, the AI read, and a backtest on real sold items (plan
milestone M0), and the seller's own sales as real sold data (`own_history`, M1) on the item's
price screen and in the sourcing kit (`GET /v1/sourcing/kit`). No app screen uses the call yet.

Code:

- `packages/sourcing` (`@listora/sourcing`): the pure rules, with no I/O. `quartiles`, `brandKey`
  (how two brands compare), `ownHistoryComparisons` (the seller's own sales like the item),
  `scanCall` with `DEFAULT_SCAN_CALL_SETTINGS`, `ownHistoryByMarketplace` (the price screen's),
  `sizeBucket`, and `buildSourcingKit`.
- `apps/api/src/sourcing`: the sales that count, the kit's route, and the price screen's own
  history, which `getItemPricing` shows ([pricing.md](pricing.md)). Nothing there calls a
  marketplace or AI: every number comes from the sales Listora already recorded
  ([sales.md](sales.md#sales-history)).
- `packages/analysis/src/scan.ts`: the AI read, `scanItem` (purpose `thrift_scan`, standard tier,
  no item quota), with its own small output schema `thrift_scan` and a cached system prompt.
- `packages/eval/src/scan/`: the backtest, `npm run eval -- scan`.

## The call

The call judges resale value only: no cost or margin, since a haul's price is known only at
checkout ([hauls.md](hauls.md)).

1. **The range.** The seller's own matching sales, from the low to the high quartile, when at
   least 3 match (`minComparisons`); otherwise the AI estimate's low to high, labeled "AI
   estimate - not based on sold listings". Own sales match at the tightest level that has 3:
   the same brand and category, then the same brand, then the same category (`MATCH_LEVELS`).
   Brands compare by `brandKey` ("Abercrombie & Fitch" and "Abercrombie", "Levi's" and "LEVI"
   are one brand; "American Eagle" and "American Apparel" are two).
2. **The payouts.** Each end of the range less the marketplace's estimated fees
   (`feeEstimator` in `@listora/pricing`, calibrated by the seller's actual fees when there are
   enough).
3. **The confidence.** High: at least 5 sales of the same brand and category and an
   identification at least 0.8 sure. Medium: a match on the brand and an identification at
   least 0.6 sure. Low: a match on the category only, an unsure identification, or the AI
   estimate alone (which therefore never makes a Buy).
4. **The call.** **Skip** when even the high end pays out less than the worth-listing amount.
   **Buy** when the low end pays out at least that, the confidence is medium or high, and the AI
   raised no flag (visible damage, a lot or bundle, a counterfeit-prone brand). **Your call**
   otherwise.

**Wording.** The call always shows its confidence and what it rests on ("Your 5 sales like it",
or the AI estimate's label). Ranges are quartiles, never one price, and "sold" appears only next
to real sold data (a unit test checks the call's wording with `claimsSoldData`).

## The backtest (`npm run eval -- scan`)

```sh
npm run eval -- scan --dataset <dir>                         # fake AI: plumbing only, free
npm run eval -- scan --dataset <dir> --provider none         # own sales only, no AI
npm run eval -- scan --dataset <dir> --provider anthropic    # the real read; ANTHROPIC_API_KEY
npm run eval -- scan --dataset <dir> --provider anthropic --images 2 --worth-listing 10
```

For each sold item it makes the scan's read from the item's photos, compares the item with the
set's other sales (leave-one-out), makes the call, and scores all three against what the item
really sold for. Two call variants run: `ai`, the scan's own read (the call at the store), and
`labels`, the set's labeled brand and category with full confidence and no AI estimate (the best
an own-history-only call could do). A sweep repeats the call at worth-listing amounts from $5 to
$20. The report holds counts and money only, no title or brand, so a private set's report can be
shared; `--items` adds one line per item (its id, sale, payout, and calls) and `--json` the full
report, including the AI's reads.

Every item in a set sold, so the backtest measures how well the call judges value, never
whether an item would sell at all, and a Skip "holds" only when the item paid out less than the
amount.

### The set

A directory with `manifest.json` and the photos (`packages/eval/src/scan/dataset.ts` checks it):

```json
{
  "version": 1,
  "description": "what the set is",
  "marketplace": "depop",
  "currency": "USD",
  "items": [
    {
      "id": "d001",
      "title": "the listing's title",
      "brand": "Levi's",
      "category": "clothing/bottoms/shorts",
      "salePriceCents": 1200,
      "askingPriceCents": 1500,
      "feesCents": 95,
      "soldAt": "2026-10-01T12:00:00Z",
      "photos": [{ "file": "photos/d001-0.jpg", "width": 1024, "height": 1024 }]
    }
  ]
}
```

`brand` and `category` (a path of the analysis vocabulary) are the labels the read is scored on
and the comparisons match by; either may be null. `feesCents` is the item's actual fees (null:
estimated from the fee table). The first photo is the scan's shot, the second its closer look.

A real set is the household's own sales and stays **private, outside the repository**, under
`~/.config/listora/test-data/` (mode 700). The household's set was built read-only, with the
seller's OK:

1. The sold items of the seller's account (`sale_item` with its `sale`, `fee_line`,
   `inventory_item`, `marketplace_listing`, and `photo` rows; no buyer, address, or order id)
   were read in a `READ ONLY` transaction by a one-off script run in the personal environment's
   migrate task, as `scripts/admin-remote.sh` runs the admin CLI.
2. The first two photos of each were copied from the photos bucket: their `ai` derivative
   (1024 px), what a scan sends.
3. Brand and category were labeled from each listing's title, and an order's fees shared among
   its items by sale price.

Nothing on the marketplace was read or changed. The set has the listings' photos, not shots at a
store, so a real scan's read will be somewhat worse than this one.

### Results, 2026-10-31

The household's 64 Depop sales (`claude-haiku-5-5`, all 64 read, none failed):

|                                            | 1 photo         | 2 photos        |
| ------------------------------------------ | --------------- | --------------- |
| Cost per scan                              | $0.00034        | $0.00055        |
| Latency p50 / p95                          | 1.4 s / 3.4 s   | 3.1 s / 4.4 s   |
| Brand agreed (of 58 labeled)               | 50% (named 55%) | 66% (named 71%) |
| Category: same path / same top category    | 77% / 91%       | 78% / 94%       |
| Identification 0.6 sure or more            | 47%             | 66%             |
| AI estimate: sale price inside low to high | 42%             | 44%             |
| AI estimate: median error (bias)           | 65% (+60%)      | 64% (+63%)      |

Own sales (leave-one-out), with the AI's identity / the labels:

- a range (3 or more matches) for 67% / 75% of items: on the brand for 14 / 17 and on the
  category alone for 29 / 31; never on the brand and category together, which no item had 3
  other sales of;
- the sale price inside the low to high quartile for 47% / 42% (half is what well-matched
  quartiles give), with a median error of 44% / 51% and almost no bias (+1% / +12%).

The call, one photo:

| Worth listing | Items worth it | Buy (held)   | Your call | Skip (held) |
| ------------- | -------------- | ------------ | --------- | ----------- |
| $5            | 88%            | 11 (100%)    | 53        | 0           |
| **$8**        | **75%**        | **11 (91%)** | **53**    | **0**       |
| $10           | 63%            | 6 (83%)      | 55        | 3 (0%)      |
| $12           | 52%            | 0            | 53        | 11 (45%)    |
| $15           | 25%            | 0            | 41        | 23 (78%)    |

What it set and found:

- **Worth listing defaults to $8** (`DEFAULT_SCAN_CALL_SETTINGS`). The plan's first guess, about
  the median payout, sits where half the items fall each side, so the call was nearly always
  Your call and its Skips held under half the time. At $8, 75% of these sales are worth it and
  the Buys held 10 times in 11.
- **The AI read is fast and cheap enough** (p50 1.4 s against the plan's 2.5 s; $0.0003 a
  scan). A tag close-up makes the brand right 66% of the time instead of 50% for 1.7 s more.
- **The AI estimate runs high** for this household: its middle was 1.6 times the real sale
  price. Scaled by the household's own ratio (leave-one-out), its low-to-high range held the sale
  price 55% to 60% of the time and its median error fell to 35% to 40%.
- **Own sales are the better price source** (unbiased), but only once the identity is right and
  the sales are enough: most items matched on the brand or the category, never both.
- **Depop's actual fees were 1.69 times the fee table's estimate** (3.3% + $0.45); the
  backtest's payouts use the calibrated table.
- The call reached high confidence for no item: 64 sales spread over many brands rarely give 5
  of one brand and category.

## The seller's own sales (M1)

### The sales that count

Only real sales count, and only ones the seller is shown:

- **Standing.** The sale is detected, confirmed, or shipped; canceled and returned sales never
  count.
- **Recent.** It sold in the last 365 days (`OWN_HISTORY_WINDOW_DAYS`); older prices say little
  about today's.
- **Read by a feature that passed live.** The sale is on a marketplace whose `sales_history` is
  on for the account (`ownSalesMarketplaces`, [verified-features.md](verified-features.md)): for
  sellers today Depop and Mercari, and every marketplace in the owner's Test mode. A sale an
  unproven read recorded is never shown as the seller's history. This also leaves out a
  marketplace's sales the seller marked sold by hand until its sales history passes live.
- **Of an item with a brand.** A bundle's items each count, at what the buyer paid for each.

**eBay is display only.** The seller's own eBay sales are shown as their own sales, but nothing
models a price or a call from them, for the eBay licence reason that keeps eBay fee data out of
floors (red flag RF3, `OWN_SALES_MAY_MODEL_PRICES` in `@listora/pricing`). Marketplaces are
always listed in the fixed `KnownMarketplace` order, never ranked
([profit.md](profit.md#marketplaces-side-by-side-never-ranked)), and no days to sell are shown.

### On the item's price screen

`getItemPricing` computes the item's own history on every read
(`ownHistoryByMarketplace`): per marketplace, the sales `ownHistoryComparisons` matches at the
tightest level with at least two (`MIN_OWN_HISTORY_SALES`: one sale is a price, not a range),
the item's own sale left out. Only a match on the item's brand shows, since the label names it,
so an item without a brand has none. Each is one `own_history` sold comparable:

- the same brand and category: "Your sales of similar Lululemon items on Depop (last 365 days)";
- the same brand only (the item has no category, or too few of it sold there): "Your Lululemon
  sales on Depop (last 365 days)".

The comparable names no `marketplace`: that field means data bound to one listing's context
(Depop Pricing Inspiration), and the seller's own sales are not, so the price screen shows them
under "Where the prices come from" ("3 sold, $25.00 to $29.00, median $28.00"). With any, the
"No sold data available" message is gone. Like all sold data, it never sets a tier. It is never
stored as a `pricing_snapshot`, so it is current the moment a sale is recorded or canceled; a
stored `own_history` row is ignored.

**No new app build is needed**: the app already shows sold comparables without a marketplace,
with their label.

### The sourcing kit

`getSourcingKit` (`GET /v1/sourcing/kit`) is the same sales, grouped for looking a brand up at
the store with no signal (the offline read comes in M5; the app does not read the kit yet).

- **Groups** (`buildSourcingKit`): every brand (by `brandKey`), then each of its categories, then
  each size in a category (`sizeBucket`: without case or spaces, letter sizes spelled short, so
  "Medium" is `m`). Each group with a sale is listed, so a group missing from the kit has none.
  The brand is spelled as most of its sales spell it.
- **Per group:** the sales per marketplace (count, the quartiles, the median payout after that
  marketplace's fees from its current fee table, an estimate, with the table's version), whether
  they are display only (eBay), and how many of the account's items of the group sit unsold
  (ready or listed).
- **Size:** at most 2,000 groups (`MAX_KIT_BUCKETS`); past that, size groups go first, then
  category groups, the ones with the fewest sales first. The kit has a format `version` (1); a
  client that does not know it ignores the kit.

### Tests

- `packages/sourcing`: `ownHistoryByMarketplace`, `sizeBucket`, and the kit's groups, order, eBay
  flag, brand spelling, and limit, on invented sales.
- `apps/api/src/sourcing/sourcing.int.test.ts`: the price screen's own history per marketplace
  (canceled, old, other-category, and other accounts' sales left out; the item's own sale left
  out; two sales needed; no brand, no history), the gate for a seller and in Test mode, and the
  kit, empty without sales, gated the same way, with eBay display only.

## Local development

The rules and the read need nothing running: `@listora/sourcing` is pure, and `scanItem` runs on
the fake AI provider like every AI call ([ai.md](ai.md)). The backtest's unit tests use a small
invented set (`packages/eval/src/scan/test-support.ts`); `--provider fake` answers from a set's
own labels and asking prices, so it measures the plumbing, not a model.

## Open items

- **Sold items need their brand and category.** Listora stores them for only 2 of these 64 sold
  items (those it listed); the others came from the sales history with only a title. The price
  screen's own history and the kit (M1) leave out a sale without a brand, so until they are
  filled, for example from the title or the photos, they show little of the household's history.
- **Days to sell.** Not shown yet: an imported listing's `listed_at` is when Listora read it, not
  when the seller listed it, so a day count from it would understate.
- **The call's thresholds** belong in the kit for the offline call (M5).
- **Scale the AI estimate** by the seller's own sale-to-estimate ratio once Listora has enough
  of both for an account.
- **Re-run the backtest** as sales accumulate, and on shots taken at a store (M2), before showing
  the call to sellers.

## Data

None yet: the scan's tables (`sourcing_run`, `item_scan`) come with the app's scan (M2). The own
sales read `sale`, `sale_item`, and `inventory_item` ([sales.md](sales.md), [items.md](items.md))
and write nothing.
