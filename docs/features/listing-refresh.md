# Listing refresh

A live listing that goes a while without selling sinks in its marketplace's feeds and search.
Listora refreshes it on the seller's schedule, through what makes a listing show as fresh on
each marketplace, so the seller never has to share, re-save, or relist listings by hand. On
Poshmark and Mercari a refresh never changes the listing and never deletes and reposts it. Depop
shows only a new listing as new, so its refresh is a **relist**: a fresh copy is posted and
confirmed, and only then is the old listing deleted, which resets its likes and saves, so it runs
only for a seller who turns it on (see [Relisting on Depop](#relisting-on-depop)). It replaced
the Today screen's old `stale_listing` card ([today.md](today.md)).

The rules, the settings, and the schedule are `@listora/listing-refresh`
(`packages/listing-refresh`); the job is `apps/worker/src/features/listing-refresh.ts`; the API is
`apps/api/src/listing-refresh` (the settings, an item's own cadence) and each listing's
`refresh` on the item (`apps/api/src/items/views.ts`); the marketplaces' refreshes are their
automation scripts' `refresh` ([automation.md](automation.md)); the screens are in the
`InventoryFeature` package (Settings > Listing refresh, the item screen).

## How it works

### What a refresh is

A refresh is an ordinary marketplace operation (`marketplace_operation.kind = 'refresh'`, origin
`auto_refresh`) on the operation engine ([operations.md](operations.md)), so it runs in the
listing's queue after any other change, is sent once, and is **confirmed only by a read-back**:
its desired state is `refreshedAfter` (the second the schedule queued it), and it succeeds only
when the marketplace reads the listing as refreshed at or after that time (`refreshedAt` on the
read). A refresh the read can't confirm is never shown as done: it fails visibly ("Refresh
failed - Retry" on the listing, with the engine's Retry), with `REFRESH_MAX_ATTEMPTS` (3) attempts
rather than the usual seven (each send is still read back, so at most two shares, saves, or relists), so a
marketplace that won't show it is not asked again and again within hours. Refreshes are left out of the trust metrics
(`VerifiedSuccess`, `OperationFailed`, [observability.md](observability.md)), so a scheduled
refresh never moves the alarms that watch the seller's own changes; a refresh metric of its own
is a follow-up.

| Marketplace                                         | Refresh                                                            | Read as fresh by                                  |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Poshmark                                            | Share to followers: the listing page's Share, then To My Followers | The listing record's `updated_at` (to the second) |
| Mercari                                             | The listing's edit page saved unchanged                            | The item's last change (`updated`, in seconds)    |
| Depop                                               | A relist: a fresh copy posted, then the old listing deleted        | The new product's `updated_at` (its API)          |
| eBay                                                | None: eBay's relist is a new listing that drops the watchers       | -                                                 |
| Any, without a working browser session, or assisted | None: Listora would have to ask the seller to do it every few days | -                                                 |

**Read-only connections are never refreshed.** A connection marked read only
([read-only.md](read-only.md)), such as the live Depop shop, gets no refresh: the schedule reads
only connections with `read_only` false, so nothing is ever queued for one, whatever its adapter
can do, and its listings show refresh as unavailable. The engine's own guard refuses a refresh on
one too (`enqueueOperation`), so a refresh can never reach it by another way. Tests run only
against the fake sites.

**Shown only where a refresh passed live** ([verified-features.md](verified-features.md)): Depop's relist passed (see [Live verification](#live-verification)); Mercari's and Poshmark's refreshes have not run live.
Elsewhere `canRefresh` is false, the schedule queues nothing, and the app hides Settings > Listing
refresh and the item's Refresh this item; the Depop relist switch shows only where Depop's refresh
does. The local stacks and tests run it on the fakes (`MARKETPLACE_FEATURES=all`).

The capability is the adapters' own `refresh` flag (`MarketplaceCapabilities.refresh`): an
automation adapter has it when its scripts have a `refresh` script, never in assisted mode
(`checkCapabilities` refuses an assisted or bulk-file refresh), and the shared conformance suite
checks every adapter that has it by how it refreshes (`MarketplaceCapabilities.refreshBy`): an
`in_place` refresh leaves the same listing, unchanged, with the same id and a single copy, read as
refreshed; a `repost` one answers with a new id that reads live and refreshed with the same
content, the old listing reads gone or ended, it posts one copy, and it refuses without the
listing's content. A refresh that meets a check automation must not pass, or a
page the script no longer understands, fails (`refresh_stopped`) instead of making an assisted
task, unlike every other kind. `REFRESH_MARKETPLACES` in `schedule.ts` names the marketplaces the
item screen shows a schedule for, and `REPOST_MARKETPLACES` those whose refresh is a relist; a
worker test checks both against the adapters.

### Relisting on Depop

An edit saved unchanged moves a Depop product's `updated_at`, but Depop does not show it as new
(a live run on 2026-10-31 confirmed the save moved the time; the captain, who sells on Depop,
confirmed it does not move the listing up: only a relist does). So Depop's refresh posts the
listing again:

1. The script reads the old listing on sale, then posts a **fresh copy** from the content the
   refresh carries: the photos the listing was posted with (from the newest confirmed operation
   that carried its content) and the listing's own text, price, category, size, condition,
   aspects, and hashtags now (`repostContent`), with the same SKU line. Shipping is the seller's
   Depop default, as on any post.
2. It reads the copy back until Depop shows it on sale (up to 4 reads, 3 s apart). A copy that
   doesn't show stops the run before anything else happens.
3. Only then does it delete the old listing (Delete listing on its product page) and read it back
   as gone.
4. It answers with the copy's slug. The engine makes it the listing's pending id, confirms it by
   its own read-back (on sale, changed at or after `refreshedAfter`), and then moves the listing
   (`marketplace_listing`, the item's link to Depop) to the new listing, so its URL, sales, and
   later changes follow the copy.

The old listing is never deleted before its copy reads as live. An attempt that stops between
the post and the delete (Depop's page changed, a lost answer) is read back and sent again; the
next attempt finds the copy it posted by its SKU (never the old listing, which has the same SKU)
instead of posting another, then deletes the old one. If the old listing sold meanwhile, the
refresh stops as sold and takes its copy down again. A refresh that runs out of attempts fails
visibly with its Retry, which finishes the same way.

The relist runs only when the seller turned it on: **Settings > Listing refresh > Relist on
Depop** (`relist_to_refresh`, off for every account), which asks first and says plainly that each
relisted listing starts again with no likes or saves. With it off, Depop listings show refresh
as off. It relists only listings Listora wrote (an imported or linked listing has no content to
post again, so it shows refresh as unavailable), and skips a listing while a buyer's offer on it
waits for an answer (`marketplace_offer.status = 'pending'`), which a delete would lose. The
schedule, quiet window, pacing, and caps are the same as every refresh's.

### When

A listing is **due** its interval after it was last fresh: when it went live, its last confirmed
change (a create, revise, price, or relist), or its last refresh, whatever came of that one, so a
failed refresh waits a whole interval too. Only `active` listings of `listed` items are refreshed,
under an automation connection that works (`connected` or `degraded`), and never one with an
operation that is not finished.

- **The setting** (`listing_refresh_setting`, one per account): whether Depop listings are
  relisted (`relist_to_refresh`, see above), and the cadence: `off`, `every_72_hours` (the
  default), `daily`, `every_few_days` (every 5 days), `weekly`, or `custom` (12 hours to 30
  days), and an optional **quiet window** (`22:00` to `07:00`, may run past midnight) in the
  seller's time zone, which the app sends from the device. No refresh is queued inside it.
- **An item's own cadence** (`inventory_item.refresh_cadence`) wins over the account's, for
  example `off` for one item, or `daily` for one while the account is off.
- **The item screen** shows each live listing's next refresh (its due time, now for one already
  due, moved out of the quiet window) and its last confirmed one (`ListingRefresh` on `Listing`,
  computed per request by `listingRefresh`), or that refreshing is off for it.

### The pace

The schedule (`listing_refresh`, every 5 minutes, `runListingRefreshes`) works one marketplace
session at a time, under a transaction-scoped advisory lock, and stays well inside the shared
automation pace ([automation.md](automation.md)), so the seller's own changes, delists, and sale
checks always have room and an account is never pushed toward the marketplace's limits:

- Refreshes use at most half (`REFRESH_PACE.shareOfLimits`) of the connection's automation run
  limits per hour and per day (`AUTOMATION_<MARKETPLACE>_*`), at about 2 runs per refresh (the
  share, save, or relist, and its read-back): with the default 30 runs an hour and 200 a day, up to 7
  refreshes an hour and 50 a day per marketplace. A seller with more due listings gets the ones
  waiting longest first; the rest wait their turn.
- At most 2 refreshes wait unfinished on one connection, so a phone that is away (Poshmark,
  Mercari, and Depop run on the seller's iPhone, [phone-execution.md](phone-execution.md)) does
  not collect a pile, and at most 2 are queued per connection per run.
- Each refresh still goes through the runner's or the phone's own pacing and per-seller limits.
- One refresh per listing per fresh period: its idempotency key names the listing and the time
  it was last fresh, so two workers or two ticks never queue two.

### Live verification

**Depop** (2026-10-31, the captain's test shop `tonioreign`, in a background tab of the Mac's
signed-in Chrome, with Listora's own phone runtime and Depop scripts, through the machine-wide
Depop pacing; the shop's name was read before any write). The shop had no listings, so a clearly
marked test listing was posted and left for 90 seconds. The refresh, with `refreshedAfter` the
second it was sent, read the listing on sale, posted the fresh copy, found it by its SKU, read it
on sale, deleted the old listing, and read it back as gone, in 27.2 s. The engine's read-back of
the copy, on its first read (1.8 s), showed it on sale with the same text and price, changed 19
seconds after `refreshedAfter`, so the refresh was confirmed; the old listing read as gone, and
the shop showed only the copy. The copy was deleted after. Earlier that day an unchanged save of
a test listing was confirmed the same way (Depop moved its `updated_at` 3 s after the send), but
Depop does not show a saved listing as new, which is why the refresh is a relist.

### What is not proven yet

The fake sites mirror each refresh, but no recording of a real share or unchanged save exists
yet ([recorded-pages.md](recorded-pages.md)): the share controls' selectors
(`[data-et-name="share"]`, `[data-et-name="share_poshmark"]`), that a Poshmark share moves the
listing's `updated_at`, and that Mercari moves its change time on a save without changes, and
whether either moves a listing up its feeds (Depop's save moved its time and still did not). If a
marketplace does not, its refreshes fail visibly and are retried only at the next
interval; recording a share and a save in the seller's own session is the follow-up that settles
it.

## Local development

Nothing to configure. The fake Poshmark (`POST /share-listing/<id>`), the fake Mercari site (its
edit page's Save), and the generic fake site (`POST /listings/:id/refresh`) each refresh a
listing in place and move its time, and the fake API marketplace has
`POST /listings/:id/refresh`. On the fake Depop site a refresh is a relist through its sell form
and Delete listing, as on Depop. To see Depop's refresh locally, turn on Relist on Depop in
Settings > Listing refresh. The schedule runs in the worker like every other job.

## Data

- `listing_refresh_setting`: one row per account: `cadence`, `custom_hours` (only with
  `custom`), `quiet_start` and `quiet_end` (minutes after midnight, both or neither, never equal),
  `time_zone` (IANA, required with a quiet window), and `relist_to_refresh` (Depop's relist,
  false until the seller turns it on). Deleted with the account.
- `inventory_item.refresh_cadence` and `refresh_custom_hours`: an item's own cadence, null to
  follow the account's.
- `marketplace_operation.kind` gains `refresh` and `origin` gains `auto_refresh`; a refresh's
  `desired` is only `{ "refreshedAfter": "<ISO time>" }`, and a relist (Depop) also carries the
  `content` its fresh copy posts (`marketplace_operation_content_by_kind` allows it on a refresh
  only). The last refresh shown on a listing is its newest succeeded refresh; nothing else is
  stored.
