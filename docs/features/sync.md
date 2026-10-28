# Sync

The seller sees Listora bring in their marketplaces: **Sync now** (and a pull to refresh on Today
and Sales) asks for read-only checks of every linked marketplace at once, an indicator says what
the phone is doing and what each check found, and Link accounts says when each marketplace last
synced. The app syncs once when it opens and otherwise only when the seller asks: nothing reads a
marketplace that runs on the iPhone on a timer.

| Where                                                              | What                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/api/src/sync/`                                               | `requestSync` and `getSyncStatus`: the checks asked for, the words |
| `packages/automation/src/sale-checks/schedule.ts`, `offers/`       | The sale check and offer read a sync asks for                      |
| `SyncFeature` (iOS): `SyncModel`, `SyncIndicator`, `SyncNowButton` | The indicator, Sync now, the sync on opening the app               |
| `Core/Sync/MarketplaceSync.swift`                                  | What Today, Sales, and Link accounts use of the sync               |

## What a sync reads

`POST /v1/sync` (`requestSync`) asks, for every connection linked by signing in (an automation
connection that works), read-only:

- **Sales**: a sale check now (`sale_check_schedule.next_reason` `sync`), on the phone as
  `sale_check` phone work, or the browser runner's job in the cloud
  ([automation.md](automation.md)). A sale it finds starts its delists as any check's does.
- **Offers**: a read of the buyers' offers on Poshmark and Depop (`requestOfferChecks`,
  [offers.md](offers.md)).
- **Listings**: once the seller imported a marketplace's listings, another import, which brings
  in what was listed there since and settles the rest at once ([imports.md](imports.md)). At most
  every 6 hours (`LISTING_SYNC_MIN_GAP_MS`): a read goes through every listing.

A marketplace whose sale check started in the last 2 minutes (`SYNC_MIN_GAP_MS`) is not checked
again, and neither are offers read in that time, so repeated taps and pulls read nothing twice.
Every read is a read: a read-only connection ([read-only.md](read-only.md)) is synced like any
other, and nothing a sync queues can change a marketplace.

**Never on a timer.** The dispatcher queues the due sale checks of cloud connections only, and no
longer asks for offer reads every hour. A connection that runs on the phone is read when the
seller opens the app (one sync per launch), taps Sync now, or pulls to refresh; and when
something asks for a check (a forwarded sale email, an accepted offer, linking). Its schedule's
due time still marks its checks overdue when the app has not been opened, which asks the seller
to open Listora ([activity.md](activity.md)). eBay through its API is not part of a sync: its
order poll runs every 5 minutes on the server ([ebay-notifications.md](ebay-notifications.md)).

## What the seller sees

`GET /v1/sync` (`getSyncStatus`) gives each linked marketplace's sync in the seller's words,
without internal codes:

- `syncing` while a read waits or runs: "Checking sales...", "Checking offers...", "Reading your
  listings...";
- `synced`: what the last reads found: "52 sales found" (the first check, which reads the sales
  history), "2 new sales" or "No new sales", then ", 1 offer waiting" and ", 3 new listings
  imported";
- `failed`: "Couldn't check sales. Sync again to try again.", or a check the marketplace asked
  for ("Asked to check it's you. Sync again with Listora open to finish the check.");
- `not_synced`: "Not synced yet";
- `lastSyncedAt`: when a sale check or offer read last got through.

In the app (`SyncModel`):

- **The indicator** shows over the bottom of Today and Sales, one line per marketplace: what the
  phone is doing, from the run's purpose ("Checking Depop sales...", "Checking Depop offers...",
  "Reading your Depop listings...", "Updating your Depop listing..."), or "Syncing Mercari..."
  for reads that wait or run elsewhere. Once a marketplace's reads end (Listora no longer says
  `syncing` and the phone no longer runs them), it shows what they found ("Depop: 52 sales
  found") for 6 seconds, or a failure with **Try again**, which syncs again, until the next sync.
  A listing change shows while the phone runs it and leaves no result here: its own screen shows
  whether it was done, from the marketplace's read-back ([operations.md](operations.md)).
  Listora unreachable says so ("Listora couldn't be reached to sync...") with Try again.
- **Sync now** sits in Today's and Sales' headers and spins while a sync runs; a pull to refresh
  there syncs too. Both screens read their data again when a sync ends.
- **Opening the app** syncs once per launch (and again for the next person to sign in).
- While it follows a sync, the app asks Listora how the reads go every 2 seconds, for at most 3
  minutes; that reads Listora's records only, never a marketplace.
- **Link accounts** shows "Last synced 5 minutes ago" under each marketplace.

## Tests

- API (`apps/api/src/sync/sync.int.test.ts`): the checks a sync asks for, on the phone and in
  the cloud; nothing again within 2 minutes; a read-only account synced with nothing that could
  change it queued; listings read again only once imported and 6 hours on; the words of what a
  sync found and of a failure; another account sees nothing.
- No timer (`packages/automation/src/phone/work.int.test.ts`): offer reads only when asked.
- App (`SyncFeatureTests`): the indicator's lines while the phone works and after, a result that
  goes and a failure that stays with Try again, Listora unreachable, one sync on opening, none
  signed out, how long it follows; `LastSyncedTests` for Link accounts; the run's purpose in the
  phone's progress (`PhoneRunnerProgressTests`).

## Data

Migration `20261028134627_sale_check_sync`: `sale_check_schedule.next_reason` and
`sale_check_run.reason` gain `sync`.

## Open items

- The indicator shows on Today and Sales; the item screen keeps its own progress card.
- eBay through its API has no "Last synced" yet: its order poll keeps no record per connection.
