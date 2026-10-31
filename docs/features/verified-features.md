# Marketplace features: sellers see only what passed live

The seller sees only what Listora can actually do. That means features that are built, useful,
and proven on a real marketplace account. Listora keeps one list of each marketplace's customer
features, and a feature counts as **verified** only once it has passed a live end-to-end test.
Anything not verified is hidden:

- The app shows nothing of it: no screen, row, button, empty state, or error.
- The server never queues its checks for sellers.

Poshmark's offers are the first case. No Poshmark account with offers has been tested yet, so
Poshmark offer reads failed and showed the seller an error. Now Poshmark offers don't show at all.

| Where                                                          | What                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/marketplaces/src/features.ts`                        | The list: the features, each marketplace's verified ones with their evidence    |
| `apps/api/src/marketplace-features/`                           | `GET /v1/marketplace-features` (`listMarketplaceFeatures`), which the app reads |
| `Core/MarketplaceFeatures` (iOS), `MarketplaceFeaturesService` | The app's copy of the list; only the features in it show                        |

## The features

| Feature           | What the seller gets                                                  | Gated where                                                                                                        |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sales_history`   | Past sales read from the marketplace's sold pages                     | It is a sale check's first read, so `sale_checks` requires it (the list's test checks this)                        |
| `sale_checks`     | New sales found by reading the marketplace, which start their delists | `enqueueSaleCheck`, `requestSaleCheck`, `dueSaleChecks`, `prepareSaleCheck`, the overdue mark and its push, Sync   |
| `offers`          | Buyers' offers read into Tasks                                        | `queueOfferCheck`, `requestOfferChecks`, the offer checks and offers in the API, offer tasks, Sync                 |
| `offer_answers`   | Accept, Decline, and Counter from Listora                             | `offerActions` (an offer shows no answers, "Answer this offer in Depop."), `requestOfferAnswer`, the phone's claim |
| `listing_import`  | Importing existing listings as items                                  | `importsFrom` (Import listings, starting one, Sync's listing reads)                                                |
| `listing_refresh` | Refreshing live listings on a schedule                                | `canRefresh` and the refresh schedule; the app hides Settings > Listing refresh and the item's Refresh this item   |
| `revise`          | Editing a live listing's details (title, description, aspects)        | `availableActions` (a live listing offers no `revise`), so `reviseListing` is refused before anything is queued    |
| `market_comps`    | The thrift scan's comparisons from the marketplace's public search    | `createScan` hands the iPhone no read, `saveScanComparison` answers `404`; the card shows no row                   |

**Listora's own features** follow the same rule (`APP_FEATURES`, `VERIFIED_APP_FEATURES`,
`isAppFeatureOn`), listed in the answer's `app` rather than under a marketplace:

| Feature       | What the seller gets                                                 | Gated where                                                                                               |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `thrift_scan` | Add Item's Scan mode at the store ([thrift-scan.md](thrift-scan.md)) | `createSourcingRun`, `endSourcingRun`, `createScan`, and `keepScan` answer `404`; the app hides Scan mode |

Revise is on the list because it has not run live on any marketplace. Hiding it leaves the
seller's own edits alone: the Listora item and draft listings still edit, and nothing changes on
a marketplace until the seller publishes. The item screen's Edit listing (title and description)
shows only when the server offers `revise`, so it shows only in the owner's Test mode until
revise passes live ([test-mode.md](test-mode.md)).

The other listing actions (publish, price, end, relist) are not on this list. They passed live
(below), show as done only after a read-back, and a failure shows with Retry
([operations.md](operations.md)).

## How the gate works

- **One list, on the server.** `VERIFIED_FEATURES` records, for each marketplace, the features
  that passed live, each with the date and what the run proved. Every gate asks
  `isFeatureOn(marketplace, feature, gate)` with the account's gate (`loadFeatureGate`): the
  verified features for every seller, and every built one for an account in Test mode (the
  owner's, or one granted it)
  ([test-mode.md](test-mode.md)), which is how a hidden feature gets its live run. The app gets the same list from `GET /v1/marketplace-features`, so changing what
  shows takes only a server deploy, with no new app build.
- **Nothing hidden is queued.** Each hidden read stops before it is queued: Sync, Tasks' offer
  read, a forwarded sale email's check, linking, and the cloud dispatcher. Work queued before a
  feature was hidden is also dropped. The phone's claim deletes it without running it, a cloud
  sale check job does nothing, and no failure is recorded.
- **Answers.** An answer that has not been sent is refused before anything goes to the
  marketplace. An answer that may already have reached the marketplace is still read back, so
  its result is never left unknown.
- **No raw errors for sellers.** When a background read of a verified feature fails, the reason
  goes to the owner's alerts and the read-health admin view ([read-health.md](read-health.md)),
  not to the seller. The offer checks the app reads carry no error message, and Tasks has no
  "Offers not read" banner. Sync still says "Couldn't check sales. Sync again to try again.",
  because the seller can act on that.
- **A hidden overdue check sends nothing.** A hidden sale check is never marked overdue, so the
  seller never gets "Open Listora to keep Poshmark in sync".
- **A marketplace with no verified read** is left out of a sync and its status. A verified
  read's status uses only its own records.

### The app

`MarketplaceFeatures` (Core) loads the list each time the app comes to the foreground. Until
the list loads, and whenever it can't be read, nothing gated shows. The server already filters
offers, offer checks, imports, and sync, so the app's own checks cover what only it decides:
Settings > Listing refresh, the item screen's Refresh this item, and the offer screen's answers
(the server's `actions`). An app installed before this change keeps working: the server stops
handing it hidden work and data, but that app still shows its Listing refresh settings until it
updates. **The phone needs a new app build** for the refresh screens and the removed Tasks
banner.

## Local development and tests

`MARKETPLACE_FEATURES` (`.env.example`) chooses which features the API, the worker, and the
browser runner run:

- `verified` is the default and what every deployment runs.
- `all` turns on every feature that is built, for the local stacks and tests on the fakes. The
  e2e stack sets it.
- `all` is refused beside Cognito sign-in (`AUTH_DRIVER=cognito`, or the worker's
  `COGNITO_USER_POOL_ID`), so real sellers only ever see what passed live.

The tests run like this:

- Vitest runs every test file with `all` (`packages/marketplaces/src/vitest-setup.ts`). That
  way, each feature's own tests test it whether or not it has passed live.
- The gate's own tests switch to `verified` and back:
  - `marketplace-features.int.test.ts` (API): the list, a sync without Poshmark, no hidden
    offer reads, a failed read with no error, offers without answers and a refused answer, and
    imports only from Depop and Mercari.
  - `phone/work.int.test.ts`: hidden work dropped unrun, and a hidden answer never sent.
  - `sale-checks.int.test.ts`: no check, overdue mark, or push for Poshmark.
  - `marketplace-features.int.test.ts` also: no revise offered or queued on a live listing,
    while a draft still edits.
  - `features.test.ts`: the list's evidence, what each feature requires, and the key.
  - `cadence.test.ts`: refresh unavailable.
  - `MarketplaceFeaturesTests` (iOS).

## The verified list and its evidence

Only live runs on real accounts count here. A run on a fake site or a recorded page doesn't. A
write ran only on the captain's own accounts. Tristin's Depop shop was only ever read.

| Marketplace | Feature                        | Verdict                                                                                                                                               |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depop       | `sales_history`                | **Verified** 2026-10-28: the new sale check read every sale on a real shop's receipts, refund left out, totals matching to the cent                   |
| Depop       | `sale_checks`                  | **Verified** 2026-10-28: a check on the iPhone found a new sale on a real shop (found by the check itself, not by reading the history)                |
| Depop       | `offers`                       | **Verified** 2026-10-28: an offer read on the iPhone succeeded on a real shop, and its one waiting buyer offer became a task                          |
| Depop       | `listing_import`               | **Verified** 2026-10-28: an import read and imported all 118 listings of a real shop, with none failed (the import detail fix after it is not re-run) |
| Depop       | `offer_answers`                | Hidden: tested only on the fakes; no answer has run on a real shop                                                                                    |
| Depop       | `listing_refresh`              | Hidden: no live refresh (an unchanged save) yet                                                                                                       |
| Mercari     | `sales_history`                | **Verified** 2026-10-27: the captain's one real sale read correctly, with its listing                                                                 |
| Mercari     | `sale_checks`                  | **Verified** 2026-10-28: checks on the iPhone's mobile layout read the real sold page and succeed since that day's fix; no new sale has happened yet  |
| Mercari     | `listing_import`               | **Verified** 2026-10-27: an import read all 11 of the captain's listings for sale                                                                     |
| Mercari     | `offers`, answers              | Hidden: not built; Mercari's website shows no offers page ([offers.md](offers.md))                                                                    |
| Mercari     | `listing_refresh`              | Hidden: no live refresh yet                                                                                                                           |
| Every one   | `revise`                       | Hidden: no revise has run live on any marketplace (see below)                                                                                         |
| Depop       | `market_comps`                 | Hidden: the logged-out reader is tested on a recorded public search; its live test is the captain's, at a store ([thrift-scan.md](thrift-scan.md))    |
| Poshmark    | `offers`                       | Hidden: the live read failed (`element_missing`, 2026-10-28) on an account with no offers                                                             |
| Poshmark    | `sales_history`, `sale_checks` | Hidden: the checks run and read 0, but the account has never sold, so finding a sale was never proven                                                 |
| Poshmark    | `listing_import`               | Hidden: the only live run was on an empty closet                                                                                                      |
| Poshmark    | answers, refresh               | Hidden: no live run                                                                                                                                   |
| eBay        | every feature                  | Hidden: no eBay connection has run live                                                                                                               |

Listing actions, as they ran live (only revise is gated, see above):

| Marketplace | Publish, price, end, relist              | Revise (details) |
| ----------- | ---------------------------------------- | ---------------- |
| Depop       | Passed 2026-10-27, the captain's account | Not run live     |
| Poshmark    | Passed 2026-10-27, the captain's account | Not run live     |
| Mercari     | Passed 2026-10-27, the captain's account | Not run live     |
| eBay        | Not run live                             | Not run live     |

Mark a feature verified only after a live end-to-end run proves it. Make one change that adds
its entry to `VERIFIED_FEATURES`, with the date and what the run proved, and adds its row here.
A Test mode run's passed entry in the owner's log (`npm run admin -- feature-tests`,
[test-mode.md](test-mode.md)) is that evidence; the list still changes only in a reviewed PR.

## Open items

- Whether the eBay listing actions that haven't run live should fall back to assisted mode
  until they pass.
- Pack check's label reads (live on Depop) and linking are not on the list yet.
