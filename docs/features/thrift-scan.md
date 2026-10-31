# Thrift scan: the Buy / Your call / Skip call, and the seller's own sales

The thrift scan helps a seller decide at the store, in seconds, whether an item is worth buying
to resell: one shot of the item (and an optional tag close-up), a short AI read, a price range
from the seller's own sales or the AI, and a call of **Buy**, **Your call**, or **Skip** with a
confidence word. Built so far: the rules, the AI read, and a backtest on real sold items (plan
milestone M0); the seller's own sales as real sold data (`own_history`, M1) on the item's
price screen and in the sourcing kit (`GET /v1/sourcing/kit`); the scan itself online
(M2): Add Item's Scan mode, `POST /v1/scans`, Keep into the run, and the run's tray; the scan
with no signal (M5): the instant read and call from the household's own sales, the queue that
reads the waiting scans once there is signal, and duplicate warnings; and upgrading a run's
kept drafts with real photos (M6): "Needs photos", Shoot this run, the full analysis with the
scan's read as a hint, and the run's rapid review. Scan mode is
hidden from sellers until it passes live (`thrift_scan`, [verified-features.md](verified-features.md)):
only the owner's Test mode has it. Nothing in it reads or writes a marketplace.

Code:

- `packages/sourcing` (`@listora/sourcing`): the pure rules, with no I/O. `quartiles`, `brandKey`
  (how two brands compare), `ownHistoryComparisons` (the seller's own sales like the item),
  `scanCall` with `DEFAULT_SCAN_CALL_SETTINGS` and `decideCall` (the rule both calls share),
  `ownHistoryByMarketplace` (the price screen's), `sizeBucket`, `buildSourcingKit`,
  `offlineScanCall` (the call with no signal) with its golden cases (`offline-call.cases.ts`),
  and `unsoldLikeIt`.
- `apps/api/src/sourcing`: the sales that count, the kit's route, and the price screen's own
  history, which `getItemPricing` shows ([pricing.md](pricing.md)). Nothing there calls a
  marketplace or AI: every number comes from the sales Listora already recorded
  ([sales.md](sales.md#sales-history)).
- `packages/analysis/src/scan.ts`: the AI read, `scanItem` (purpose `thrift_scan`, standard tier,
  no item quota), with its own small output schema `thrift_scan` and a cached system prompt.
- `packages/eval/src/scan/`: the backtest, `npm run eval -- scan`.
- `apps/api/src/scans` and `apps/api/src/sourcing-runs`: the scan's read and Keep, and the run
  (below); `scanOwnHistory` in `@listora/sourcing` and `scanResearchLinks` and
  `scanLabelViolations` in `@listora/pricing`.
- iPhone: `AddItemFeature/Scan` (the camera, the card, the tray, the run, the note, the
  measurements, the kept run's section, guided shoot, and review, and with no signal
  `ScanRuns`, the queue `ScanQueueStore`, `SourcingKitCache`, and `ScanConnectivity`);
  `Core/Sourcing` (the kit, `BrandKey`, and `OfflineScanCall`, the app's copy of the offline
  call). A kept scan is an ordinary draft whose server item `keepScan` creates.
- `packages/analysis/src/load-input.ts`: the full analysis of a kept item carries its scan's
  read as a hint (`scanRead`, `scanReadHint`).

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

## The scan at the store (M2)

### On the iPhone

Add Item has a third mode, **Scan**, next to One item and Batch, shown only where `thrift_scan`
is on. **Start scanning** opens the scan camera and starts a run (the server's is made with the
first scan).

- **One shot** of the item in hand. The shutter is at the bottom center; the read starts at
  once and the camera is ready for the next item while it runs.
- **The card** rises over the bottom of the live viewfinder (Hang Tag: a tag lying on its side,
  the call stamped on it): the call (**Buy**, **Your call**, **Skip**) with its confidence word,
  what the item is, the price range the call rests on in the tag's print with what it rests on
  ("Your 3 sales like it", or "AI estimate - not based on sold listings"), the payout after the
  marketplace's fees, the household's own sales per marketplace, the AI estimate under its
  label, any flag, **Keep**, **Tag**, and **Search Depop** (the marketplace's own search, opened
  in the browser for the seller to look; Listora never loads it). No cost, margin, or profit.
- **Haptics**, so the seller can keep their eyes on the bin: two short taps for Buy, one long
  buzz for Skip, none for Your call (`Haptics.doubleTap`, `Haptics.longBuzz`).
- **Keep** saves the item as a draft on this iPhone at once, with the scan's photo (the upload
  size, prepared while the card was read) and the tag close-up if there is one. The upload queue
  creates its server item with `keepScan` and attaches the photos in the background. The camera
  stays open.
- **Skip is no tap**: shooting the next item skips the last one. The **tray** along the bottom
  holds every card of the run; tapping one shows it again, so a skipped item can still be kept
  until the run ends.
- **Tag** (or **Tag?**, when the AI could not read the brand or was unsure): the next shot is a
  close-up of the tag; the item is read again with both images (`replacesScanId`).
- **Hold the mic** to add a note ("medium, small stain"), turned into text on the iPhone. Said
  before a shot, it rides along with that shot's read; said after, the item is read again once
  with it (about $0.0004).
- **Done** closes the camera and keeps the run going (Add Item shows "This run: 12 scanned, 3
  kept" and **Keep scanning**); **End run** ends it: the items not kept are skipped.
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
  phone read (Vision, within 0.4 s, so a slow read never holds the scan up), and the note. The
  server checks each image's JPEG header and size, reads it with `scanItem` (Haiku, the AI
  guards and metering), drops the images, and answers synchronously with the identity, the AI
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

### Web info

Many resellers decide at the bins by asking a chatbot that searches the web whether a brand
and item are worth it. The scan does the same, in the
background, so the card never waits on it.

- **When.** As soon as the read lands, the app calls `POST /v1/scans/{scanId}/research`
  (`researchScan`); the card says "Checking the web for its retail price" and takes in the
  answer when it comes. A read without a brand asks nothing (`no_brand`). A scan already
  researched answers as it is.
- **What.** One standard-tier call (Haiku) with the Claude API's web search, at most two
  searches (`researchScanItem` in `@listora/analysis`, purpose `thrift_scan_research`), for the
  item's **original retail price** on the brand's or a retailer's site or another reputable
  source, and **what such items resell for** on the resale marketplaces themselves, with how
  well the brand resells.
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
  confidence; a rise never raises one. With too few sales it says nothing. Marketplace trends
  arrive with the comparisons (M3) as another `trend.source`.
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
- **The iPhone** times each card from the shutter (`ScanEntry.cardAfter`, logged as "scan card
  after N ms") and the run's active time (`InteractionMeter`, session `scan-<run>`), logged when
  the run ends.
- **The owner** sees them on the scan camera in Test mode, tagged "Testing": "Card 2.1 s · 95%
  3.4 s · active 2.8 s an item". Sellers never see timings.

**Measured 2026-10-31** on the local API with the real read (`claude-haiku-5-5`), 10 scans of
invented 1,024-pixel tag images (about 12 KB each): the server's read took 2.4 s at p50 (2.0 s
to 3.1 s once warm; the first, which writes the prompt cache, 6.2 s), of which all but about
10 ms is the AI call, for about $0.00037 a scan. The answer is about 440 output tokens, which
is what the time is spent on; the backtest's 1.4 s (on listing photos) answered shorter. So the
identification target of 2.5 s holds at the server, with little room for cellular: the live
test measures the card from the shutter on the phone, and if it runs over, the next step is a
shorter answer or streaming the identity first (the plan's "identity fields come first"). The
phone's own part (the 1,024-pixel JPEG and the tag text, capped at 0.4 s) runs before the
request, and the upload-sized photo is prepared while the read runs.

**Measured again 2026-10-31**, after the read gained the model, style number, era, material,
style, and a tag's retail price, 5 scans of invented tag images: the read took 3.4 s to 4.7 s
once warm (p50 3.6 s, about 650 output tokens), now over the 2.5 s target, for about $0.0005 a
scan. The web research that follows it took 6.6 s to 12.6 s uncached (two searches, about
$0.023 each, nearly all of it the $0.01 searches) and 10 ms from the cache. The card shows the
read without waiting for it, so the research adds no time before the call, only after. The
levers for the read, in order: the low-effort thinking that makes up most of its output (a
no-thinking setting for this one call), then streaming the identity first.

### Data

- `sourcing_run`: account, who started it, the place (none yet: M4 asks for it), started and
  ended, and its scan and kept counts, which stay after skipped scans are deleted.
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
  the marketplaces, metered searches), and the provider's web search.
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
  never be read; a run ended with kept scans waiting finishing after they are saved; a note with
  no signal; the duplicate warning; the run and its scans across a relaunch, and an ended run
  finished after one; the kit kept in its file, an unknown format never read);
  `ScanTests.swift` (the card's words and haptics, the measurements, the run: one server
  run, the small JPEG with tag text, implicit skip and Keep from the tray, notes before and after
  a read, the tag close-up, Retry, End run; the upload queue's `keepScan`, a deleted draft's item
  found by keeping again, a skipped scan's draft failing visibly; the research asked for after
  the read and the card taking it in, nothing asked without a brand); `ThriftScanUITests` end
  to end on the local stack with the fake camera and the fake AI's scan and web research
  (`FakeAI/default.json`), and with no signal (`LISTORA_SCAN_NO_SIGNAL=1`, debug builds): a
  shot waits unread, Keep marks it, and the next launch with signal reads it and saves its
  draft.

**The phone needs a new app build** for Scan mode.

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
  boundary is known, so there is no grouping step. **Done** saves the item's photos and moves to
  the next; **Skip item** leaves it for later; closing the camera ends the shoot and keeps the
  items already shot. Background cleanup is in the draft's editor, as for any draft.
- **The scan shot goes** once the real photos are taken (`replaceScanShots`): the new photos come
  first, and the scan's shots are deleted, on the server too by the upload queue, unless the
  seller taps **Keep scan photo**, which keeps them after the new ones.
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
  when a run starts and whenever signal returns, at most every 15 minutes; a failed fetch keeps
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
  and never counts toward the card's seconds from the shutter.
- **Notes and the tag with no signal.** A note said over a waiting card rides along with its
  read; a tag close-up adds its text to the instant read at once and to the read due.

### Keeping and ending with no signal

- **Keep** on a waiting card marks it kept at once ("Kept: saved once it's read"): its draft
  needs the scan, so it is saved the moment the item is read. A kept scan that can never be read
  (the server refuses it) is saved as an ordinary draft with its photos, which the full analysis
  then reads like any draft's: a kept item is never lost.
- **End run** skips the items not kept, as with signal. Kept scans still waiting stay queued:
  the run finishes (ended on the server, its files and records removed) once each is read and
  saved, after a relaunch too. The confirmation says how many are waiting; Add Item's row and
  the camera say "4 waiting for signal".

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
  does not know a kit's `version` ignores the kit.
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
- **Scale the AI estimate** by the seller's own sale-to-estimate ratio once Listora has enough
  of both for an account.
- **Re-run the backtest** as sales accumulate, and on shots taken at a store (M2), before showing
  the call to sellers.
- **M2 live test** (the captain, Test mode, a real store, 30 or more scans): the speed targets
  above on cellular, then `thrift_scan` into `VERIFIED_APP_FEATURES` with its evidence.
- **M5 live test** (the captain, Test mode, airplane mode at a store): scans with no signal get
  the instant read, keep and end the run, then turn signal on and see the cards read late and
  the kept ones saved as drafts.
- **Duplicates against the household's own photos.** The offline warning of unsold items rests
  on the kit's brand counts, which count only brands that sold; comparing a shot's feature print
  with the unsold items' photos (the plan's fuller check) needs their prints on the iPhone and
  is not built. No "unsold for N days": an imported listing's date is when Listora read it.
- **Later milestones:** comparisons on the phone (M3, gated on the captain's call), the run's
  place and checkout into a haul (M4). Upgrading a run's drafts (M6) is built; its live test is
  the captain listing a run's draft on `tonioreign`.

## Data

The scan's tables are in "Data" under M2 above. The own sales read `sale`, `sale_item`, and
`inventory_item` ([sales.md](sales.md), [items.md](items.md)) and write nothing.
