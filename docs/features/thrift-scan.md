# Thrift scan: the Buy / Your call / Skip call, and the seller's own sales

The thrift scan helps a seller decide at the store, in seconds, whether an item is worth buying
to resell: one shot of the item (and an optional tag close-up), a short AI read, a price range
from the seller's own sales or the AI, and a call of **Buy**, **Your call**, or **Skip** with a
confidence word. Built so far: the rules, the AI read, and a backtest on real sold items (plan
milestone M0); the seller's own sales as real sold data (`own_history`, M1) on the item's
price screen and in the sourcing kit (`GET /v1/sourcing/kit`); and the scan itself online
(M2): Add Item's Scan mode, `POST /v1/scans`, Keep into the run, and the run's tray; Depop's
comparisons from its public search, read on the seller's iPhone logged out (M3, "Marketplace
comparisons" below), then eBay's, the card's first sold prices from a marketplace ("eBay"
below); the run itself (M4): its place, the checkout at the register into a haul, and the run's
summary with the haul's estimated resale and profit; and upgrading a run's kept drafts with real
photos (M6): "Needs photos", Shoot this run, the full analysis with the scan's read as a hint,
and the run's rapid review. Scan mode is hidden from sellers until it passes live
(`thrift_scan`, [verified-features.md](verified-features.md)), and each marketplace's
comparisons until they do (`market_comps`): only the owner's Test mode has them. The server
never reads or writes a marketplace; nothing in the scan ever writes one, and the comparisons
read only what any logged-out visitor's browser reads.

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
  no item quota, thinking off), with its own small output schema `thrift_scan`, held to its enums
  (`strictEnums`), and a cached system prompt.
- `packages/eval/src/scan/`: the backtest, `npm run eval -- scan`.
- `apps/api/src/scans` and `apps/api/src/sourcing-runs`: the scan's read and Keep, and the run
  with its checkout and summary (below); `scanOwnHistory` and `runEstimate` in
  `@listora/sourcing` and `scanResearchLinks` and `scanLabelViolations` in `@listora/pricing`.
- iPhone: `AddItemFeature/Scan` (the camera, the card, the tray, the run, the note, the
  measurements, the start and checkout sheets, the run's summary, and the kept run's section,
  guided shoot, and review); a kept scan is an ordinary draft whose server item `keepScan`
  creates.
- `packages/analysis/src/load-input.ts`: the full analysis of a kept item carries its scan's
  read as a hint (`scanRead`, `scanReadHint`).
- Comparisons: `marketStats` and `marketDemand` in `@listora/sourcing` (`market.ts`, also the
  phone bundle's, as `@listora/sourcing/market`); the reader in `packages/automation/src/comps/`
  (`query.ts` on the server, `depop.ts` and `run.ts` on the phone, through `listoraPhone.compare`)
  and Depop's search in `depop/pages/search.ts`; the server's half in
  `apps/api/src/scans/comparisons.ts`; the iPhone's lane in
  `PhoneExecutionFeature/Comparisons` (`WebMarketComparisons`).

## The call

The call judges resale value only: no cost or margin, since a haul's price is known only at
checkout ([hauls.md](hauls.md)).

1. **The range.** The seller's own matching sales, from the low to the high quartile, when at
   least 3 match (`minComparisons`); otherwise what at least 5 close matches sold for on eBay
   (`market_sold`, "eBay" below); otherwise what the web says it resells for; otherwise the AI
   estimate's low to high, labeled "AI estimate - not based on sold listings". Own sales match at the tightest level that has 3:
   the same brand and category, then the same brand, then the same category (`MATCH_LEVELS`).
   Brands compare by `brandKey` ("Abercrombie & Fitch" and "Abercrombie", "Levi's" and "LEVI"
   are one brand; "American Eagle" and "American Apparel" are two).
2. **The payouts.** Each end of the range less the marketplace's estimated fees
   (`feeEstimator` in `@listora/pricing`, calibrated by the seller's actual fees when there are
   enough).
3. **The confidence.** High: at least 5 sales of the same brand and category and an
   identification at least 0.8 sure. Medium: a match on the brand and an identification at
   least 0.6 sure. Low: a match on the category only, an unsure identification, or the AI
   estimate alone (which therefore never makes a Buy). On eBay's sold listings: high with at
   least 10 sold of the exact model (`highMarketSold`) and an identification at least 0.8 sure,
   medium with one at least 0.6 sure, low otherwise. Slowing own sales, or an eBay search that
   sells slowly, keep a call from high.
4. **The call.** **Skip** when even the high end pays out less than the worth-listing amount.
   **Buy** when the low end pays out at least that, the confidence is medium or high, and the AI
   raised no flag (visible damage, a lot or bundle, a counterfeit-prone brand). **Your call**
   otherwise.

**Wording.** The call always shows its confidence and what it rests on ("Your 5 sales like it",
"Sold listings on eBay: 9 like it in the last 14 days", or the AI estimate's label). Ranges are quartiles, never one price, and "sold" appears only next
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
  price (1.3 times since the read's price sentence, [Speed](#speed)). Scaled by the household's own ratio (leave-one-out), its low-to-high range held the sale
  price 55% to 60% of the time and its median error fell to 35% to 40%.
- **Own sales are the better price source** (unbiased), but only once the identity is right and
  the sales are enough: most items matched on the brand or the category, never both.
- **Depop's actual fees were 1.69 times the fee table's estimate** (3.3% + $0.45); the
  backtest's payouts use the calibrated table.
- The call reached high confidence for no item: 64 sales spread over many brands rarely give 5
  of one brand and category.

## The scan at the store (M2)

### On the iPhone

Add Item has a third mode, **Scan**, next to One item and Batch, shown only where `thrift_scan`
is on. **Start scanning** asks where the seller is (checkout below), then opens the scan camera
and starts a run; the server's is made, with the place, as the camera opens
(`ScanRunModel.prepare`), so the first shot's read neither waits for it nor opens the
connection to Listora.

- **One shot** of the item in hand. The shutter is at the bottom center; the read starts at
  once and the camera is ready for the next item while it runs.
- **The card** rises over the bottom of the live viewfinder (Hang Tag: a tag lying on its side,
  the call stamped on it): the call (**Buy**, **Your call**, **Skip**) with its confidence word,
  what the item is, the price range the call rests on in the tag's print with what it rests on
  ("Your 3 sales like it", or "AI estimate - not based on sold listings"), the payout after the
  marketplace's fees, the household's own sales per marketplace, the AI estimate under its
  label, any flag, **Shoot the tag** and **Search Depop** (the marketplace's own search, opened
  in the browser for the seller to look; Listora never loads it) on a small line, and the
  seller's two answers at the bottom, big and side by side: **Put back** and **Keep**. No cost,
  margin, or profit. The pass action is **Put back**, what the seller does with the item, so it
  is never confused with the **Skip** call stamped on the card.
- **Haptics**, so the seller can keep their eyes on the bin: two short taps for Buy, one long
  buzz for Skip, none for Your call (`Haptics.doubleTap`, `Haptics.longBuzz`).
- **Keep** and **Put back** each close the card at once, back to the live camera for the next
  shot, and a brief line where the card was says what happened: "Keeping item 3" while the draft
  is saved, then "Kept · 3 in this run", or "Put back · 3 kept this run" (1.6 s; a Keep that
  failed says so for 5 s, above the next card if one is up, and its tray tile is marked). The
  shutter takes a shot the whole time; nothing waits for the draft. **Put back** is there while
  the item is still reading or could not be read, too.
- **Keep** saves the item as a draft on this iPhone, with the scan's photo (the upload size,
  prepared while the card was read) and the tag close-up if there is one. The upload queue
  creates its server item with `keepScan` and attaches the photos in the background.
- **Shooting the next item without choosing puts the last one back.** The **tray** along the
  bottom holds every card of the run; tapping one shows it again, so an item put back can still
  be kept until the run ends, and a kept one shows "Kept as a draft" with **Close**.
- **Shoot the tag** (or **Shoot the tag?**, when the AI could not read the brand or was unsure): the next shot is a
  close-up of the tag; the item is read again with both images (`replacesScanId`).
- **Hold the mic** to add a note ("medium, small stain"), turned into text on the iPhone. Said
  before a shot, it rides along with that shot's read; said after, the item is read again once
  with it (about $0.0004).
- **Done** closes the camera and keeps the run going (Add Item shows "This run: 12 scanned, 3
  kept" and **Keep scanning**). **Finish** offers **Check out** (below) or **End without checking
  out**; either way the items not kept are skipped. Add Item's **End run** is the second.
- **Failures**: a read that fails says why ("Couldn't read this one. Try again.", "Can't reach
  Listora. Check your connection.") with **Retry**; nothing is shown as read until it was.

A run lives only while the app does: a relaunch starts a new one (the kept drafts stay). The
shots' photos wait in the drafts folder's `ScanRuns/` until they are kept or the run ends, and
the folder is emptied at launch. Reading with no signal is M5.

### The server

- `POST /v1/sourcing-runs` (`createSourcingRun`) starts a run; `POST
/v1/sourcing-runs/{runId}/end` ends it, marking its undecided scans `skipped`.
- `POST /v1/scans` (`createScan`): the item shot (and a tag close-up) inline as base64 JPEGs of
  at most 1,600 pixels and 350 KB (the app sends 1,024 pixels, about 150 KB), the tag text the
  phone read (Vision, within 0.4 s, so a slow read never holds the scan up: at the deadline the
  scan goes without it, even though Vision only stops at its next pass), and the note. The
  server checks each image's JPEG header and size, reads it with `scanItem` (Haiku with thinking
  off, the AI guards and metering), drops the images, and answers synchronously with the identity, the AI
  estimate (labeled), the flags, the household's own sales like the item per marketplace, the
  call, the search words, and the research links. The call: `scanOwnHistory` over the sales that
  count (eBay's shown but never feeding it), payouts after the fees of the marketplace with most
  of the matching sales (Depop on a tie or with none, since the AI estimate is a Depop price),
  calibrated by the account's actual fees there when there are enough, and
  `DEFAULT_SCAN_CALL_SETTINGS` (worth listing $8, from the backtest). The answer passes
  `scanLabelViolations` (the label guard) before it is sent.
- `POST /v1/scans/{scanId}/keep` (`keepScan`) creates the kept item, a `draft` with its SKU,
  its title, brand, category, department, size, and condition from the read (provenance `ai`);
  keeping it again answers that item (`200`), so a replay never makes two. A scan a later one
  replaced, or that its ended run skipped, can't be kept (`409`).
- **Limits.** 300 scans an account a day (`MAX_SCANS_PER_DAY`, `429 rate_limited`) on top of the
  daily AI budget; a scan uses no plan item quota. All four routes answer `404` for an account
  the thrift scan is not on for.

### Checkout (M4)

A run is the haul-to-be: the seller pays once at the register, for everything they kept, and
that is when the cost is known. The scan itself never shows a cost, margin, or profit.

- **Starting a run** asks only where the seller is: the places they bought from lately (the cost
  screen's, `RecentPurchaseSources`, shared on this iPhone) or a typed one, or nothing.
  `createSourcingRun` takes it as the run's `place`.
- **Checkout** (Finish > **Check out** on the camera, or **Check out** on Add Item): "Paid for the
  haul" ($), "Items in the haul" (the kept items by default; more when some were bought without a
  scan, never fewer), and "Miles driven (optional)" for the seller's mileage log (whole miles, up
  to 2,000; only recorded, never priced). A Keep still being saved on the iPhone holds the button
  until it is.
- **`POST /v1/sourcing-runs/{runId}/checkout`** (`checkoutSourcingRun`) does it in one
  transaction: the app sends the scans it kept (`keptScanIds`), and one whose item the upload
  queue had not sent yet is kept there and then (`keepAsItem`, `keepScan`'s), so a slow upload
  never leaves an item out; the queue's later `keepScan` answers that item (`200`). Every kept
  item of the run joins one new haul (`createHaulWithItems`, [hauls.md](hauls.md)) of the total
  and count, in the order kept, each costing its share, with the haul's date (the iPhone's day)
  and place (the run's); the run ends (its open scans skipped) and records the haul, when, and
  the miles. A run already checked out or ended is `409`; a listed scan of another run, replaced,
  or skipped is a `422` field error naming it; nothing changes on either. The app keeps one
  Idempotency-Key per run's checkout, so a retry after a lost answer replays the one that went
  through instead of making a second haul. Nothing shows as checked out until Listora answered;
  a failure says why ("Nothing was recorded; check out again to retry").
- **The run's summary** (`getSourcingRunSummary`, and checkout's answer), on a tag stamped
  "Checked out": what was scanned and kept, the miles, "Paid $47.20 for 23 items · $2.05 each",
  the kept items' **estimated resale** and what it pays out after fees, and the **estimated
  profit**: the payout less what the whole haul cost, so it exists only once the haul's total is
  known, and it follows the haul when its total or count is fixed (`replaceHaul`). The sums are
  the kept scans' calls as the card showed them (`runEstimate` in `@listora/sourcing`): their
  ranges and payouts, each after its marketplace's fees; a kept item with nothing to go on is
  left out, and the summary says how many of the kept items the estimate covers. It always
  says what the ranges rest on ("1 from your own sales, 2 from the AI estimate"; eBay's sold
  listings are "from a marketplace's sold listings") and is labeled
  "Estimated", or "Estimated - includes the AI estimate, not based on sold listings" when any
  range is the AI's. It stays on Add Item until the next run starts. Real profit comes in Sales,
  Profit, and Reports as the items sell, from each item's share as its cost.

### Web info

Many resellers decide at the bins by asking a chatbot that searches the web whether a brand
and item are worth it. The scan does the same, in the
background, so the card never waits on it.

- **When.** Once a card has been on screen for 2 seconds (`ScanRunModel.defaultResearchDwell`),
  or at once when it is picked again in the tray, the app calls `POST
/v1/scans/{scanId}/research` (`researchScan`); the card says "Checking the web for its retail
  price" and takes in the answer when it comes. At the bins most items are skipped within a
  second or two of their card by shooting the next one, and a lookup costs about $0.02, so a
  card the seller moved on from (Keep, Put back, the next shot, Tag, or a note that reads it again) is never
  looked up unless they come back to it. Each scan is looked up once. A read without a brand
  asks nothing (`no_brand`). A scan already researched answers as it is.
- **What.** One standard-tier call (Haiku) with the Claude API's web search, at most two
  searches (`researchScanItem` in `@listora/analysis`, purpose `thrift_scan_research`), for the
  item's **original retail price** on the brand's or a retailer's site or another reputable
  source, and **what such items resell for** on the resale marketplaces themselves, with how
  well the brand resells.
- **Never failed for its length.** The answer's schema allows four times the card's limits
  (model names of 60 characters, 6 models, 4 pages per number, a 240-character summary), and the
  verification cuts it to them (a name or summary at a word, with an ellipsis). An answer that
  broke a length used to be sent again with its searches, and then fail: in a live sample, 2 of
  10 lookups cost $0.045 each and showed nothing.
- **Never without its page.** Every number names the pages it came from, and only pages the
  searches really returned count (`verifiedResearch`): a price whose page is not among them is
  dropped, a resale range keeps only pages of the resale marketplaces (`RESALE_SITES`; resale
  estimator sites are no source), and a summary that calls anything "sold" is dropped.
  Everything shows under "Web info - not sold listings" (`WEB_INFO_LABEL`, held by the label
  guard), never as sold prices.
- **One brand, many models.** A Levi's 501 is not a 505 or a 550, and vintage is not current,
  in every brand and category. The read names the exact model or line only when it is printed
  or unmistakable (`identity.model`), a printed style number, and the era. A cached answer is
  reused only for the same exact model: the brand, the item type, the model or style number,
  and the era (`itemResearchKey`), for 30 days. An item whose model the read could not pin is
  looked up afresh every time, and its retail price is a range across the likely models, which
  the card names ("Retail $60-$98 across 3 models", "Models: 501, 517, 527"). How well a brand
  resells is kept by the brand alone (`brandResearchKey`), for 7 days. Both are per account
  (`scan_research`).
- **In the call.** Web info ranks after the household's own sales and before the AI estimate:
  with fewer than 3 own sales like it, the range is the web's resale range, at medium
  confidence only with a sure read and two resale sites, otherwise low, and never high. It
  shows as a signal ("Resells well", "Resells poorly") with its sites.

### Retail price, trend, and style

The call's other signals (`call.signals`), each with what it rests on:

- **The retail price.** Printed on a tag in the shot when one is visible (a bonus: the read
  looks for it, `retailPriceCents`), else the web's. With the AI estimate alone, the range is
  held to the retail price, since the AI's guess runs high; otherwise the card says what share
  of retail the range is ("the range is 31%-51% of $98").
- **New with tags.** With the tags still on (the read's condition `new_with_tags`), the
  household's own sales like it count 15% more (`newWithTagsBump`, a starting estimate: the
  backtest's sales had no tag reads); the AI estimate already sees the tags.
- **Trend.** From the household's own sales like it (`salesTrend` in `@listora/sourcing`): those
  of the last 90 days against the 9 months before. "Trending up" only with at least 3 recent and
  2 earlier sales and recent ones coming at least 1.5 times as fast; "Slowing" with at least 3
  earlier and recent ones at most two-thirds as fast. A slowing trend caps a call at medium
  confidence; a rise never raises one. With too few sales it says nothing. The marketplaces'
  side of it is the comparisons' demand (below).
- **Style.** The AI's read of a style or era buyers search by ("Y2K", "gorpcore"), labeled
  "The AI's read of the style, not sales data". It never moves the call.

### Speed

The plan's targets (p50 over 30 scans on the captain's iPhone, cellular, a real store):
identification within 2.5 s, active time 3 s a skipped item and 4 s a kept one. They are
measured three ways:

- **The server** logs every scan's `readMs` (receipt to answer, the AI call included) with its
  call, and stores it in `item_scan.read_ms`; the AI call's own latency is in
  `ai_usage_event.latency_ms`.
- **The iPhone** times each card from the shutter press (`ScanEntry.cardAfter`, logged as "scan
  card after N ms"), so the camera's own capture time counts, and the run's active time
  (`InteractionMeter`, session `scan-<run>`), logged when the run ends.
- **The owner** sees them on the scan camera in Test mode, tagged "Testing": "Card 2.1 s · 95%
  3.4 s · active 2.8 s an item · next shot 0.3 s", the last from Keep or Put back to the card
  off the screen (`ScanRunModel.readyTimes`, logged as "scan camera ready N ms after the
  decision"). Sellers never see timings.

**Measured 2026-10-31, before and after the speed work.** The live path: `POST /v1/scans` on the
local API with the real read (`claude-haiku-5-5`), 30 scans in a row of 1,024-pixel JPEGs at the
app's quality (6 invented tag and label shots, 24 of the household's listing photos), timed at
the client; and the backtest's 64 sold items (`npm run eval -- scan`).

|                                   | Before                     | After                      |
| --------------------------------- | -------------------------- | -------------------------- |
| Live read, p50 / p95              | 2.66 s / 3.94 s            | 1.41 s / 2.18 s            |
| Live reads failed                 | 1 of 30                    | 0 of 30                    |
| Output tokens, p50                | 448                        | about 210                  |
| Cost per scan                     | $0.00039                   | $0.00028                   |
| Backtest read, p50 / p95          | 1.79 s / 4.02 s            | 1.50 s / 2.09 s            |
| Backtest reads failed             | 3 of 64                    | 0 of 64                    |
| Brand agreed (of the labeled)     | 26                         | 29 to 31                   |
| AI estimate's bias, same 58 items | +50% (27 inside its range) | +28% (30 inside its range) |

What made the difference, measured one at a time on the backtest's photos:

- **Thinking off** (`thinking: 'off'`). With thinking on, a quarter of the listing photos and
  every tag shot thought first, 300 to 570 tokens, adding 1.5 s to 3.5 s: that was the slow
  tail and most of the tag shots' time. Off, every read answers in about 210 tokens, and the
  identification held or improved. Off alone, the AI estimate ran higher (+65% against the
  sales), so the prompt now says what a used one really goes for is usually well under what
  sellers ask and far under retail, which brought it to +28%. (That sentence was checked on the
  same 64 sales it was tuned on.)
- **Enums held** (`strictEnums`). One read in twenty had named a category outside the list,
  so it was sent again (1.5 s more) and sometimes failed twice (a "Couldn't read this one"). A
  shot of only a care label could also answer an empty item name, which the grammar cannot
  forbid: it now reads as "Unidentified item" instead of failing. The prompt no longer repeats
  the category list, which the schema carries.
- **Measured and not taken:** a 768-pixel image (no faster at the server, since the time is in
  the answer, and fewer brands named), a JPEG quality of 50 (no faster, and the tag's print is
  what matters), pre-warming the prompt cache (a cold cache cost $0.0004 more but no time), and
  keeping the connection to the AI open between scans (about 90 ms a scan once 12 s apart; Node's
  fetch closes idle connections after 4 s, and changing that needs another HTTP client).
- **On the iPhone:** the server run is made as the camera opens instead of before the first
  read, which saves the first shot a round trip and finds the connection to Listora open; the
  tag text's 0.4 s deadline now holds (before, the scan waited for Vision's current pass,
  which can run past it); and the card's time counts from the shutter press.

The web research is about $0.023 a lookup (two searches at $0.01 and the pages' tokens) and
6 s to 12 s, in the background. One search instead of two found the retail price for 4 of 10
items instead of 9, so it stays at two. The cost is cut instead by never paying for a lookup
that fails on a length (above) and by looking up only cards the seller is still looking at
(two seconds on screen), which at the bins skips most items' lookups.

The streaming the plan names ("identity fields come first") is not needed for the target: the
whole answer is now 1.4 s at the server. The live test on the captain's iPhone measures the rest:
the camera's capture, the upload on cellular, and the card. The iPhone's part needs a new app
build; the server's applies with a deploy.

### Data

- `sourcing_run`: account, who started it, the place, started and ended, its scan and kept
  counts, which stay after skipped scans are deleted, and from checkout the haul it became
  (`haul_id`, one run per haul), `checked_out_at`, and the miles (migration
  `20261031113754_sourcing_run_checkout`).
- `item_scan`: the run, the item shot's SHA-256 and the image count (never the images), the
  AI's read (`read`), the web research once asked for (`research`, `research_ms`), the call, its confidence and basis, the call as the app showed it with the
  own-sales lines (`call_detail`: counts and quartiles of the household's own sales only), the
  seller's decision (`undecided`, `kept`, `skipped`, `replaced`), the kept item, the model, the
  AI attempts and their cost, and `read_ms`.
- `scan_research`: the web's facts per account, an item's (`kind` `item`, by its exact model)
  or a brand's (`brand`), with the model and what the research cost.
- **Retention**: cached research is deleted after 30 days; scans never kept are deleted 90 days after they were made (`unkeptScans`,
  [privacy.md](privacy.md#retention)); a kept scan stays with its item.

### Tests

- `apps/api/src/scans/scans.int.test.ts`: the gate for a seller and in Test mode; a read from own
  sales (eBay display only) and from the AI estimate alone (low confidence, Skip below the
  amount, nothing to go on); images refused (not base64, not a JPEG, too wide, out of order);
  another account's or an ended run; a failed read (schema retry metered, the kill switch) that
  stores nothing; an idempotent replay without a second read; Keep once, however often; a
  replaced or skipped scan not kept; the daily limit before any read. `images.test.ts`: the JPEG
  header reader.
- The web research: `scans.int.test.ts` (looked up after the read and the call made again;
  answered as it is when asked again; reused only for the exact model, never another model or
  era of the brand; an unknown model looked up afresh with a retail range across models; a
  price whose page was never returned dropped; nothing looked up without a brand; a tag's
  retail price ahead of the web), `scan-research.test.ts` (pages verified, resale only from
  the marketplaces, metered searches, an overlong answer cut instead of failed), and the
  provider's web search.
- The read's speed settings: `scan.test.ts` (thinking off and the enums held on the request; an
  empty item name read as "Unidentified item"), and in `@listora/ai`, `anthropic-provider.test.ts`
  (thinking off only when asked; `outputJsonSchema` the SDK helper's schema without
  `strictEnums` and with every enum kept with it) and `client.test.ts`.
- `@listora/sourcing` (`scanOwnHistory`, the signals, `salesTrend`, the research keys),
  `@listora/pricing` (`scanResearchLinks`, `scanLabelViolations`), the retention rules, and the
  app feature gate.
- Checkout: `sourcing-runs.int.test.ts` (the gate; the kept items into one haul with their
  shares, the place, the date, and the miles, a Keep the app had not sent kept there and its later
  `keepScan` answering it, the open scans skipped; the summary before and after, its sums and
  labels, and the profit following a fixed haul; the count grown to the kept items; nothing kept
  with a range; a replayed checkout and a second one, an ended run, another account's run, a scan
  of another run or replaced, and a negative total, changing nothing); `run.test.ts` in
  `@listora/sourcing` (the sums, the left-out scans, the wording); iPhone `ScanCheckoutTests.swift`
  (the run's place, the checkout's kept scans, the iPhone's date, the miles, the run ended after,
  a failure retried as the same checkout, the summary's words); `ThriftScanUITests` starts a run
  at a place and checks it out on the local stack.
- iPhone: `ScanDecisionTests.swift` (Keep and Put back closing the card at once, the line's
  words while the draft is saved and after, a failed Keep tried again from the tray, Put back
  while reading, Close on a kept card, the camera-ready measurement); `ScanTests.swift` (the card's words and haptics, the measurements, the run: one server
  run, the small JPEG with tag text, implicit skip and Keep from the tray, notes before and after
  a read, the tag close-up, Retry, End run; the upload queue's `keepScan`, a deleted draft's item
  found by keeping again, a skipped scan's draft failing visibly; the research asked for after
  the read and the card taking it in, nothing asked without a brand; only a card still on screen
  after the dwell, or picked again in the tray, looked up, once; the server run made as the
  camera opens; the card timed from the shutter press; the tag text's deadline holding against
  a reader that does not stop at once); `ThriftScanUITests` end
  to end on the local stack with the fake camera and the fake AI's scan and web research
  (`FakeAI/default.json`).

**The phone needs a new app build** for Scan mode, and again for the run's place, checkout, and
summary (M4).

## Marketplace comparisons (M3, Depop)

The card gains a row per marketplace whose comparisons are on (`market_comps`, per marketplace,
[verified-features.md](verified-features.md)): what listings like the item ask in the
marketplace's public search, read on the seller's iPhone within seconds of the read. The captain
approved reading the public, logged-out search results from the seller's iPhone within budgets,
stopping at any check (2026-10-31); eBay, Poshmark, and Mercari follow as their own readers.

### What Depop shows a visitor

Read live on 2026-10-31 in a fresh browser context with no cookies (through `market-pace.sh`):
the search page (`/search/?q=<words>`) loads its results from Depop's same-origin API, 24 at a
time, the most relevant first: `GET /presentation/api/v1/search/products/?what=<words>&limit=24
&country=us&currency=USD&from=in_country_search`, answering each product's brand, Depop product
type (`attributes.product_type`), sizes, description, status, and price, and the search's
`total_count`. **Depop shows a visitor no sold listings**: its search has no sold filter, and its
pages ask for similar items with `hide_sold_products=true`. So, by the captain's call through
firstmate (2026-10-31), the reader never sends a request Depop's own pages do not send, and:

- **Depop's numbers are asking prices** of close matches for sale, always shown under
  "Asking prices - not sold listings" (`ASKING_PRICES_LABEL`, held by the label guard), never
  as sold prices;
- **the sold side is the household's own Depop sales** (`ownSales`, as before);
- **the trend read is the household's recent sold pace against Depop's live supply**
  (`marketDemand`).

Marketplace sold prices arrive with the eBay reader ("eBay" below).

### The read

1. **The query** (`comparisonQuery`, on the server). Never the brand alone: a query needs the
   brand and an item type, so a read without a brand or a category searches nothing ("Not
   enough to search Depop for"). The words are the brand, the exact model or line, and the type
   as a buyer types them ("levis 501 jeans"); the match is held to Depop's product types for the
   item's category (from `mapDepopCategory`, every department when the read could not tell),
   with the type's own words for a listing without one.
2. **The phone reads it** (`listoraPhone.compare`): from the warm search page, the one GET the
   search page itself makes, through the same session rules as every automated read (pacing,
   the read-only page driver, the page inspection after every action).
3. **Matching** (`marketStats`): only listings of the brand (by `brandKey`) **and** the type;
   then the tightest level with at least 5 (`MIN_MARKET_MATCHES`): the model and the size, the
   model, the type and the size, the type. Outliers past 1.5 interquartile ranges are left out
   (a "$1 to trade" or a "$500 rare" listing must not move a range).
4. **Only numbers leave the phone**: the level, the asking quartiles, the counts read, and the
   search's total (`saveScanComparison`). Never a listing, a seller, a slug, or a photo.

### On the card

- **The row**: "Depop: asking $15-$25, 6 like it for sale" under the asking label, with the
  demand ("Sells for you, little competition" or "Crowded on Depop", with what it rests on:
  "Your 4 sales like it in the last 90 days; 40 for sale on Depop now"). While the phone reads it:
  "Checking Depop..." with a spinner. Without numbers it says why: "Not enough similar listings
  on Depop", "Depop prices paused today", "Not checked: Depop limit for this hour", "Couldn't
  check Depop". A read the app could not make is answered as failed, so a card never waits on
  one that will not come.
- **In the call**: close matches' asking prices hold the AI estimate's or the web's range to
  their high quartile (sellers ask more than buyers pay; "the range is held to them"), from 5 of
  them (`minAskingMatches`); they never move a range from the household's own sales. The demand
  is a signal only: supply alone says little about how fast an item sells, so it moves no call
  until a marketplace's sold pace comes with its comparisons.

### Account risk

- **No account in the read.** The comparison page is the app's own web view with a
  non-persistent data store, never given the seller's cookies and never the page their
  automation runs in. The phone runtime's lane (`RuntimeLane`) and its sessions are not used.
- **Phone only.** The server never reads a marketplace for a comparison; it hands out each read
  and takes the numbers.
- **Stop at the first check.** A CAPTCHA, a bot check, a sign-in page, or a 403 that is not JSON
  ends the read as `check`, and is never passed or handed to the seller (no session of theirs is
  involved). The server then hands out no Depop read for the account for 24 hours, and the
  iPhone reads none either (`ComparisonPauses`): "Depop prices paused today". A rate limit
  pauses for an hour.
- **Budgets** (`COMPARISON_LIMITS`, starting points to tune in the live test): Depop 60 reads an
  hour and 300 a day per account; past them, "Not checked: Depop limit for this hour".
- **Cache.** A read of the same search (`comparisonQueryKey`: the words, brand, model, size, and
  types) from the last 24 hours answers the next scan without a read, so a rack of one brand and
  model costs one.
- **Honest browser.** WebKit as it says, no disguised user agent, no proxy; the page loads only
  the marketplace's own origins. Images, fonts, and media are blocked
  (`WebMarketComparisons.blockedMedia`), so a read moves only its data.
- **Warm-up.** Starting a run opens Depop's search page in its comparison web view
  (`listoraPhone.warmUp`), so the first read starts warm; ending it lets the pages go.
- **Off locally.** `MARKET_COMPARISONS=off` (`.env.example`, and the e2e stack) hands out no
  read, so a simulator never reads a real marketplace; deployments default to `on`.

### The API

- `ItemScan.comparisons`: each marketplace's row (`ScanComparison`: `status` `checking`,
  `read`, `not_enough`, `paused`, `limit`, or `failed`; its `label`; `asking`, `supply`,
  `demand`, `cached`; and while `checking`, the `read` the phone runs).
- `PUT /v1/scans/{scanId}/comparisons/{comparisonId}` (`saveScanComparison`): the phone's answer
  (`ScanComparisonAnswer`: `read` with its `stats`, `check`, `rate_limited`, or `failed`), which
  answers the scan with the call made again. An answer again changes nothing. `404` where the
  scan or the marketplace's comparisons are not on for the account. The web research makes its
  call again under the scan's lock, with the comparisons as they are then, so neither answer
  loses the other.

### Data

- `market_comparison`: one row per read handed to the phone: the account, the scan, the
  marketplace, the search and its key, the status (`pending`, then `read`, `check`,
  `rate_limited`, or `failed`), the numbers (`stats`, `for_sale_total`), and the read's time.
  The rows are the budget, the cache, and the pause. Deleted after 7 days (`marketComparisons`,
  [privacy.md](privacy.md#retention)).
- The scan's comparisons as the card shows them are in `item_scan.call_detail`.

### Tests

- `@listora/sourcing` (`market.test.ts`: brand and type both required, the levels, outliers,
  the demand; `call.test.ts`: the asking cap and the demand signal), `@listora/pricing` (the
  asking label in the guard).
- `packages/automation/src/comps`: the query (`query.test.ts`) and the lane on the phone's page
  backend against a stand-in search (`run.int.test.ts`: the match and count, the warm-up, and a
  bot check, a 403 that is not JSON, a CAPTCHA page, and a rate limit each stopping the read);
  the recorded real search (`depop/recordings/search.json`, recorded logged out with
  `npm run recordings:record -- depop --logged-out`, [recorded-pages.md](recorded-pages.md)).
- `apps/api/src/scans/comparisons.int.test.ts`: the read handed out by brand, type, model, and
  size; the asking prices under their label and the AI estimate held to them; the cache; the
  pauses after a check and a rate limit; the hour's budget; no query without a brand; too few
  matches; the web research after a comparison keeping it; a failed read; another account's scan
  and malformed answers (a listing, quartiles out of order, more counted than read) refused.
- iPhone: `ScanTests.swift` (the warm-up, one read per comparison and the card taking it in, a
  read the lane can't make, comparisons off, a paused row), `ComparisonPausesTests.swift`.

**The phone needs a new app build** for the comparisons.

## eBay (M3)

eBay's row is the card's first market sold prices: what close matches sold for on eBay, and
eBay's own sold pace. Its comparisons are behind their own gate (`market_comps` on eBay,
[verified-features.md](verified-features.md)), hidden from sellers until the captain's live test.

### What eBay shows a visitor

eBay shows a logged-out visitor its sold listings: the results page's own "Sold items" filter
(`/sch/i.html?_nkw=<words>&LH_Sold=1&LH_Complete=1`), here sorted by its "Time: ended recently"
(`_sop=13`), lists each sold result with its title, the price it sold for, and the day it sold
("Sold Oct 28, 2026"), and the search's own count of results (about the last 90 days,
`COMPARISON_SOLD_WINDOW_DAYS`). The plain results page (`/sch/i.html?_nkw=<words>`, "Best
Match") lists what is for sale now, with its count. Both are server-rendered pages: a read loads
the two URLs the page's own filter and sort make, and nothing else (never a signed-in session, a
watch, a bid, or any account).

### The read

1. **The query.** As for Depop (`comparisonQuery`): never the brand alone, so a read needs the
   brand and an item type; the words are the brand, the model or line, and the type. eBay's
   results name no brand or category, so a match is held to the title's words.
2. **The phone reads it** (`listoraPhone.compare`, `comps/ebay.ts`): the sold page, then the
   for-sale page, each one page load (60 results, eBay's default), through the same session
   rules as every automated read. Of each result only the title, the price, and the sold day
   are read (`ebay/pages/search-page.ts`); never the seller, the photo, the item number, or
   where it ships.
3. **What is never counted.** Results after eBay's "Results matching fewer words" line (they
   are not the search's), lots and bundles ("lot", "bundle", "bulk"), price ranges (a listing of
   many sizes), eBay's placeholder results, and sold listings whose best offer was accepted
   (eBay shows their asking price struck through, not what they sold for).
4. **Matching** (`marketStats`): the title must name the item's brand (by `brandKey`: "Levi's",
   "LEVIS", and "Levi" are one) **and** its type ("jeans", "denim"); the levels add the model and
   the size the title names ("32x30", "W32 L30", "Size M"). Sold listings choose the level (the
   tightest with 5), and outliers are left out, as for Depop.
5. **Only numbers leave the phone**: the level, the sold and asking quartiles (the sold ones
   with how many days back the oldest sold), the counts read, and both searches' totals
   (`forSaleTotal`, `soldTotal`).

### On the card

- **The row**: "eBay: sold $18-$30, 9 like it in the last 14 days" under "Sold listings on eBay"
  (`marketSoldLabel`), from 3 sold close matches (`MIN_SOLD_SHOWN`); without them, eBay's asking
  prices as Depop's ("eBay: asking $25-$35, 4 like it for sale"). The words "sold" appear only
  under that label or the household's own sales: the label guard (`scanLabelViolations`) lets a
  comparison with sold listings, and words that start with "Sold listings on", speak of sold
  data, and holds a call resting on eBay's sold listings to having them.
- **The trend read** (`marketSoldPace`, apart from the phone's `market.ts`): eBay's search sold
  count over its 90 days against its count for sale now. "Sells fast on eBay" from as many sold
  as are for sale (`SELL_THROUGH_FAST`), "Slow on eBay" at a quarter or less
  (`SELL_THROUGH_SLOW`), with what it rests on ("Sold listings on eBay: 410 in the last 90 days;
  320 for sale now"). Starting thresholds, to tune in the live test.
- **In the call**: with fewer than 3 of the household's own sales like it, at least 5 sold close
  matches (`minMarketSold`) are the range (`market_sold`, "The call" above). A slow eBay search
  keeps a call from high confidence; a fast one never raises it.

### Account risk

As for Depop ("Account risk" above): no account in the read (the app's own non-persistent web
view, never the seller's), phone only, stop at the first check (eBay's security check at
`/splashui/challenge`, "Pardon Our Interruption", a sign-in page; `signin.ebay.com` is one of the
page's origins only so a sign-in wall loads and ends the read as a check), the 24-hour cache,
the pauses, images and media blocked, and the warm-up (eBay's home page). **Budgets**: 30 reads
an hour and 150 a day per account (each read loads two pages); once 20 of the hour's are used,
the rest go only to items the AI prices at $25 or more at the high end
(`COMPARISON_LIMITS.ebay.saveForPricier`), where a comparison can change the call most.

### Data

- `market_comparison.sold_total`: the sold search's own count (eBay's), beside `for_sale_total`
  (migration `20261031191803_ebay_comparisons`, which also allows `item_scan.basis`
  `market_sold`).
- `ScanComparison.sold` (`ScanSoldPrices`) and `ScanComparisonAnswer.soldTotal` in the API.

### Tests

- `@listora/sourcing`: `market.test.ts` (brand and type read from a title, never a Depop
  listing's words), `pace.test.ts` (the sold pace), `call.test.ts` (the sold range before the
  web and the AI, its confidence, a slow search, Depop's asking prices first);
  `@listora/pricing` `labels.test.ts` (eBay's sold listings under their label only).
- `packages/automation`: `ebay/pages/search-page.test.ts` (the URLs, counts, sold days, title
  sizes, the fewer-words line), `comps/ebay.int.test.ts` (the lane on the phone's page backend
  against a stand-in results page: the match and count, what is never counted, no results, the
  warm-up, the security check). **No recorded real page yet**: recording eBay's public search
  logged out from the Mac's Chrome (2026-10-31) met a bot check on its first page load, and it
  was not tried again. The results page's selectors (`EBAY_SEARCH_PAGE`, eBay's current `s-card`
  layout and its earlier `s-item` one) are Listora's model of the page until the captain's live
  test reads the real one; a page that differs fails the read ("Couldn't check eBay"), never
  counts anything wrong.
- `apps/api/src/scans/comparisons.int.test.ts`: eBay's read handed out, the call on its sold
  listings with the pace and the cache, asking prices alone, no match, the hour saved for
  pricier items.
- iPhone: `ScanTests.swift` (eBay's row under its sold label).

**The phone needs a new app build** for eBay's comparisons. Live test: the captain on his phone at
a store, logged out, eBay only, in Test mode (the gate stays off for sellers). It decides whether
eBay lets a logged-out iPhone read its search at all: the Mac's recorder met eBay's bot check, and
a check on the phone pauses eBay's comparisons for the day ("eBay prices paused today").

**Fixed with it.** A read in which nothing matched used to send `level: null`, which the API
refused, so the card said "Couldn't check Depop"; the phone now leaves the level out, and the row
says "Not enough similar listings".

## Upgrading drafts (M6)

A kept scan's draft has only the scan's shot (and its tag close-up). Before it can be listed it
needs its real photos; this is how a whole run gets them.

### On the iPhone

- **The list.** Add Item lists each run's kept drafts together under **Kept at the store** ("5
  kept · 4 need photos"), in the order they were kept, newest run first. A draft is named by the
  scan's read ("Acme Outfitters blue button-up shirt", its SKU underneath once the server has
  one), and a draft whose only photos are the scan's shots is marked **Needs photos**
  (`Draft.needsPhotos`). Today's `review_drafts` card opens this list, as before.
- **Shoot this run** opens the guided camera (`CameraCaptureView`, front, back, tag, details) on
  the run's drafts that need photos, one after another (`RunShootView`), with each one's scan
  shot and name on screen ("3 of 23: Acme Outfitters blue button-up shirt"). Each item's
  boundary is known, so there is no grouping step. **Next item** (**Done** on the last) saves the
  item's photos and moves on; **Shoot later** leaves it for later (not "Skip", which leaves out
  one photo of the guide); closing the camera ends the shoot and keeps the
  items already shot. Background cleanup is in the draft's editor, as for any draft.
- **The scan shot goes** once the real photos are taken (`replaceScanShots`): the new photos come
  first, and the scan's shots are deleted, on the server too by the upload queue, unless the
  seller taps **Keep scan photo**, which keeps them after the new ones.
- **Shoot this run** and **Review N items** sit at the top of the run's drafts, under its header,
  so a run of 23 never hides them below its last draft.
- **Review N items** opens the batch's rapid review (`BatchReviewView`, [batch.md](batch.md)) on
  the run's drafts whose real photos are all on the server, in the order kept; a draft still
  uploading waits ("1 item uploading its photos, then ready to review"), so an analysis never
  runs on half of an item's photos. Each page starts the item's analysis as the single-item
  review does; approving saves the item and its draft on this iPhone is done. The summary says
  "Run reviewed".
- **Data** (GRDB migration "v5: scan drafts' runs and shots"): `draft.scanRunID` (the run on this
  iPhone) and `draft.scanTitle` (the read's name), and `draftPhoto.isScanShot`. A scan kept
  before this version has no run: it shows with the other drafts, still marked Needs photos.

### The analysis

The item's full analysis (the ordinary `item_analysis`, `ai_items` quota, about $0.0015) runs once
on the real photos, with the read of the scan it was kept from sent as `scanRead` in the request
(`loadAnalysisInput` reads `item_scan.read` of the kept scan). It is the identity only (brand,
item, model or line, style number, era, material, category, department, size, condition, the
read's confidence, and visible damage), never the scan's price guess, so the analysis prices from
its own photos. The cached system prompt tells the model it is a quick read of one shot at the
store: a hint to check, where the photos always win, as an escalation checks `firstAnalysis`.

### Tests

- `packages/analysis`: `prompt.test.ts` (the hint sent, without a price; none without a scan;
  `scanReadHint` on partial and empty reads) and `job.int.test.ts` (a kept scan's read sent with
  its item's analysis, and no other item's).
- iPhone: `KeptRunTests.swift` (scan shots and Needs photos after a relaunch; the shoot's photos
  first and the scan shots gone, or kept; the photo limit; a deleted draft; runs grouped and
  ordered; only fully uploaded items reviewed; the words; the upload queue replacing the scan
  shot on the server); `ScanTests.swift` (Keep records the run and the read's name);
  `ThriftScanUITests.testAKeptScanIsShotWithRealPhotosThenReviewed` end to end on the local stack.

**The phone needs a new app build** for M6. Live test: the captain lists a run's draft on
`tonioreign`.

**Follow-ups.** Start each draft's analysis in the background as soon as its real photos are on
the server (today the review starts it, with the next page loaded ahead), and keep a run's
drafts grouped by the server's run on a second device.

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

Scan mode shows locally wherever every built feature does (`MARKETPLACE_FEATURES=all`, as the
local stack and the tests run), and otherwise only in the owner's Test mode. The fake
AI answers a scan from a fixture's `thrift_scan` output (the UI tests' `FakeAI/default.json`
reads every shot as the same shirt); the iPhone simulator scans with the debug fake camera
(`LISTORA_FAKE_CAMERA`).

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
- **M2 live test** (the captain, Test mode, a real store, 30 or more scans): the speed targets
  above on cellular, then `thrift_scan` into `VERIFIED_APP_FEATURES` with its evidence.
- **M3 live test** (the captain, Test mode, the captain's iPhone at a store): Depop's comparison
  row within 4 s of the shutter, the budgets and the pause tuned on evidence, then
  `market_comps` on Depop into `VERIFIED_FEATURES`. eBay sold, Poshmark, and Mercari readers
  follow, each its own PR and gate.
- **M4 live test** (the captain's own trip, Test mode): check a run out at the register and
  compare the haul's shares and the summary with the receipt.
- **Mileage** is only recorded on the run; turning it into a deductible expense belongs to the
  plan's mileage and expenses item.
- **Later milestones:** scanning with no signal and a run that survives a relaunch (M5).
  Upgrading a run's drafts (M6) is built; its live test is the captain listing a run's draft on
  `tonioreign`.

## Data

The scan's tables are in "Data" under M2 above. The own sales read `sale`, `sale_item`, and
`inventory_item` ([sales.md](sales.md), [items.md](items.md)) and write nothing.
