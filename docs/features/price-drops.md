# Smart price drops

A listing that goes unsold is cash sitting in a bin. Smart price drops lower its price a little
at a time on the seller's own rules, such as "10% off after 21 days, never below $30", for one
item or for every item of a brand. The days start from the seller's own days to sell. Each drop
is the price change that already passed live on Depop, Poshmark, and Mercari, so it is shown as
done only after the marketplace's read-back confirms it, and a failure shows with Retry. The
seller sees each planned drop at least a day before it runs and can turn any rule off.

Price drops passed live on Depop (2026-10-31, [verified-features.md](verified-features.md)), so
every seller sees them for their Depop listings. Poshmark and Mercari stay hidden until each
passes its own live run; there, only an account in Test mode ([test-mode.md](test-mode.md)) sees
and runs them.

| Where                                     | What                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/price-drops`                    | `@listora/price-drops`: the rules, the defaults, each listing's plan, the schedule |
| `apps/worker/src/features/price-drops.ts` | The schedule's job (`price_drops`, every 5 minutes)                                |
| `apps/api/src/price-drops`                | `listPriceDrops`, `getPriceDropDefaults`, and creating, changing, deleting rules   |
| `InventoryFeature` (iOS)                  | Settings > Price drops, the rule editor, and the item screen's Price drop          |

## How it works

### A rule

A rule says how much each drop takes off (1% to 50%), after how many days unsold (1 to 365), and
the lowest price a drop may set (at least $1). It is for one of these:

- **A brand**: every item whose brand matches (`brandKey`, the thrift scan's match key, so
  "Levi's" and "LEVI" match, [thrift-scan.md](thrift-scan.md)), unless the item has its own rule.
- **One item**: its own rule wins over its brand's, even when it is off. An item rule turned off
  is how the seller leaves one item out of a brand's drops.

There is one rule per brand and one per item (`409` for a second). Deleting a rule stops its
planned drops; a drop already queued is a price change of its own and finishes.

### When a listing drops, and to what

A listing drops when all of these hold:

- It is live (`active`), its item is `listed`, and it is on Depop, Poshmark, or Mercari under a
  linked session that works (`connected` or `degraded`). eBay is left out because its price
  change has not run live ([verified-features.md](verified-features.md)), and so is an assisted
  marketplace, since its drop would only become a task for the seller.
- It went the rule's days **unsold**: since it went live or its price last changed, by the seller
  or by a drop (its last confirmed `price` or `relist`). After a drop the days start again, so a
  rule of 10% every 21 days keeps stepping down to its floor.
- The rule took effect at least **a day** ago (`DROP_NOTICE_HOURS`, from `armed_at`: made,
  changed, or turned back on). Each drop is therefore on the seller's Coming up list for at
  least a day before it can run.
- Its newest price change did not fail. A failed one pauses the listing's drops (`last_failed`)
  until the seller retries it or changes the price. A listing with a change still in progress
  waits for it.
- Its connection is not read only ([read-only.md](read-only.md)). Such a listing shows as
  `unavailable` and is never queued; the engine's own guard refuses it too.

The new price is the price less the percent, **rounded down to whole dollars** (Poshmark and
Mercari take whole dollars), and never below the rule's floor or the item's own "Don't sell
below" price (`floor_price_cents`), whichever is higher, rounded up to whole dollars. When a drop
would not lower the price, the listing is `at_floor` and drops no more.

### The drop itself

The schedule (`runPriceDrops`) queues each due drop as an ordinary `price` operation with origin
`reprice_rule` and the rule's id (`price_drop_rule_id`) on the operation engine
([operations.md](operations.md)). It sets the listing's price as the seller's own price change
does, records `listing.price_drop_requested` in the item's history (actor `system`, the old and
new price, and the rule), and then the engine sends it, reads it back, and retries or fails it
visibly like any other price change. Nothing about a drop is shown as done before the read-back.
Each listing gets at most one drop per unsold period (the operation's idempotency key names the
listing and the time it went unsold), so a drop the seller canceled is not sent again until the
price changes.

### The pace and the daily cap

Drops are automatic writes on live listings, so they stay well inside the shared automation pace
([automation.md](automation.md)) and never change many prices on a shop at once
(`PRICE_DROP_PACE`):

- At most **10 drops a day per connection** (the daily cap), and no more than a quarter of the
  connection's automation run limits per hour and per day (two runs per drop: the edit and its
  read-back). Listing refresh may use half ([listing-refresh.md](listing-refresh.md)), so the
  seller's own changes, delists, and sale checks always have room.
- **One at a time** per connection, and at least **10 minutes** apart.
- The longest-due listing goes first; the rest wait their turn and stay on Coming up.
- One run per connection at a time, under a transaction-scoped advisory lock.

### Defaults from the seller's days to sell

A new rule starts at 10% after the median days to sell of the seller's sales of the last year
that stand (not canceled or returned), counted as the profit dashboard counts them
([profit.md](profit.md)): from the item's first listing before the sale, else from when it was
added. With three or more sales of the brand, the brand's median; else, with three or more
sales, the median of all of them; else 21 days. A median from sales is held to 7 to 90 days.
For one item, the floor starts at the item's own "Don't sell below" price when it has one. The
editor says what the days rest on ("Half your Patagonia items sold within 18 days (7 sales this
year).").

### What the seller sees

- **Settings > Price drops**: Coming up, every planned drop soonest first (the item, its
  marketplace, the price now struck through beside the next one in Fraunces, and when), then the
  listings a rule covers that won't drop (at their lowest price, paused after a failure, or
  unavailable), then the brand rules and the item rules, each with its switch. Add brand rule
  opens the editor. Ruled rows, no stitching (Hang Tag, [design.md](design.md)).
- **The item screen**, under the marketplaces once the item is live where price drops show: the
  rule that applies (its own or its brand's) with its next drop on each marketplace, or Price
  drop to give it a rule; with a brand's rule, Give this item its own rule.
- Both are tagged "Testing" while they show only because of Test mode.

## The gate

`price_drops` is a marketplace feature ([verified-features.md](verified-features.md)), verified
per marketplace like listing refresh. It is verified on Depop only, so:

- a listing on a marketplace where it is hidden is not planned (`planDrops`): it is not on
  Coming up, not counted under its rule, and never dropped; the schedule takes only connections
  on marketplaces where it passed live, or of accounts in Test mode, and only of accounts with a
  rule on;
- the item screen shows Price drop only for its marketplaces where it shows;
- were it verified nowhere for the account, every route would answer `404` (`listPriceDrops`
  and the rest) and the app would show no Settings row.

In Test mode each finished drop goes in the owner's log (`feature_test_run`, feature
`price_drops`, the operation as its subject), passed with its read-back or failed with its
error: the evidence for marking it verified. Its live tests run only on the captain's own test
shops.

### The Depop live run (2026-10-31)

On the captain's Depop test shop (the signed-in shop read first, nothing written otherwise), with
Listora's own API, the real schedule (`runPriceDrops`), and the operation engine on a local
database, and the Depop scripts in the signed-in Mac Chrome as the phone runs them:

1. A marked test listing at $250, made by the engine, and an item rule of 50% after 1 day with a
   $200 floor, made through `createPriceDropRule`.
2. Coming up showed the drop to $200 (not $125: the floor held) a day after the rule was made,
   and the schedule queued nothing that day (the day of notice).
3. With the day passed (the rule's `armed_at` and the listing's time moved back), Coming up showed
   it due now; the schedule queued one `reprice_rule` price change with its history line; the
   engine sent it and it succeeded only on the read-back of $200 (`read_back`), which a separate
   read of Depop matched. The owner's log recorded it passed.
4. The schedule then queued nothing (at the floor, and the pace), and Coming up showed `at_floor`.
5. The daily cap, on the local database only: with ten drops in the day it queued nothing for a
   due drop, and with nine it queued one (canceled before any worker ran it).
6. The test listing was deleted and read back gone. **The phone needs a new app build** for Settings > Price drops and the item screen's
   Price drop; the server side ships with a deploy.

## Local development

Nothing to configure: the local stacks and Vitest run every built feature
(`MARKETPLACE_FEATURES=all`), so the schedule runs drops on the fakes, and each drop goes through
the fake sites' price change like the seller's own. The pace's numbers are constants in
`scheduler.ts`, not environment keys.

## Tests

- `rules.test.ts`: the rounding, both floors, at the floor, the day of notice, the defaults (the
  brand's, all sales, the fallback, the 7 to 90 day range), and the terms refused.
- `scheduler.int.test.ts` (real Postgres): a due drop queued as a `reprice_rule` price change
  with its listing price and history; the day of notice; both floors; an item rule over its
  brand's, also off; the days starting again after any price change; no drop after a failure,
  on a busy listing, after a canceled drop, on a read-only shop, under a rule that is off, or on
  an assisted marketplace; the pace (one at a time, the gap, the daily cap); the gate (Depop for
  every seller, Mercari not planned or dropped outside Test mode); the defaults from days to sell.
- `operations/price-drop.int.test.ts`: a drop succeeds only with a read-back, fails visibly,
  keeps its history when its rule is deleted, is refused without its rule or as another kind,
  and is recorded in the owner's log in Test mode.
- `api/price-drops/price-drops.int.test.ts`: a brand rule and its planned drop a day ahead with
  no price sent, an item rule over its brand's with the item's floor, `409` for a second rule,
  off and on re-arming, delete, a read-only shop's listing unavailable, terms refused, another
  account's rules unreachable, and, under the real gate, a hidden marketplace's listing left
  off Coming up except in Test mode.
- `PriceDropsTests` (iOS): the words, the screen's model (load, a failed load, a rule's switch
  and its failure), and the editor (defaults for a brand and an item, the missing floor, save,
  change, delete).

## Follow-ups

- Poshmark and Mercari each after their own live run, then their `VERIFIED_FEATURES` entries.
- A seller-set daily cap and a skip for one planned drop, if the live test shows they are needed.
- A drop's own trust metric, like refresh's.

## Data

- `price_drop_rule`: one row per rule: `scope` (`item` or `brand`), `item_id` (with `item`,
  deleted with the item), `brand` and `brand_key` (with `brand`), `percent`, `after_days`,
  `floor_cents` and `currency`, `enabled`, and `armed_at` (when it last took effect). One per
  item and one per brand key. Deleted with the account.
- `marketplace_operation.price_drop_rule_id`: the rule a `reprice_rule` price change ran under,
  only on those; set to null when the rule is deleted, so the drop stays in the history.
