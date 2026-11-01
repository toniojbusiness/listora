# Listing refresh

A live listing that goes a while without selling sinks in its marketplace's feeds and search.
Listora refreshes it on the seller's schedule, through each marketplace's own normal way to make
a listing show as fresh, so the seller never has to share or re-save listings by hand. A refresh
never changes the listing and never deletes and reposts it (which would lose its likes and
watchers). It replaced the Today screen's old `stale_listing` card ([today.md](today.md)).

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
rather than the usual seven (each send is still read back, so at most two shares or saves), so a
marketplace that won't show it is not asked again and again within hours. Refreshes are left out of the trust metrics
(`VerifiedSuccess`, `OperationFailed`, [observability.md](observability.md)), so a scheduled
refresh never moves the alarms that watch the seller's own changes; a refresh metric of its own
is a follow-up.

| Marketplace                                         | Refresh                                                            | Read as fresh by                                      |
| --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Poshmark                                            | Share to followers: the listing page's Share, then To My Followers | The listing record's `updated_at` (to the second)     |
| Mercari                                             | The listing's edit page saved unchanged                            | The item's last change (`updated`, in seconds)        |
| Depop                                               | The listing's edit page saved unchanged                            | The product's `updated_at` (its API) or `dateUpdated` |
| eBay                                                | None: eBay's relist is a new listing that drops the watchers       | -                                                     |
| Any, without a working browser session, or assisted | None: Listora would have to ask the seller to do it every few days | -                                                     |

**Read-only connections are never refreshed.** A connection marked read only
([read-only.md](read-only.md)), such as the live Depop shop, gets no refresh: the schedule reads
only connections with `read_only` false, so nothing is ever queued for one, whatever its adapter
can do, and its listings show refresh as unavailable. The engine's own guard refuses a refresh on
one too (`enqueueOperation`), so a refresh can never reach it by another way. Tests run only
against the fake sites.

**Hidden until a refresh passes live.** No marketplace's refresh has run on a real account yet,
so sellers see none of it ([verified-features.md](verified-features.md)): `canRefresh` is
false, the schedule queues nothing, and the app hides Settings > Listing refresh and the item's
Refresh this item. The local stacks and tests run it on the fakes (`MARKETPLACE_FEATURES=all`).

The capability is the adapters' own `refresh` flag (`MarketplaceCapabilities.refresh`): an
automation adapter has it when its scripts have a `refresh` script, never in assisted mode
(`checkCapabilities` refuses an assisted or bulk-file refresh), and the shared conformance suite
checks every adapter that has it: a refresh leaves the same listing, unchanged, with the same id
and a single copy, read as refreshed. A refresh that meets a check automation must not pass, or a
page the script no longer understands, fails (`refresh_stopped`) instead of making an assisted
task, unlike every other kind. `REFRESH_MARKETPLACES` in `schedule.ts` names the marketplaces the
item screen shows a schedule for; a worker test checks it against the adapters.

### When

A listing is **due** its interval after it was last fresh: when it went live, its last confirmed
change (a create, revise, price, or relist), or its last refresh, whatever came of that one, so a
failed refresh waits a whole interval too. Only `active` listings of `listed` items are refreshed,
under an automation connection that works (`connected` or `degraded`), and never one with an
operation that is not finished.

- **The setting** (`listing_refresh_setting`, one per account): `off`, `every_72_hours` (the
  default), `daily`, `every_few_days` (every 5 days), `weekly`, or `custom` (12 hours to 30
  days), and an optional **quiet window** (`22:00` to `07:00`, may run past midnight) in the
  seller's time zone, which the app sends from the device. No refresh is queued inside it.
- **An item's own cadence** (`inventory_item.refresh_cadence`) wins over the account's, for
  example `off` for one item, or `daily` for one while the account is off.
- **The item screen** shows each live listing's next refresh (its due time, now for one already
  due, moved out of the quiet window) and its last confirmed one (`ListingRefresh` on `Listing`,
  computed per request by `listingRefresh`), or that refreshing is off for it.
- **Choosing in the app**: Settings > Listing refresh and the item's Refresh this item show every
  choice at once as single-choice chips (`ChoiceChip`, [design.md](design.md)), in the order Off,
  Every 72 hours, Daily, Every 5 days, Weekly, Custom, with the one in use checked, so the
  schedule plainly reads as something to change (a menu row showing only the current value did
  not). The item's chips start with My setting (the account's, named) and leave out Custom, which
  is set in Settings; an item that already has its own custom time names it under the title,
  with no chip checked. An item's choice saves at once; Settings saves with Save.

### The pace

The schedule (`listing_refresh`, every 5 minutes, `runListingRefreshes`) works one marketplace
session at a time, under a transaction-scoped advisory lock, and stays well inside the shared
automation pace ([automation.md](automation.md)), so the seller's own changes, delists, and sale
checks always have room and an account is never pushed toward the marketplace's limits:

- Refreshes use at most half (`REFRESH_PACE.shareOfLimits`) of the connection's automation run
  limits per hour and per day (`AUTOMATION_<MARKETPLACE>_*`), at about 2 runs per refresh (the
  share or save, and its read-back): with the default 30 runs an hour and 200 a day, up to 7
  refreshes an hour and 50 a day per marketplace. A seller with more due listings gets the ones
  waiting longest first; the rest wait their turn.
- At most 2 refreshes wait unfinished on one connection, so a phone that is away (Poshmark,
  Mercari, and Depop run on the seller's iPhone, [phone-execution.md](phone-execution.md)) does
  not collect a pile, and at most 2 are queued per connection per run.
- Each refresh still goes through the runner's or the phone's own pacing and per-seller limits.
- One refresh per listing per fresh period: its idempotency key names the listing and the time
  it was last fresh, so two workers or two ticks never queue two.

### What is not proven yet

The fake sites mirror each refresh, but no recording of a real share or unchanged save exists
yet ([recorded-pages.md](recorded-pages.md)): the share controls' selectors
(`[data-et-name="share"]`, `[data-et-name="share_poshmark"]`), that a Poshmark share moves the
listing's `updated_at`, and that Mercari and Depop move their change time on a save without
changes. If a marketplace does not, its refreshes fail visibly and are retried only at the next
interval; recording a share and a save in the seller's own session is the follow-up that settles
it.

## Local development

Nothing to configure. The fake Poshmark (`POST /share-listing/<id>`), the fake Mercari and Depop
sites (their edit pages' Save), and the generic fake site (`POST /listings/:id/refresh`) each
refresh a listing in place and move its time, and the fake API marketplace has
`POST /listings/:id/refresh`. The schedule runs in the worker like every other job.

## Data

- `listing_refresh_setting`: one row per account: `cadence`, `custom_hours` (only with
  `custom`), `quiet_start` and `quiet_end` (minutes after midnight, both or neither, never equal),
  and `time_zone` (IANA, required with a quiet window). Deleted with the account.
- `inventory_item.refresh_cadence` and `refresh_custom_hours`: an item's own cadence, null to
  follow the account's.
- `marketplace_operation.kind` gains `refresh` and `origin` gains `auto_refresh`; a refresh's
  `desired` is only `{ "refreshedAfter": "<ISO time>" }`. The last refresh shown on a listing is
  its newest succeeded refresh; nothing else is stored.
