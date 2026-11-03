# Thrift scan: the Buy / Your call / Skip call, and the seller's own sales

The thrift scan helps a seller decide at the store, in seconds, whether an item is worth buying
to resell: one shot of the item (and an optional tag close-up), a short AI read, a price range
from the seller's own sales or the AI, and a call of **Buy**, **Your call**, or **Skip** with a
confidence word. Built so far: the rules, the AI read, and a backtest on real sold items (plan
milestone M0); the seller's own sales as real sold data (`own_history`, M1) on the item's
price screen and in the sourcing kit (`GET /v1/sourcing/kit`); the scan itself online (M2):
Add Item's Scan mode, `POST /v1/scans`, Keep into the run, and the run's tray; Depop's
comparisons from its public search, read on the seller's iPhone logged out (M3, "Marketplace
comparisons" below), then eBay's, the card's first sold prices from a marketplace ("eBay"
below); the run itself (M4): its place, the checkout at the register into a haul, and the run's
summary with the haul's estimated resale and profit; the scan with no signal (M5): the instant
read and call from the household's own sales, the queue that reads the waiting scans once there
is signal, and duplicate warnings; and upgrading a run's kept drafts with real photos (M6):
"Needs photos", Shoot this run, the full analysis with the scan's read as a hint, and the run's
rapid review; and "What sells for you" (plan rank 7, "Sourcing insights" below): the household's
best and worst brand and item type pairs and a short "Look for" list for the bins. Scan mode is hidden from sellers until it passes live
(`thrift_scan`, [verified-features.md](verified-features.md)), and each marketplace's
comparisons until they do (`market_comps`): only the owner's Test mode has them. The server
never reads or writes a marketplace; nothing in the scan ever writes one, and the comparisons
read only what any logged-out visitor's browser reads.

Code:

- `packages/sourcing` (`@listora/sourcing`): the pure rules, with no I/O. `quartiles`, `brandKey`
  (how two brands compare), `ownHistoryComparisons` (the seller's own sales like the item),
  `scanCall` with `DEFAULT_SCAN_CALL_SETTINGS` and `decideCall` (the rule both calls share),
  `priceCalibration` (`calibration.ts`, the AI estimate and the web's asks scaled to the
  seller's sales), `snapBrand` (a near miss of an own brand), `scanPrices` (`prices.ts`, the
  card's list at, realistic sale, and fast sale),
  `ownHistoryByMarketplace` (the price screen's), `sizeBucket`, `buildSourcingKit`,
  `offlineScanCall` (the call with no signal) with its golden cases (`offline-call.cases.ts`),
  `unsoldLikeIt`, and `buildSourcingInsights` ("What sells for you", `insights.ts`).
- `apps/api/src/sourcing`: the sales that count, the kit's route, and the price screen's own
  history, which `getItemPricing` shows ([pricing.md](pricing.md)). Nothing there calls a
  marketplace or AI: every number comes from the sales Listora already recorded
  ([sales.md](sales.md#sales-history)).
- `packages/analysis/src/scan.ts`: the AI read, `scanItem` (purpose `thrift_scan`, standard tier,
  no item quota, thinking off), with its own small output schema `thrift_scan`, held to its enums
  (`strictEnums`), and a cached system prompt. `scan-research.ts` and `brand-pulse.ts`: the web
  research and the brand pulse (below), checked against the pages the searches returned
  (`web-pages.ts`).
- `packages/eval/src/scan/`: the backtest, `npm run eval -- scan`.
- `apps/api/src/scans` and `apps/api/src/sourcing-runs`: the scan's read and Keep, and the run
  with its checkout and summary (below); `scanOwnHistory` and `runEstimate` in
  `@listora/sourcing` and `scanResearchLinks` and `scanLabelViolations` in `@listora/pricing`.
- iPhone: `AddItemFeature/Scan` (the camera, the card, the tray, the run, the note, the
  measurements, the start and checkout sheets, the run's summary, the kept run's section,
  guided shoot, and review, and with no signal `ScanRuns`, the queue `ScanQueueStore`,
  `SourcingKitCache`, and `ScanConnectivity`; and `SourcingInsights.swift`, "What sells for
  you"); `Core/Sourcing` (the kit, `BrandKey`, and
  `OfflineScanCall`, the app's copy of the offline call). A kept scan is an ordinary draft whose
  server item `keepScan` creates.
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
   (`market_sold`, "eBay" below); otherwise what the web's used listings ask; otherwise the AI
   estimate's low to high, labeled "AI estimate - not based on sold listings". The web's asks
   and the AI estimate are first scaled to what the seller's own items sell for
   ([Calibrated to the seller's sales](#calibrated-to-the-sellers-sales)). Own sales match at the tightest level that has 3:
   the same brand and category, then the same brand, then the same category (`MATCH_LEVELS`).
   Brands compare by `brandKey` ("Abercrombie & Fitch" and "Abercrombie", "Levi's" and "LEVI"
   are one brand; "American Eagle" and "American Apparel" are two), after a near miss of one of
   the seller's own brands is snapped to it ([Brand snap](#brand-snap)).
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

## Three prices

The card answers the way a reseller asks a chatbot at the bins ("List: $65-$75, Realistic sale:
$40-$55, Fast sale: $30-$40"), with three prices instead of one range (`scanPrices` in
`@listora/sourcing`, `prices.ts`; `ScanCall.prices` in the API):

- **Likely sale** (called the realistic sale until 2026-11-02; `realisticSale` in the API): what
  the item is expected to sell for, the middle of what the call rests
  on: the median of the seller's own sales like it (raised with the range for tags still on), the
  AI estimate's middle, or the midpoint of eBay's sold quartiles or of the web's scaled asks;
  held inside the range (a range held to the retail price or to close matches' asks holds it too).
- **Fast sale**: the range's low end, what it would likely go for quickly.
- **List at**: the asking price that leaves room for offers: the realistic sale over the seller's
  own sale-to-asking ratio ([Calibrated to the seller's sales](#calibrated-to-the-sellers-sales);
  75% with no sales of their own), and never under the range's high end, since listing under what
  items like it go for leaves money behind.
- **Friendly prices.** Whole dollars under $20, $5 steps under $100, then $10 steps; the fast sale
  rounds down and the list price up, so the three never cross.
- **From what the call has.** All three come from the call's range: no AI call or web search is
  added for them, and they show once the call's sources are in
  ([Prices after the facts](#prices-after-the-facts)).
- **The call is untouched.** Buy / Your call / Skip, its confidence, its range, and its payouts
  are as before; the three prices are shown next to it, never fed into it. They are estimates, so
  their wording never says "sold" (a unit test checks it with `claimsSoldData`).
- **On the card.** The iPhone's card shows the three side by side, the realistic sale leading,
  instead of the range ("scan.prices"). The server also sends them as the call's first signal
  (`prices`: "List at $35 · Likely sale $25 · Fast sale $17", with where they come from), so
  an app built before them lists them with its other signals; a build that shows them leaves that
  signal out. The instant read with no signal (`offlineScanCall`) still shows its range.

**Backtest, 2026-11-02** (`npm run eval -- scan --replay`, the stored one-photo reads with the web
lookup and the two-photo reads, no new AI spend; the household's 64 Depop sales, leave-one-out,
the call as it is today, `calibrated`). "Fast to list": the sale price from the fast sale to the
list price; "near realistic": within 25% of the sale.

| Reads                          | Fast to list | Under fast | Over list | Near realistic | Realistic error (bias) |
| ------------------------------ | ------------ | ---------- | --------- | -------------- | ---------------------- |
| One photo, with the web lookup | 41/64 (64%)  | 12 (19%)   | 11 (17%)  | 25/64 (39%)    | 36% (0%)               |
| Two photos, reads only         | 37/64 (58%)  | 13 (20%)   | 14 (22%)  | 25/64 (39%)    | 37% (+5%)              |

By category (one photo): bottoms 18/24 fast to list, 12 near realistic, 23% error; tops 19/34,
11, 48%; outerwear 2/3; dresses 1/2; shoes 1/1. The call's old single range held 36/64 of the
sales on the same reads, so the band from fast sale to list price holds 5 more while its middle,
the realistic sale, carries no bias. The calls did not change (10 Buys, 9 held; 2 Skips, both
held). Measured and not taken: the list price from the ratio alone, without the range's high end
as a floor (35/64 fast to list, 17 over the list price); a fast sale at the realistic sale times
the ratio when under the low end (no change).

## Prices after the facts

The card gives a price only once it has what that judgement needs, never from the first look
alone (the captain, 2026-11-02: "a price should be given after we have the information needed to
make that judgement ... i prioritize correctness over quickness"). The read still answers in
about 1.4 s, and the card says at once what the item is; the prices and the verdict follow when
what they rest on is in (`apps/api/src/scans/pricing.ts`, `research-runner.ts`, `wait.ts`):

- **What they wait for.** The household's own sales like it (checked with the read); the web
  research with the brand's pulse ("Web info" below); and each marketplace comparison that is on
  for the account (`market_comps`, read on the seller's iPhone). A read without a brand has
  nothing to look up and no comparison to read, so it is priced at once from the own sales and
  the scaled AI estimate, as before.
- **The research starts with the read.** The server starts the lookup the moment the scan is
  stored (after its transaction commits), not when the app asks, so the wait is as short as it
  can be. The scan's row claims it (`item_scan.research_started_at`, on the database's clock), so
  of two API tasks, or the read and the app's ask, only one pays for it; a claim over a minute old
  (`CLAIM_STALE_MS`, its task stopped) can be taken again. Closing the API waits for the lookups
  it runs.
- **While they wait** (`ItemScan.pricing.status` `checking`), the answer holds every price: no AI
  estimate, retail price, research, or own-sales lines, comparisons without their numbers ("Checked
  Depop", with the count for sale), and the call `checking` ("Checking prices", its confidence the
  read's). `pricing.label` is the card's quiet progress line, "Checking prices: the web, Depop".
- **The wait.** `researchScan` (`POST /v1/scans/{scanId}/research`) now answers once the prices
  are in: it starts the lookup if it is not running (after a failure, or for a scan read before a
  restart), then waits for the research and the comparisons, woken at once by this process's
  saves and looking every 0.5 s for another task's (`LOOK_MS`). Each source waits at most 15 s
  (`PRICE_WAIT_MS`): from the read for a comparison, from its start for the lookup.
- **What is missing.** A lookup that failed, a comparison that failed, paused, or hit its limit,
  and a source still out at 15 s are named (`pricing.missing`: "Couldn't check the web in time",
  "Couldn't check Depop", "Depop prices paused today"), and the prices show from what did come
  back. A missing source is only ever left out of the call, so it can never raise the confidence:
  the call is exactly the one made without it (tested). A failed lookup is stored as `failed`, and
  the next ask tries again; a late answer still comes in and makes the call again.
- **Installed apps** see the same: the held answer's call is `checking` (shown by its label,
  "Checking prices"), and once ready each missing source is also a signal (`missing`). An installed
  app asks for the research two seconds after the card (and the server started it at the read), so
  its card shows the prices about when a new build's does, if the card is still on screen; a card
  it moved on from shows them when it is picked again in the tray.

## The card

Easy to follow at a glance, the way a friend who checked would say it (the captain and Tristin,
2026-11-02, from her ChatGPT answers at the bins: "GRAB - this is actually a solid Depop-style
sweater ... Verdict: KEEP IT"):

- **The verdict first**, stamped big in its color: **Grab** (green, `buy`), **Maybe** (amber,
  `your_call`, with "Your call" beside it: the seller decides), **Leave** (red, `skip`), with its
  one-line why (`ScanCall.why`, `callWhy` in `@listora/sourcing`): "Even its low end pays out $11
  after fees, over your $8", "Pays out $5-$12 after fees: it may or may not clear your $8", "Pays
  out $9-$15 after fees, but often faked: check it's real", "Pays out $6 at most after fees, under
  your $8". The rule is unchanged ("The call" above); only its words are.
- **What it is**: the brand and item, then the size, material, era, and condition when known
  ("Size L · Wool · Vintage 1990s · Pre-owned good"); while the prices wait, how sure the read is
  ("Sure of what it is").
- **The three prices**: List at, **Likely sale** (leading), Fast sale ("Three prices" above), then
  the call's confidence and what it rests on in one small line.
- **A reality check** (`ItemScan.realityCheck`, `apps/api/src/scans/card.ts`): short plain lines,
  each from the scan's own data: the household's own sales like it ("You sold 3 like it on Depop:
  $25-$29, most around $28"; eBay's "shown, not used for the price"), sold listings elsewhere only
  with real sold data ("Sold listings on eBay: $18-$30, 9 like it in the last 14 days"), what
  listings ask now said to be asks ("Depop asks $15-$25 now, 6 like it for sale (asks, not
  sales)", "Listings on the web ask $30-$50 (poshmark.com)"), the original retail price ("Retail
  about $98 (levi.com)"), the brand's pulse in one line ("Levi's is in demand on the web: ..."),
  and what could not be checked. The label guard holds it: a line of the household's own sales
  says "sold" only with such sales, one of sold listings only under their label with a comparison
  of them, and no other line says it.
- No walls of labels: the per-marketplace own-sales rows, the AI estimate row, the web info block,
  and the comparison rows give way to the reality check (a server without it shows the call's
  signals instead). Flags, the duplicate warning, Shoot the tag, Search Depop, **Put back**, and
  **Keep** are as before, and usable the whole time the prices wait.
- It always fits the screen. The card takes the room the camera's controls leave, keeping a band
  of live viewfinder above it. When it holds more than fits (a long reality check, a large text
  size, a small iPhone), what sits above its answers scrolls inside the card. It opens at the top
  (the verdict, then the prices), flashes its scroll bar, and fades the line cut at its edge.
  Shoot the tag, Search Depop, **Put back**, and **Keep** stay pinned at its bottom, and the
  shutter stays below it. When their words would not fit, the answers drop their icons rather
  than truncate.

## Calibrated to the seller's sales

The AI estimate and the web's asking prices both run above what items really sell for: on the
backtest (below) the AI's middle was 26% over the sale and the web's asks more than twice it.
So before either holds a range, the call scales it by what the seller's own items went for
against what their listings asked (`priceCalibration` in `@listora/sourcing`, `calibration.ts`):

- **The ratio.** The median, over the seller's sales whose prices the call models (not eBay's),
  of each sale price over the asking price it sold from: the sold listing's price, else the
  item's list price. Each sale's ratio is held to 30%-100%, so a bundle or a typo'd ask never
  moves it far. It is weighed against a **default of 75%** (what buyers' offers usually come to)
  as if the default were 5 more sales, so a seller with no history gets 75% and their own ratio
  takes over as their sales grow. It is computed per account, at each call, from that account's
  own sales: no seller's numbers live anywhere else.
- **The AI estimate of a named brand** is scaled by the ratio once: the AI prices a named brand
  like its listings ask (35% over the sale on the backtest), but not an item it could not name
  (7%), whose estimate stands.
- **The web's asks** are scaled by the ratio twice: other sellers' asks run as far above what
  the seller's own items list for as those listings run above what they sell for (the web's
  asks were 2.2 times the sale; the household's ratio squared is 0.56).
- **What it never touches:** the seller's own sales, a marketplace's sold listings, and the
  ranking (own sales, then sold listings, then the web, then the AI estimate). The retail cap
  and the hold to what close matches ask apply after the scaling.
- **On the card.** The AI estimate shows scaled, under its label; the research's own line still
  shows the web's asks as they came ("Asks $30-$50 on poshmark.com"). A range from the web says
  it is asks: "Web info - not sold listings: asks on poshmark.com, scaled to your sales". A
  `calibrated` signal says what was scaled and by what: "Scaled to your sales · Your items went
  for 75% of what they asked (64 sales); the AI estimate and the web's asking prices are scaled
  to it" (with no sales: "Items usually go for about 75% of what they ask; ...").
- **By category** was measured and not taken: one ratio per category group (drawn toward the
  seller's overall ratio) gave the AI estimate a median error of 38% against 35% for one ratio
  overall, since a category's few sales move its ratio more than its items differ.

### Brand snap

A read brand that nearly spells one of the seller's own sold brands is snapped to it when the
scan is read (`snapBrand` in `@listora/sourcing`, `snappedRead` in `apps/api/src/scans`), so the
card, the own sales, the web research, and a kept item all name the brand the household sells:
"Wrenfeld" (an invented brand) becomes Wrenfield when the household sold Wrenfield. Only when
unambiguous: the read does not already match one of them (`brandKey`), its key is at least 5
letters, and exactly one of the seller's brands is within 2 edits and 1 in 5 letters of it. Only the seller's own
brands are candidates, so a different brand of a similar spelling they never sold is left as
read. The scan stores the snapped read; its log line says `brandSnapped`.

## The backtest (`npm run eval -- scan`)

```sh
npm run eval -- scan --dataset <dir>                         # fake AI: plumbing only, free
npm run eval -- scan --dataset <dir> --provider none         # own sales only, no AI
npm run eval -- scan --dataset <dir> --provider anthropic    # the real read; ANTHROPIC_API_KEY
npm run eval -- scan --dataset <dir> --provider anthropic --images 2 --worth-listing 10
npm run eval -- scan --dataset <dir> --provider anthropic --research --json > run.json  # with the web lookup
npm run eval -- scan --dataset <dir> --replay run.json       # the same answers again, free
npm run eval -- scan --dataset <dir> --provider anthropic --research --max-spend 1.00  # capped
```

`--research` looks each read up on the web the way the scan does (`researchScanItem`, asked
about the read by `scanResearchSubject`, the same as `researchFor`), about $0.025 a lookup.
`--replay` answers the reads, and the research when the file has them, from an earlier run's
`--json` report, so a change to the call or the calibration is measured on the same model
answers without paying for them again.

The report also scores the card's three prices ([Three prices](#three-prices)): how many
sale prices land from the fast sale to the list price, under the fast sale, over the list price,
and within 25% of the realistic sale (`NEAR_REALISTIC`), and the realistic sale's median error.

For each sold item it makes the scan's read from the item's photos, compares the item with the
set's other sales (leave-one-out), makes the call, and scores all three against what the item
really sold for. Three call variants run: `ai`, the scan's own read with the AI estimate and the
web's asks as they came (the call before the calibration); `calibrated`, the same read with the
brand snapped and the prices scaled (the call at the store today), each item's snap and ratio
from the set's other items only, so an item never calibrates itself; and `labels`, the set's
labeled brand and category with full confidence and no AI estimate (the best an
own-history-only call could do). With a read, a price table scores the AI estimate, the web's
asks, the own sales' quartiles, and the call's range, before and after, overall and by the
labeled category's group. A sweep repeats the call at worth-listing amounts from $5 to
$20. The report holds counts and money only, no title or brand, so a private set's report can be
shared; `--items` adds one line per item (its id, sale, payout, and calls) and `--json` the full
report, including the AI's reads.

`--max-spend <usd>` caps a live run's AI spend (the reads and the lookups together): what comes
after the cap fails instead of being sent, and is counted as failed.

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

### Results, 2026-11-02: the calibration

The same 64 sales, read again by today's prompt (`claude-haiku-5-5`, one photo, all 64 read) and
looked up on the web (42 with a brand, 40 with a resale range), $1.03; the numbers below
replay those answers (`--replay`). Each cell: the sale inside the range / priced, the median
error, and the bias.

| Group (items)     |        | AI estimate       | Web asks            | The call's range  |
| ----------------- | ------ | ----------------- | ------------------- | ----------------- |
| All (64)          | before | 34/64, 41% (+26%) | 19/40, 115% (+115%) | 32/64, 48% (+32%) |
|                   | after  | 40/64, 34% (+1%)  | 23/40, 38% (+21%)   | 36/64, 45% (+22%) |
| Bottoms (24)      | before | 14/24, 37% (+30%) | 9/17, 130% (+130%)  | 15/24, 31% (+22%) |
|                   | after  | 17/24, 30% (+10%) | 10/17, 38% (+29%)   | 16/24, 29% (+15%) |
| of them jeans (8) | before | 3/8, 68% (+68%)   | 4/8, 154% (+154%)   | 4/8, 27% (+22%)   |
|                   | after  | 6/8, 26% (+26%)   | 6/8, 43% (+43%)     | 4/8, 27% (+22%)   |
| Tops (34)         | before | 16/34, 43% (+10%) | 10/18, 80% (+80%)   | 16/34, 62% (+36%) |
|                   | after  | 18/34, 42% (-12%) | 11/18, 27% (+1%)    | 17/34, 52% (+13%) |
| Outerwear (3)     | before | 2/3, 56% (+56%)   | 0/3, 224% (+224%)   | 0/3, 224% (+224%) |
|                   | after  | 3/3, 17% (+17%)   | 2/3, 82% (+82%)     | 2/3, 82% (+82%)   |
| Dresses (2)       | before | 1/2, 194% (+194%) | 0/1, 483% (+483%)   | 1/2, 265% (+265%) |
|                   | after  | 1/2, 138% (+138%) | 0/1, 228% (+228%)   | 1/2, 137% (+137%) |
| Shoes (1)         | before | 1/1, 10% (+10%)   | 0/1, 40% (+40%)     | 0/1, 40% (+40%)   |
|                   | after  | 1/1, 18% (-18%)   | 0/1, 21% (-21%)     | 0/1, 21% (-21%)   |

- Every group's call range held the sale as often or more, at a lower or equal error. The own
  sales' quartiles are unchanged (44% inside, 44% error): nothing scales them.
- At $8 worth listing the call made 10 Buys (9 held) against 11 (9 held), and 2 Skips, both
  held, against none.
- **Scaling every AI estimate** instead of only a named brand's: the AI estimate 37/64, 35%
  error, but the call's range back to 32/64, since the unnamed items' estimates, which rest
  calls more often, were not high to begin with. **The web's asks scaled once**: 64% error.
- **The brand snap changed no item here, and is kept.** Each near miss of a brand name on this
  set (one on these reads, one on an earlier one) is the only sale of its brand, so with the
  item left out there is nothing to snap to: leave-one-out cannot show its benefit, which comes
  once the household has sold a brand before. It is kept because it is tightly bounded (one own
  brand within 2 edits, keys of 5 letters or more) and snapped none of 192 reads (three runs) to
  a wrong brand.
- **With two photos** (the shot and its closer look, reads only, $0.028): the AI estimate went
  from 29/64 inside, 50% error (+37%) to 39/64, 35% (+12%), and the call's range from 29/64, 48%
  (+27%) to 34/64, 41% (+15%), better or equal in every group. No brand snapped there either.
- The split by a named brand was found on this set; re-check it on the next one.

### Web research: sold prices instead of asks, 2026-11-02 (not shipped)

Today's lookup finds the retail price and what listings ask, and the asks run about double what
items sell for. A lookup that searched for the item's **sold** listings instead (eBay sold,
Poshmark, Mercari, Grailed, and price guides; each comparable with its price, sold date,
condition, and page; asks set aside once two sales were found; an expected price weighted to
recent sales; the retail price kept apart and never a cap) was measured with `--research` on 30
of the household's sales with a branded read (the same 2-photo reads replayed for every run;
`claude-haiku-5-5`, at most 3 searches, an item's own sale left out of its comparables), before
the calibration above, so every range is unscaled:

|                                       | Today (asks) | Sold, asks from the listings | Sold, else typical asks |
| ------------------------------------- | ------------ | ---------------------------- | ----------------------- |
| Cost per lookup / p50                 | $0.025 / 9 s | $0.032 / 13 s                | $0.035 / 16 s           |
| Retail price found                    | 20 of 30     | 19                           | 22                      |
| Two or more sales found               | -            | 6 of 30                      | 7 of 30                 |
| Sale inside the range, all            | 8/29 (28%)   | 4/28 (14%)                   | 7/29 (24%)              |
| Median error (bias), all              | 100% (+100%) | 144% (+144%)                 | 92% (+92%)              |
| Bottoms: inside, median error         | 3/11, 87%    | 3/12, 140%                   | 5/12, 86%               |
| Tops: inside, median error            | 4/14, 65%    | 1/12, 138%                   | 2/13, 80%               |
| Where sales were found: inside, error | -            | 4/6, 31%                     | 2/7, 65%                |

What it found, and why it was not shipped:

- **Sold listings are found for few of these items**: two or more for about one in five (one
  sale for about half). These are mall brands at a $10 to $15 price point, and the searches
  mostly return listings still for sale.
- **Where sales were found they beat the asks once (4 of 6 inside, 31% error) and not the next
  time (2 of 7, 65%)**: the same items' sales differed run to run, so on 30 items it is noise.
- **Overall it did not beat today** on both measures (24% inside against 28%, at 40% more cost
  and 7 s more), so by the rule it ships only if it does, the lookup stays as it is.
- **Every range ran above what this household sells for**, sold listings included (bias equal
  to the error): the web's market for these brands, eBay's sold listings among them, pays more
  than this seller's Depop buyers. That gap is per seller, which is what calibrating a range by
  the seller's own sale-to-ask ratio addresses, not a better web search.

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
  the verdict stamped on it): what the item is at once, with a quiet "Checking prices: the web,
  Depop" line until the prices are in ([Prices after the facts](#prices-after-the-facts)), then the
  verdict (**Grab**, **Maybe**, **Leave**) with its why, the three prices, and the reality check
  ([The card](#the-card)); any flag, **Shoot the tag** and **Search Depop** (the marketplace's own
  search, opened in the browser for the seller to look; Listora never loads it) on a small line,
  and the seller's two answers at the bottom, big and side by side: **Put back** and **Keep**. No
  cost, margin, or profit. The pass action is **Put back**, what the seller does with the item, so
  it is never confused with the **Leave** verdict stamped on the card. If the prices never come
  (no connection), the line says "Couldn't get the prices" with **Retry**.
- **Haptics**, so the seller can keep their eyes on the bin, felt when the verdict lands on the
  card in view: two short taps for Grab, one long buzz for Leave, none for Maybe
  (`Haptics.doubleTap`, `Haptics.longBuzz`).
- **Keep** and **Put back** each close the card at once, back to the live camera for the next
  shot, and a brief line where the card was says what happened: "Keeping item 3" while the draft
  is saved, then "Kept · 3 in this run", or "Put back · 3 kept this run" (2 s; a Keep that
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
  close-up of the tag. The card steps aside while the tag is framed, so the camera is clear, with
  "Shoot the tag up close" and **Cancel** over it; the shot brings the same card back, read again
  with both images (`replacesScanId`), its button now **Retake the tag**. Cancel brings the card
  back unchanged.
- **Hold the mic** to add a note ("medium, small stain"), turned into text on the iPhone. Said
  before a shot, it rides along with that shot's read; said after, the item is read again once
  with it (about $0.0004).
- **Done** closes the camera and keeps the run going (Add Item shows "This run: 12 scanned, 3
  kept" and **Keep scanning**). **Finish** offers **Check out** (below) or **End without checking
  out**; either way the items not kept are skipped. Add Item's **End run** is the second.
- **Failures**: a read that fails says why ("Couldn't read this one. Try again.", "Can't reach
  Listora. Check your connection.") with **Retry**; nothing is shown as read until it was.

The run and its scans are kept on the iPhone (the queue, below), so a relaunch goes on with the
same run. The shots' photos wait in the drafts folder's `ScanRuns/` until they are kept or the
run ends; a folder no kept run names is left over and goes at launch. With no signal, see
[Offline at the bins](#offline-at-the-bins-m5).

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
  to 2,000; recorded as the trip's mileage expense, [expenses.md](expenses.md)), and "Other trip
  spend (optional)" with what it was for (parking, an entry fee), an expense of the trip's day. A Keep still being saved on the iPhone holds the button
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
and item are worth it. The scan does the same, and its prices wait for it
([Prices after the facts](#prices-after-the-facts)).

- **When.** The server looks every read with a brand up the moment the read lands; the app asks
  for the prices (`researchScan`) at once, for every card, and the answer comes when they are
  in. Each scan is looked up once (again only after a failure, when asked). A read without a
  brand asks nothing. The two-second wait on screen that used to save lookups is gone: correctness
  first, and a lookup is about $0.02 (the cost per 1,000 scans is under "Speed").
- **What.** One standard-tier call (Haiku) with the Claude API's web search, at most two
  searches (`researchScanItem` in `@listora/analysis`, purpose `thrift_scan_research`), for the
  item's **original retail price** on the brand's or a retailer's site or another reputable
  source, and **what such items resell for** on the resale marketplaces themselves, with how
  well the brand resells. Beside it, the brand's pulse on the wider web ("Brand pulse", below).
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

### Brand pulse

Asking a chatbot that searches "is this brand worth picking up?" checks more than the resale
apps: fashion and trend coverage, resale market reports, collectors' and resellers' forums, and
the brand's own news. The brand pulse does the same, per brand.

- **What.** One standard-tier call (Haiku) with one search (`researchBrandPulse` in
  `@listora/analysis`, purpose `thrift_scan_brand_pulse`), asking only the brand, for a verdict
  of **in demand**, **steady**, or **slow** (or unknown, when the pages say too little), a
  one-line reason, which lines, eras, or pieces ask more, and the pages it came from. Only pages
  the search really returned count (`verifiedPulse`): with none, or with a reason that calls
  anything sold, it is unknown; a premium that calls anything sold, names a price, or says
  "None" is dropped alone. Unlike a resale range, any reputable page counts (a fashion site, a
  forum, a resale report), not only the marketplaces.
- **When.** With the web research (`POST /v1/scans/{scanId}/research`), beside the item's own
  lookup rather than after it, so it adds no wait, and never on the first read. A pulse that
  fails never fails the research: the card shows none, and the next scan of the brand asks
  again.
- **Kept a week per brand.** By the brand alone (`brandResearchKey`), per account, for 7 days
  (`scan_research`, kind `brand_pulse`), like the brand's other facts, including an unknown one,
  so a brand costs one search a week however often it is scanned. About $0.012 a brand.
- **On the card.** Its own line under the web info, apart from the prices: "Brand pulse: in
  demand · Y2K logo pieces are collected and sell within days, per resale guides. Asks more:
  Y2K logo pieces; pre-1988 vintage. (shedd.app, truefacet.com)" (`brandPulseSignal`, signal
  `brand_pulse`, resting on web info). The server sends it as one of the call's signals, so the
  apps already installed show it with no new build; it fits the signal's 200 characters by
  dropping the last sites, then what asks more.
- **Not in the call.** It is information only: it never moves Buy, Your call, or Skip. The
  backtest below found no way it would make the calls hold more often.

**Measured 2026-11-02** on the backtest's 64 sold items, with the reads of the two stored runs
(`anthropic-2img-2026-11-02.json`, `anthropic-1img.json`) replayed through the production call,
and each of the 30 brands' pulses asked live once ($0.36 for all 30). A call "held" when a Buy's
item paid out at least the worth-listing amount ($8) and a Skip's did not.

| Variant on the 2-image reads                          | Buys held | Skips held | Held |
| ----------------------------------------------------- | --------- | ---------- | ---- |
| The call as it is                                     | 9 of 11   | 0 of 0     | 82%  |
| Slow demotes a Buy to Your call                       | 9 of 11   | 0 of 0     | 82%  |
| In demand makes a Your call a Buy (best payout >= $8) | 25 of 36  | 0 of 0     | 69%  |
| In demand makes a Your call a Buy (low payout >= $6)  | 22 of 32  | 0 of 0     | 69%  |
| Slow makes a Your call a Skip (low payout under $8)   | 9 of 11   | 1 of 3     | 71%  |

The 1-image reads came out the same way (91% as it is; 71% to 79% with any pulse rule). The
verdicts do not tell the items apart: of the items whose brand read in demand, 25 of 36 paid out
$8 or more, against 6 of 6 steady and 4 of 5 slow. The household sells mall brands that the web
calls popular whatever they go for, so the pulse says what the web thinks of the brand, not what
this item will pay. A verdict can also change between two asks of the same brand (Nike read in
demand, then steady, a few minutes apart). The measurement script is not in the repository: it
replayed the stored reads through `runScanBacktest` on a reader of its own, as the backtest's
`--replay` now does; a pulse variant on it is a follow-up.

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
- **Unsold like it.** The household's items in inventory, not sold (ready or listed), of the
  same brand and category (of the brand alone when the read has no category): "You have 2 like
  it unsold" (`unsoldLikeIt`, signal `unsold`). A warning that the seller may already have
  enough of it; it never moves the call.

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
6 s to 12 s; a brand not asked about that week adds its pulse, about $0.012 (one search), at the
same time. One search instead of two found the retail price for 4 of 10 items instead of 9, so it
stays at two. Since the prices wait for it, every read with a brand is now looked up, not only a
card left on screen for two seconds.

**Measured 2026-11-02, shutter to price.** The live path as above (the local API with the real
read, web research, and brand pulse, `claude-haiku-5-5`; 30 scans in a row, 6 invented tag and
label shots and 24 of the household's listing photos, on a new account so nothing was cached),
timed at the client from the read's request to the answer with the prices. Comparisons were off
(no phone answers them on the Mac); on the phone they are read beside the research, in about 4 s.
The Mac was busy (load average 26 to 63) the whole time.

|                                       | p50   | p95    |
| ------------------------------------- | ----- | ------ |
| The card (what the item is), all 30   | 1.7 s | 2.2 s  |
| The price, the 24 with a brand        | 9.4 s | 13.5 s |
| The price, all 30 (6 without a brand) | 9.1 s | 13.5 s |

The slowest price came at 14.9 s, under the 15 s wait; one lookup failed and its prices showed
without the web ("Couldn't check the web"). The 6 reads without a brand were priced with the card.

**What it costs.** The 30 scans cost $0.78: the reads $0.009, 25 lookups $0.567 (one failed and
was asked again), 18 brand pulses $0.206. So every 1,000 scans now pay about $23 of research per
1,000 with a brand, plus $11 per 1,000 brands first seen that week: on this mix (80% with a brand,
18 brands in 30 scans) about $26 per 1,000 scans, against $0.29 for the reads alone. That is the
most added (when no card used to stay two seconds); a repeat of the same exact model within 30
days, or of a brand within the week, costs nothing more.

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
  AI's read (`read`), the web research (`research`, `research_ms`, `failed` when the lookup
  failed) and when it was claimed (`research_started_at`, migration
  `20261102204533_scan_research_started`), the call, its confidence and basis, the call as the app showed it with the
  own-sales lines (`call_detail`: counts and quartiles of the household's own sales only), the
  seller's decision (`undecided`, `kept`, `skipped`, `replaced`), the kept item, the model, the
  AI attempts and their cost, and `read_ms`.
- `scan_research`: the web's facts per account, an item's (`kind` `item`, by its exact model),
  a brand's (`brand`), or the brand's pulse (`brand_pulse`, migration
  `20261102172558_scan_research_brand_pulse`), with the model and what the research cost.
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
- The brand pulse: `scans.int.test.ts` (asked beside the item and shown as its own signal that
  never moves the call; kept a week by the brand, so another item of it costs no search; an
  unknown pulse shown as nothing and kept; a failed one never failing the research and asked
  again), `brand-pulse.test.ts` (pages verified, sales words and prices kept out, cut to the
  card), and `call.test.ts` (the signal's text and fit; no verdict changes the call).
- Prices after the facts: `pricing.int.test.ts` (the web looked up as the read lands, before the
  app asks, and only once for two asks at once; every price held until each comparison is in, a
  comparison answered meanwhile shown without its prices; the prices from what came back once
  the wait ends, naming each source, and the same call as with no comparisons on, never a higher
  confidence; a late answer still taken in; a failed lookup named and tried again when asked; a
  read without a brand priced at once), `pricing.test.ts` (`scanPricing`'s waits, its cap from
  the read and from the lookup's start, the missing sources' words; the held answer with no
  price; the reality check's lines), `scans.int.test.ts` (the held read, then its prices with the
  web missing; the Grab and Leave words and their why; the reality check of the household's own
  sales), `call.test.ts` (`callWhy`), and `labels.test.ts` (the reality check's "sold" only on own
  sales and sold listings). iPhone: `ScanPricesTests.swift` (the held card's words, the verdict
  with "Your call" and the reality check, the prices asked for at once and taken in, Retry, Put
  back while waiting), `ScanSpeedTests.swift` (every read's prices asked for at once, a skipped
  one too, once each), and `ThriftScanUITests` (the card's Maybe, its why, the reality check, and
  the three prices on the local stack).
- The read's speed settings: `scan.test.ts` (thinking off and the enums held on the request; an
  empty item name read as "Unidentified item"), and in `@listora/ai`, `anthropic-provider.test.ts`
  (thinking off only when asked; `outputJsonSchema` the SDK helper's schema without
  `strictEnums` and with every enum kept with it) and `client.test.ts`.
- The calibration and the brand snap: `calibration.test.ts` (the default, the draw toward it,
  the median, each ratio held to its range, the scaling), `call.test.ts` (the AI estimate of a
  named brand scaled once and shown scaled, the web's asks twice and said to be asks, a Buy on
  raw asks turned into Your call, own sales never moved, the retail cap after the scaling, the
  signal's wording), `brand.test.ts` (`snapBrand`: a near miss in the spelling used most; a
  match, a short name, a far one, or one near two brands left alone), `scans.int.test.ts` (the
  ratio from the sold listing's price, else the item's, eBay's sales left out, and the scaled
  AI estimate and web range on the card; "Wrenfeld" stored and shown as Wrenfield,
  "Wrenford" left alone), and the backtest's `backtest.test.ts` and `command.test.ts` (the
  ratio and the snap from the other items only, the price table, `--research`, and `--replay`
  answering the same report again).
- `@listora/sourcing` (`scanOwnHistory`, the signals, `salesTrend`, the research keys),
  `@listora/pricing` (`scanResearchLinks`, `scanLabelViolations`), the retention rules, and the
  app feature gate.
- The offline call: `offline-call.test.ts` runs the golden cases, checks that the server's
  `scanCall` makes the same call on the same sales, and keeps the iPhone's copy of the cases
  equal; `unsold.test.ts`; the kit's `forCall` and thresholds (`kit.test.ts`,
  `sourcing.int.test.ts`); the online read's unsold warning (`scans.int.test.ts`).
- iPhone: `OfflineScanCallTests` (Core: every golden case and brand key, as the server's);
  `ScanOfflineTests.swift` (the instant read with no signal and no request; the waiting reads
  newest first once there is signal, read late; a read cut off by the network tried again under
  the same key; a scan kept with no signal saved once read, or as an ordinary draft when it can
  never be read, or whose photo the app closed before preparing; a run ended with kept scans
  waiting finishing after they are saved; a note with
  no signal; the duplicate warning; the run and its scans across a relaunch, and an ended run
  finished after one; the kit kept in its file, an unknown format never read).
- Checkout: `sourcing-runs.int.test.ts` (the gate; the kept items into one haul with their
  shares, the place, the date, and the miles, a Keep the app had not sent kept there and its later
  `keepScan` answering it, the open scans skipped; the summary before and after, its sums and
  labels, and the profit following a fixed haul; the count grown to the kept items; nothing kept
  with a range; a replayed checkout and a second one, an ended run, another account's run, a scan
  of another run or replaced, and a negative total, changing nothing); `run.test.ts` in
  `@listora/sourcing` (the sums, the left-out scans, the wording); iPhone `ScanCheckoutTests.swift`
  (the run's place, the checkout's kept scans, the iPhone's date, the miles, the run ended after,
  a failure retried as the same checkout, the summary's words); `ThriftScanUITests` starts a run
  at a place and checks it out on the local stack, and shoots a tag: the card out of the way while
  it is framed, back unchanged on Cancel and read with the tag after the shot.
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
  (`FakeAI/default.json`), and with no signal (`LISTORA_SCAN_NO_SIGNAL=1`, debug builds): a
  shot waits unread, Keep marks it, and the next launch with signal reads it and saves its
  draft. `ThriftScanCardFitUITests`, against the stub's invented scan with every part filled
  (`StubAPIServer+Scans.swift`) at a large text size, checks the card from both a server with
  the reality check and one without it (the call's signals). The card stays on the screen and
  opens at its top, its last line scrolls into view inside it, and Keep, Put back, the shutter,
  and Done stay reachable.

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
- iPhone: `ScanComparisonRowTests.swift` (eBay's row under its sold label).

**The phone needs a new app build** for eBay's comparisons. Live test: the captain on his phone at
a store, logged out, eBay only, in Test mode (the gate stays off for sellers). It decides whether
eBay lets a logged-out iPhone read its search at all: the Mac's recorder met eBay's bot check, and
a check on the phone pauses eBay's comparisons for the day ("eBay prices paused today").

**Fixed with it.** A read in which nothing matched used to send `level: null`, which the API
refused, so the card said "Couldn't check Depop"; the phone now leaves the level out, and the row
says "Not enough similar listings".

## Mercari (M3)

Mercari's row is the card's second market sold prices: what close matches sold for on Mercari,
and how fast its latest sales came. Its comparisons are behind their own gate (`market_comps` on
Mercari, [verified-features.md](verified-features.md)), hidden from sellers until the captain's
live test.

### What Mercari shows a visitor

Listora's model of the page (no recording yet, "Tests" below): the search page
(`/search/?keyword=<words>`) has Mercari's own status filter, "Sold" (`itemStatuses=2`) and "On
sale" (`itemStatuses=1`), and its "Newest" sort (`sortBy=2`). Each result is Mercari's product
card (`ItemContainer`), the same card its listing pages show under "More from this seller", read
on a real page on 2026-10-27: the item's brand (`data-brand`), size (`data-size`), whether it is
on sale (`data-is-on-sale`), name (`ItemName`), and price (`ProductThumbItemPrice`, the price
before a drop struck through after it). **The cards show no dates.** Mercari's server-drawn pages
keep the data they were drawn from in `window.__NEXT_DATA__` (its Apollo cache,
`props.pageProps.serverState`: an item's `updated` and `lastSoldAt` in seconds, read on its
listing page), so where the search page carries its results there, a sold card's sale day and the
search's own count come from it; where it does not (its results drawn in the browser), the read
has sold prices without dates and no count.

### The read

1. **The query.** As for eBay (`comparisonQuery`): the brand and an item type are needed; the
   words are the brand, the model or line, and the type. Mercari's cards name no category, so a
   match is held to the name's words (`productTypes` empty).
2. **The phone reads it** (`listoraPhone.compare`, `comps/mercari.ts`): the sold page (newest
   first), then the for-sale page, each one page load of the URL Mercari's own filter and sort
   make, through the same session rules as every automated read
   (`mercari/pages/search-page.ts`). It waits for the cards, which Mercari's scripts may draw
   after the document. Of each card only the brand, size, on-sale flag, name, and price are read,
   and its item id only to join it to the page's data; the id never leaves the phone.
3. **What is never counted.** Cards in Mercari's carousels (`FeedContainer`, other items than
   the search's), lots and bundles, cards of the other kind (an item on sale among the sold
   results), and cards without a name or a price Listora can read.
4. **Matching** (`marketStats`): the card's brand (`data-brand`, by `brandKey`) or, on a card
   without one, the name's words; and the type in the name; the levels add the model in the name
   and the card's size (`S (4-6)` is `S` and `4-6`). Sold listings choose the level, outliers are
   left out, as for Depop and eBay.
5. **Only numbers leave the phone**: the level, the sold and asking quartiles (the sold window
   only where the sales are dated: the API takes no `null` for it), the counts read, the
   for-sale search's count, and the recent pace (`soldTotal`, below).

### On the card

- **The row**: "Mercari: sold $20-$28, 7 like it in the last 21 days" under "Sold listings on
  Mercari" (`marketSoldLabel`), from 3 sold close matches; undated, "Mercari: sold $20-$28, 7 like
  it". Without sold ones, asking prices as Depop's.
- **The trend read** (`latestSoldPace`): Mercari's sold search reaches back years and counts no
  window, so its pace is how many of the latest sold results read (`stats.read.sold`, newest
  first) sold in the last 30 days (`soldTotal`, `soldLately` on the phone;
  `COMPARISON_SOLD_WINDOW_DAYS.mercari`). "Sells fast on Mercari" from two in three
  (`LATEST_SOLD_FAST`), "Slow on Mercari" at a quarter or less (`LATEST_SOLD_SLOW`), from 5 sold
  read (`MIN_LATEST_SOLD`), with what it rests on ("Sold listings on Mercari: 24 of the latest 30
  sold in the last 30 days"). Without dates it says so ("Mercari gave no dates for its latest
  sales") and moves nothing. Starting thresholds, to tune in the live test.
- **In the call**: as eBay's, Mercari's sold close matches are the range when the household's
  own sales are too few (`market_sold`); a slow Mercari keeps a call from high confidence; a fast
  one never raises it.

### Account risk

As for Depop and eBay ("Account risk" above): no account in the read (the app's own
non-persistent web view, never the seller's), phone only, Mercari's own origins only
(`www.mercari.com`, `mercari.com`), stop at the first check (Cloudflare's "Just a moment..." page
and Turnstile, a 403, Mercari's sign-in page), the 24-hour cache, the pauses, images and media
blocked, and the warm-up (Mercari's home page). **Budgets**: 20 reads an hour and 100 a day per
account (each read loads two pages), fewer than eBay's since Mercari showed human checks to
automated sessions before (2026-10-27); once 12 of the hour's are used, the rest go only to items
the AI prices at $25 or more at the high end (`COMPARISON_LIMITS.mercari.saveForPricier`).

### Tests

- `@listora/sourcing` `pace.test.ts` (`latestSoldPace`: fast, steady, slow, no dates, too few,
  never more lately than read, no "sold" without numbers).
- `packages/automation`: `mercari/pages/search-page.test.ts` (the URLs, the cards, what is never
  counted, prices, sizes, the page's data), `comps/mercari.int.test.ts` (the lane on the phone's
  page backend against a stand-in search: the match and count, the carousel, lots and cards of
  the other kind, the sale days, the count and the pace from the page's data, a page without its
  data, no results, the warm-up, Cloudflare's check, a sign-in page, an unknown page). **No
  recorded real page yet**: recording Mercari's public search logged out (2026-11-02, from a
  headless Chrome with a fresh profile, through `market-pace.sh mercari`) met a bot check on its
  first page load, and it was not tried again. The search page's selectors and its data are
  Listora's model until the captain's live test reads the real one; a page that differs fails
  the read ("Couldn't check Mercari"), a page without its data reads prices without dates, and
  neither counts anything wrong.
- `apps/api/src/scans/comparisons.int.test.ts`: Mercari's read handed out, the call on its sold
  listings with the pace and the cache, a slow Mercari, an undated read, the hour saved for
  pricier items.
- iPhone: `ScanComparisonRowTests.swift` (Mercari's row under its sold label, with its pace).

**The phone needs a new app build** for Mercari's comparisons (the runtime bundle and the lane's
origins). Live test: the captain on his phone at a store, logged out, Mercari only, in Test mode
(the gate stays off for sellers). It decides whether Mercari lets a logged-out iPhone read its
search at all (the Mac's recorder met Mercari's bot check, and a check on the phone pauses
Mercari's comparisons for the day), and whether the search page carries its results' dates.

**Fixed with it.**

- An eBay row of asking prices only, where eBay gave no count of its sold search, said "eBay gave
  no count of sold listings", which the label guard refuses on a row without sold listings, so
  the whole scan answer failed; it now says "eBay gave no count of its sales".
- A read whose sold listings had no dates sent `windowDays: null`, which the API refuses; the
  phone now leaves the window out.

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

## Offline at the bins (M5)

Thrift stores often have no signal at the bins. The scan works without it: each shot gets an
instant read from the household's own sales, and its full read waits on the iPhone until there
is signal.

### The instant read

- **The kit.** The iPhone keeps the sourcing kit (below) in a file (`SourcingKitCache`), fetched
  when a run starts and whenever signal returns during one, at most every 15 minutes (with no
  run, the app asks for nothing); a failed fetch keeps
  the one it has, and a kit of a format the app does not read is never used.
- **The brand off the tag.** The tag text the phone reads (Vision, as for every shot) is looked
  up in the kit's brand groups: each line in reading order, each word of it in order, the first
  whose `brandKey` (of that word and the next three) is one of the household's brands
  (`tagBrandBucket`). A category or size group is never used: the tag cannot give a category.
- **The call** (`offlineScanCall`; the iPhone's copy is `OfflineScanCall` in Core). The printed
  brand counts as a sure read, but with no category the household's sales match on the brand
  alone, which the server's call never makes high confidence. At least 3 of the brand's sales
  (not eBay's) give the range from their low to high quartile at medium confidence, and the
  call is the server's rule (`decideCall`) on the kit's payouts, with no flags, since nothing saw
  the item. Fewer give Your call at low confidence, "Not enough of your Levi's sales to go on".
  A tag naming none of the household's brands has no instant read.
- **The card** says "From your sales only" over the call and its confidence, the brand, the
  range with what it rests on ("Your 5 Lululemon sales"), the payout after the main
  marketplace's fees, and "You have 2 Lululemon unsold" when the kit counts some; "No signal:
  read when you have it" below. The haptics are the online card's. With signal, the instant
  read shows as one line under "Reading item 3" until the full card lands.
- **Kept equal to the server's.** The golden cases (`offline-call.cases.ts`: one invented kit,
  tag texts, and the read each must give, by hand) run in both test suites: `offline-call.test.ts`
  writes them to `apps/ios/Packages/Core/Tests/CoreTests/Fixtures/offline-scan-call.json`
  (`UPDATE_IOS_OFFLINE_CALL=1`) and fails when the file differs, and `OfflineScanCallTests` runs
  the app's copy of the rule and of `brandKey` over the same file. The server's test also checks
  that `scanCall` makes the same call on the same sales.

### The queue

- **What waits.** Every run and its scans are kept in the drafts database (`scanRun`,
  `scanEntry`, migration v5), with each shot's small JPEG, tag close-up, and upload-sized photos
  in the run's folder, so nothing waiting is lost when the app closes. A read cut off with the
  app is due again at the next launch.
- **When a read waits.** With no network path (`NWPathMonitor`) the read is not tried; one that
  fails for no signal (no connection, or its answer still on its way) waits too, rather than
  failing. Any other failure shows with Retry, as with signal.
- **When it runs.** Whenever the path comes back, and every 30 seconds while scans wait and the
  path is up (a store's signal can drop requests on an open path), whichever tab is open: the
  waiting reads run one at a time, newest first (the item in hand matters most), until one still
  finds no signal. Each read keeps its `Idempotency-Key` until it lands, so a read retried after
  a lost answer is replayed by the server, never read and charged twice; a note or tag shot
  changes the request, so it gets a new key. The server's limits (300 scans a day, the AI
  budget) apply to each read as with signal.
- **Read late.** A card read from the queue says "Read when you had signal", plays no haptic,
  and never counts toward the card's seconds from the shutter. Only a kept one, or the card in
  view, is looked up on the web at once; the others when the tray opens them.
- **Notes and the tag with no signal.** A note said over a waiting card rides along with its
  read; a tag close-up adds its text to the instant read at once and to the read due.

### Keeping and ending with no signal

- **Keep** on a waiting card marks it kept at once and goes back to the camera like any Keep
  (the line says "Kept · saved once it's read"; the card from the tray, "Kept: saved once it's
  read"): its draft
  needs the scan, so it is saved the moment the item is read. A kept scan that can never be read
  (the server refuses it) is saved as an ordinary draft with its photos, which the full analysis
  then reads like any draft's; one whose upload-sized photo the app closed before preparing gets
  one made from its shot instead. A kept item is never lost.
- **End run** skips the items not kept, as with signal. Kept scans still waiting stay queued:
  the run finishes (ended on the server, its files and records removed) once each is read and
  saved, after a relaunch too. The confirmation says how many are waiting; Add Item's row and
  the camera say "4 waiting for signal".
- **Checkout** waits until every kept scan is read and saved: each kept item's draft, and so its
  place in the haul, comes with its read. Checking out needs signal anyway.

### Duplicates

- **In the run.** Each shot's Vision feature print (the batch camera's reader) is compared with
  the run's earlier shots; at the batch camera's "same item" distance or closer
  (`BatchGrouper.sameItemBelow`) the card says "Looks like item 3, already scanned", with or
  without signal. The simulator computes no feature prints, so there it never shows.
- **In the household's inventory.** With signal, the read's `unsold` signal ("You have 2 like it
  unsold"); without it, the kit's count of the brand's unsold items ("You have 2 Lululemon
  unsold"). Neither moves the call.

**The phone needs a new app build** for the offline scan.

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
the store with no signal ([Offline at the bins](#offline-at-the-bins-m5)).

- **Format** 2: the call's thresholds (`call`: worth listing and the fewest sales) and each
  group's sales for the call (`forCall`, below) were added for the offline call. A client that
  does not know a kit's `version` ignores the kit. `insights` ("Sourcing insights" below) was
  added within format 2: a client that does not read it still reads the rest.
- **Groups** (`buildSourcingKit`): every brand (by `brandKey`), then each of its categories, then
  each size in a category (`sizeBucket`: without case or spaces, letter sizes spelled short, so
  "Medium" is `m`). Each group with a sale is listed, so a group missing from the kit has none.
  The brand is spelled as most of its sales spell it.
- **Per group:** the sales per marketplace (count, the quartiles, the median payout after that
  marketplace's fees from its current fee table, an estimate, with the table's version), whether
  they are display only (eBay), and how many of the account's items of the group sit unsold
  (ready or listed).
- **For the call** (`forCall`): the group's sales that may model a price (not eBay's), their low
  and high quartile, the marketplace with most of them (Depop on a tie), and what each end pays
  out after its fees, calibrated by the account's actual fees as the scan's call is
  (`payoutFees`). Absent when the group has none.
- **Size:** at most 2,000 groups (`MAX_KIT_BUCKETS`); past that, size groups go first, then
  category groups, the ones with the fewest sales first.

### Tests

- `packages/sourcing`: `ownHistoryByMarketplace`, `sizeBucket`, and the kit's groups, order, eBay
  flag, brand spelling, and limit, on invented sales.
- `apps/api/src/sourcing/sourcing.int.test.ts`: the price screen's own history per marketplace
  (canceled, old, other-category, and other accounts' sales left out; the item's own sale left
  out; two sales needed; no brand, no history), the gate for a seller and in Test mode, and the
  kit, empty without sales, gated the same way, with eBay display only.

## Sourcing insights: "What sells for you"

The household's own sales and stock read as advice for the bins: the brand and item type pairs
that sell best and worst, by sell-through and days to sell, and a short "Look for" list. It is
`insights` in the sourcing kit, so the iPhone keeps it with the kit and shows it with no signal.
Nothing new is read: it is the kit's sales ("The sales that count" above) and the account's
items in stock.

- **Brand and item type, never a brand alone.** Each line is a brand (`brandKey`) with a
  category: Lululemon's leggings and its jackets sell differently, and a brand-wide figure would
  hide both. A sale or an item without a brand or a category is left out.
- **Sell-through**: the pair's items sold in the kit's window over those plus its items in stock
  (ready or listed) that were added at least 30 days ago, so a new item does not count against
  its pair before it had time to sell. A pair is judged only from 3 such items.
- **Days to sell**: from the item's first listing through Listora (a listing whose create
  operation succeeded) to the sale, the median over the pair's sales that have one, from 2 of
  them. An imported listing's date is when Listora read it, so its days would understate; such a
  sale counts as sold but has no day count. The screen says how many sales the days rest on.
- **Payout**: the median of what the pair's sales paid out after each marketplace's estimated
  fees, calibrated as the scan's call works them (`payoutFees`); never eBay's, which are display
  only. An estimate.
- **Best** (`best`): half or more sold, and a median under 90 days where known; the highest
  sell-through first, then the fastest, then the most sold. **Worst** (`worst`): the rest,
  under half sold or 90 days or more to sell, including a pair that never sold; the lowest
  sell-through first, then the slowest, then the most left unsold. Five each.
- **Look for** (`lookFor`): the best whose median payout is at least the call's worth listing
  (`call.worthListing`, $8 by default), best first, five at most.
- **On the iPhone** (Hang Tag): "What sells for you" is reachable from Scan mode (a row above the
  run, and in the guide before the first scan) and from the start of a run, whose sheet shows the
  top three to look for on a tag. The screen puts the "Look for" list on a tag stamped "Look
  for", then "Sells best" and "Sells slowest", ruled: each line names the pair ("Lululemon
  leggings"), how many of how many sold, the median days, the payout, and how many are in stock
  now, so the seller does not buy more of what waits. Without enough sales it says so; with no
  kit and no signal it says to open it once with signal. Opening it fetches a newer kit when
  there is signal.

**A new app build is needed** for the screen; the server's `insights` needs none of the app.

### Tests

- `packages/sourcing/src/insights.test.ts`: pairs never a brand alone, sell-through, the median
  days and payout, the 3-item and 2-dated-sale minimums, unsold items given time, a pair that
  never sold, a slow seller among the worst, the order of both lists, Look for's payout floor
  and length, and eBay left out of the payout.
- `apps/api/src/sourcing/sourcing.int.test.ts`: days from Listora's listings only (an imported
  listing's date ignored), sell-through with stock added 60 days ago, the worst pair that never
  sold, and another account's kit seeing none of it.
- iPhone: `SourcingInsightsTests` (the lines' words, the basis, Scan mode's row, the kit fetched
  before a run with signal only and kept with its insights), `OfflineScanCallTests` (the golden
  kit's insights decoded), `VocabularyNameTests` (`itemType`), and
  `SourcingInsightsUITests` (the screen from Scan mode and from the start of a run).

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
- **Days to sell** show only in "What sells for you", and only from sales Listora listed: an
  imported listing's `listed_at` is when Listora read it, not when the seller listed it. Reading
  the marketplace's own listing date at import would give the rest a day count.
- **Calibrate by the scans themselves** once an account has enough kept and sold scans: the
  ratio of what they sold for to the AI estimate and the web's asks on the same items. On the
  backtest that ratio worked about as well as the sale-to-asking one (34% and 39% error), and it
  measures each source directly.
- **The offline call** (`OfflineScanCall` on the iPhone) has no AI estimate and no brand snap;
  snapping a tag's brand to the kit's brands would help it the same way.
- **Re-run the backtest** as sales accumulate, and on shots taken at a store (M2), before showing
  the call to sellers.
- **M2 live test** (the captain, Test mode, a real store, 30 or more scans): the speed targets
  above on cellular, then `thrift_scan` into `VERIFIED_APP_FEATURES` with its evidence.
- **M3 live test** (the captain, Test mode, the captain's iPhone at a store): Depop's comparison
  row within 4 s of the shutter, the budgets and the pause tuned on evidence, then
  `market_comps` on Depop into `VERIFIED_FEATURES`. The eBay and Mercari readers are built, each
  behind its own gate and live test; Poshmark's follows as its own PR and gate.
- **M4 live test** (the captain's own trip, Test mode): check a run out at the register and
  compare the haul's shares and the summary with the receipt.
- **Mileage** from checkout is also the trip's mileage expense, priced in Reports at the year's
  rate ([expenses.md](expenses.md)).
- **M5 live test** (the captain, Test mode, airplane mode at a store): scans with no signal get
  the instant read, keep and end the run, then turn signal on and see the cards read late and
  the kept ones saved as drafts.
- **Duplicates against the household's own photos.** The offline warning of unsold items rests
  on the kit's brand counts, which count only brands that sold; comparing a shot's feature print
  with the unsold items' photos (the plan's fuller check) needs their prints on the iPhone and
  is not built. No "unsold for N days": an imported listing's date is when Listora read it.
- **Later milestones:** upgrading a run's drafts (M6) is built; its live test is the captain
  listing a run's draft on `tonioreign`.

## Data

The scan's tables are in "Data" under M2 above. The own sales read `sale`, `sale_item`, and
`inventory_item` ([sales.md](sales.md), [items.md](items.md)) and write nothing.
