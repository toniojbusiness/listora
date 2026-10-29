# Performance and efficiency

How fast Listora answers, what it costs to run idle, and what each part spends, measured on a
synthetic 2,000-item seller. This page records the measurements of the efficiency pass of
2026-10-25, what was changed because of them (with before and after numbers), what was checked
and left alone, and the levers not taken. Rerun the measurements after a change that could move
them; the tools below are in the repository.

## Tools

- **The synthetic seller** (`apps/api/src/perf/seed.ts`, `seedSyntheticSeller`): one account's
  inventory written straight into the database with set-based SQL, in about 1.5 s for 2,000
  items. Deterministic (hashes of the row number), so two runs measure the same data. Per
  2,000 items: 12,000 ready photos, about 4,600 listings (every listed item on eBay, most also
  on Poshmark, Mercari, or Depop; sold items sold on one and ended on the rest), about 6,900
  operations with 27,500 events, 482 sales with their fee lines and delist runs, 40 open
  assisted tasks (and the done ones), 10,000 audit entries, 20 storage locations, and four
  connections (eBay by API, Poshmark and Mercari automated, Depop assisted).
- **The API benchmark**, `npm run perf:api` (`apps/api/src/perf/bench.ts`): seeds the seller
  and, by default, four more sellers of the same size into the same tables on a scratch database
  (so a query that misses its account index shows), then calls each screen's read endpoints in
  turn through the real app (`buildApp`, driven with `inject`: routing, validation, auth, SQL,
  and serialization, not the network) and prints p50, p95, and max latency, the SQL statements
  per request, the response size, and the bytes sent. Requests accept what the app's
  URLSession accepts (`gzip, deflate, br`), so the bytes sent are compressed as for the app.
  Options: `--items`, `--other-sellers`, `--iterations` (default 100 after 5 warm-up calls),
  `--only <name parts, comma-separated>`, `--json <file>`, and `--encoding <Accept-Encoding>`
  (`identity` for uncompressed answers).
- **The query-count guard**, `apps/api/src/perf/perf.int.test.ts`: every benchmark scenario
  runs against a 150-item seller in the integration suite, and each list endpoint must read a
  page of 100 in exactly as many statements as a page of 2. An N+1 query fails it.

Numbers below are from an Apple M-series laptop running Postgres 18 locally, on a busy machine
(load average around 14 on 12 cores), so single runs are noisy; before and after were measured
in alternating rounds and the steady rounds are quoted. Production adds the network and runs on
much smaller hardware (0.5 vCPU for the API and the worker together in the personal
environment, 0.25 vCPU until 2026-10-28), so read them as relative.

## API and database

At 2,000 items every screen's read is a fixed handful of indexed statements; nothing grows with
the inventory except what a page shows. No endpoint was slow:

| Endpoint (2,000-item seller, 5 sellers in the tables) | p50 ms | p95 ms | SQL statements |
| ----------------------------------------------------- | -----: | -----: | -------------: |
| Inventory, first page (25)                            |    5.4 |    7.8 |              8 |
| Inventory, page 5 (cursor)                            |    4.7 |    6.5 |              8 |
| Inventory, 100 per page                               |    9.9 |   12.0 |              8 |
| Inventory, search (`q`)                               |    5.7 |    7.9 |              8 |
| Inventory, listed on eBay                             |    4.7 |    7.2 |              8 |
| Item detail, listed                                   |    2.6 |    3.9 |             12 |
| Item detail, sold                                     |    2.5 |    4.1 |             16 |
| Today, before                                         |   15.4 |   18.3 |             13 |
| Today, after                                          |   10.1 |   12.8 |             13 |
| Sales feed                                            |    2.9 |    3.8 |              7 |
| Sale detail                                           |    1.5 |    2.0 |              7 |
| Profit, last 30 days                                  |    2.7 |    3.7 |              6 |
| Profit, last 365 days                                 |    4.9 |    6.0 |              6 |
| Tasks                                                 |    4.4 |    5.3 |              3 |
| Operations                                            |    1.1 |    1.9 |              2 |
| Listings                                              |    3.1 |    4.9 |              6 |
| Connections, connection health, usage                 |  < 0.7 |  < 1.1 |              2 |

The statement counts include the two of authentication and tenancy. The largest cost of the
100-item inventory page is serializing its 120 KB, not the database.

What was found and changed:

- **Today's stale-listing query.** It was the slowest statement of any screen (8.2 ms mean).
  Its two subqueries were correlated through `item.account_id`, so Postgres either hashed the
  "no change in 14 days" check over every account's recent operations and listings, with
  sequential scans of both whole tables (a small platform), or ran it once per listed item (a
  larger one). They now name the account as a parameter, and Postgres hashes only this seller's
  recent changes. The statement went from 8 ms mean (up to 15 ms) to about 3 ms with 5 sellers
  in the tables and from 11-14 ms to about 5 ms with 50 (100,000 items, 340,000 operations),
  and the Today endpoint from 15 ms to 10 ms. The card and its query were later removed: listing
  refresh keeps old listings fresh instead ([listing-refresh.md](listing-refresh.md)), and its
  per-listing reads bind the account the same way (`loadRefreshFacts`).
- **Cover photos.** The inventory list and Today read each item's cover with
  `distinct on (item_id) ... order by position`, which reads and sorts every photo of every
  item on the page (6 per item, with their JSON). Photo positions are a gapless sequence from 0,
  so the cover is now the row at position 0: one lookup per item on `(item_id, position)`
  (0.73 ms mean before; under the noise of the endpoint after).

Checked and left as they are:

- **Pagination.** Every list that grows is cursor-paginated (items, listings, operations and
  their events, sales, tasks). Connections and marketplace sessions have one entry per
  marketplace, an item's photos and listings are bounded by the item, Today reads at most 50
  cards of a kind, and the profit dashboard aggregates in SQL and lists only the 5 oldest dead
  items.
- **Indexes.** Every hot statement uses an index that leads with `account_id`. The rest of the
  top statements by time are under 1 ms each at 2,000 items. The task inbox's statement spends
  more time planning (six joins) than running.

## Worker

The worker runs operation steps on Graphile Worker with 5 slots and its other jobs (photos,
analyses, scheduled tasks) with 2 more, and every slot polls the queue on its own. New jobs never
wait for a poll: Graphile Worker hears of them through LISTEN/NOTIFY. Only jobs dated in the
future (retries, read-backs, rechecks) are found by polling, and in production the shortest of
those is 30 s away.

| Idle worker, 120 s (`OPERATION_RETRY_DELAY_SCALE=1`) | Before (2 s poll) | After (5 s poll) |
| ---------------------------------------------------- | ----------------: | ---------------: |
| Queue polls a minute                                 |               216 |               93 |
| All SQL statements a minute                          |               264 |              141 |
| CPU time                                             |  0.24 s (0.2%) \* |    0.20 s (0.2%) |
| Resident memory                                      |        110-200 MB |       110-155 MB |

\* Both within the measurement's noise: the idle worker is already cheap on CPU.

The poll interval is now a sixth of the shortest retry delay, between 2 s and 5 s
(`queuePollIntervalMs` in `packages/operations/src/policy.ts`): 5 s in production, so a retry
or read-back starts at most 5 s late, and still 2 s on the local stack, whose delays are a tenth
of production's. The rest of the idle traffic is the stopped-worker check (12 a minute) and the
minute-by-minute scheduled tasks (the automation dispatch and the delist SLA); nothing else
polls.

Throughput is bounded by the marketplaces, not the worker: an operation step is a marketplace
call followed by a read-back one retry delay later, so 5 slots keep 5 marketplace calls in
flight. Photo processing, the heaviest local job, takes 28 ms of wall time and about 200 ms of
CPU for a 2048 x 1536 upload (measured with 6 libvips threads; 43 ms with 1, which both the
worker and the API now use, see below), with a peak of about 240 MB
for the process, so the personal environment's 0.25 vCPU of then processed an item's 6 photos in about
5 s. The derivatives of such an upload take about 1.5 MB (original 898 KB, listing 463 KB,
AI 165 KB, thumbnail 20 KB at the 400 px of then; the 640 px thumbnail of now is about 2.5
times that).

## AI cost

Checked, nothing changed:

- **Prompt caching is hit.** The system prompt (`ITEM_ANALYSIS_SYSTEM`, about 5,400
  characters, roughly 1,350 tokens) holds every rule and vocabulary and nothing about one item,
  and carries the request's only cache breakpoint (`buildParams` in
  `packages/ai/src/anthropic-provider.ts`; its unit test pins the breakpoint). The minimum
  cacheable prefix is 512 tokens on Claude Haiku 5.5 and Claude Sonnet 5.5, so it caches; every
  call records its cache read and write tokens in `ai_usage_event`, so the operator's AI cost
  report shows the hit rate from real traffic. Analyses of a batch of items within 5 minutes
  read it at a tenth (Haiku) or a twentieth (Sonnet) of the input price.
- **Images are the right size.** The AI sees the 1024 px `ai` derivative of each photo (about
  1,050 image tokens for 1024 x 768) plus at most one sharper tag crop. The app uploads at most
  2048 px at JPEG quality 0.85. Sending 768 px instead would cut image tokens by about 44%, but
  tag text needs the resolution; that is a quality trade-off to decide with the real-provider eval
  (`npm run eval -- --provider anthropic`), which costs money to run, so it was not changed.
- **Nothing calls AI on routine operations.** The only callers of the AI client are the item
  analysis job (started by `startItemAnalysis` and `escalateAnalysis`, once per item, photo-set
  hash, and tier) and the voice correction fallback, which sends (as text) only the phrases the on-device
  rules cannot map ([voice.md](voice.md)). Listing, delisting, sales, Today, and
  every other screen and job make no AI call.

**Cost per item**, estimated from the token counts above at the current price table
(`packages/ai/src/prices.ts`, checked against Anthropic's pricing page on 2026-10-25): an
analysis of 6 photos is about 7,800 uncached input tokens (images, OCR text, tag facts), 1,350
cached ones, and about 1,500 output tokens (the details and four marketplace copies).

| Analysis                              |   Input | Cached prompt |  Output | Per item |
| ------------------------------------- | ------: | ------------: | ------: | -------: |
| Standard (Claude Haiku 5.5)           | $0.0008 |   $0.00001 \* | $0.0008 |  $0.0015 |
| "Identify harder" (Claude Sonnet 5.5) | $0.0156 |    $0.0001 \* | $0.0150 |  $0.0307 |

\* A cache read; the first call in 5 minutes writes it instead ($0.0002 on Haiku, $0.0034 on
Sonnet).

The eval harness, on the fake provider at Haiku 5.5 prices, bills $0.00033 per item analysis
(its fixtures have smaller token counts than real answers). The live cost per item worked on is
in the admin CLI's AI cost report (`npm run admin -- --help`).

## Browser automation runner

Measured with Playwright's headless Chromium (`chromium-headless-shell` 156) on the laptop:

| Step                                               | Time or memory            |
| -------------------------------------------------- | ------------------------- |
| Loading Playwright                                 | 180 ms                    |
| Launching Chromium (first, cold)                   | 2.9 s                     |
| Runner `self-test` (start, launch, one page, exit) | 0.9 s, 250 MB peak        |
| Opening a session (new context and page)           | 40-65 ms                  |
| Memory while a session is open (Node + Chromium)   | about 165 MB + 230-275 MB |
| Memory between sessions                            | about 165 MB + 180 MB     |

The runner already launches Chromium once per process and reuses it for every session, one at
a time; only the browser context is new per session. Reusing contexts would save about 50 ms a
session against steps paced at human speed (seconds), and would let one seller's cookies outlive
their session, so contexts stay per session. The runner is on demand (no task while idle, exiting
2 minutes after its last job), so its cost is its task's hours: unchanged at about $1.48 a
month ([costs.md](costs.md#browser-automation)).

Not changed: the runner reserves 1 vCPU and 4 GB. The measured peak is under 0.5 GB on a light
page; real marketplace pages are heavier, but 2 GB would very likely do. That would save about
$0.19 a month at the estimated 21 hours, too little to risk out-of-memory failures before a
real marketplace page has been measured.

## iOS

- **Remote photos are cached and decoded at display size.** Every screen showed server photos
  with SwiftUI's `AsyncImage`, which keeps no decoded copy: a row scrolled back into view
  downloaded or re-read its photo and decoded it again, at full size (a 400 x 300 thumbnail
  decodes to 480 KB to fill a 72-point square), and the app's shared `URLCache` holds 10 MB on
  disk, a few hundred thumbnails. A 2,000-item inventory's thumbnails are about 130 MB at 640 px. Now
  `RemoteImage` (DesignSystem) shows them: `RemoteImageLoader` fetches through its own 200 MB
  disk cache (public photo URLs are immutable, so cached copies are used whatever their age),
  decodes off the main actor at the smallest size that fills the frame (288 x 216 for a 72-point
  row at 3x: 249 KB), and keeps up to 48 MB of decoded images in memory, so a row that comes
  back shows its photo in its first frame with no download and no decode. The inventory, Today,
  tasks, task detail, review, and batch screens use it. Only photos the server served are kept:
  an error (a thumbnail asked for just after its upload, before the worker made it, answers 404)
  is never cached, and one an older build cached is dropped, so the photo loads the next time
  it is shown instead of staying blank until the cache evicts it.
- **Listing photos load like thumbnails (2026-10-28).** After importing 118 real Depop listings
  (526 photos), the captain found the photos slow. Measured on those photos through the real
  photo CDN, in the simulator on the Mac's Wi-Fi with an empty cache: the Inventory grid, the
  default layout since the Hang Tag redesign, showed each cell's 1600 px listing image (about
  300 KB) because the 400 px thumbnail was too small for a 161-point cell at 3x, and fetched it
  only when the cell scrolled into view; the item screen fetched each listing photo only when it
  was swiped to. Now the thumbnail is 640 px (about 67 KB on these photos), sharp in the widest
  cell, and the grid shows it; the inventory downloads every loaded page's thumbnails at once,
  and the item screen downloads all of the item's photos when it opens and shows the cached
  thumbnail until the large one arrives (`RemoteImage(url:preview:)`,
  `RemoteImageLoader.prefetch`). A photo is downloaded once at a time, so a view that asks
  while its prefetch is on the way waits for it. Photos processed before get the new thumbnail
  from the worker's thumbnail refresh ([photos.md](photos.md)).

  | Same 118 items and photos, cold cache                  |               Before |                 After |
  | ------------------------------------------------------ | -------------------: | --------------------: |
  | Inventory grid, 10 screens scrolled: bytes downloaded  | 19.0 MB for 62 cells | 5.5 MB for all 118 \* |
  | Inventory grid: a cell's wait for its photo, p50 / p90 |      500 ms / 565 ms |         0 ms / 163 ms |
  | Item screen: next photo after a swipe                  |     about 550 ms \** |         1-9 ms (disk) |
  | Relaunch: a photo from the disk cache                  |      6-18 ms (Today) |  22-37 ms (Inventory) |

  \* Every thumbnail of the inventory (and Today's), prefetched, at the 400 px the CDN still held:
  the refresh had not run on them. At 640 px it is about 11 MB, still less than the 62 listing
  images, for all 118 items. \** Three photos measured, 507-595 ms each.
  The relaunch was already served from disk before; on a phone's mobile data the cold numbers
  grow with the bytes, which is where the grid's quarter-size photos matter most.

- **Next pages.** Appending a page checked each new row against every row already shown; it now
  uses a set (2,000 comparisons instead of 100,000 at the 40th page).
- **Uploads are already efficient.** Photos are prepared on the phone as upright JPEGs of at most
  2048 px at quality 0.85 with no metadata (about 0.8 MB for a 2048 x 1536 photo instead of
  3-5 MB from the camera) and uploaded by a background `URLSession` that the system schedules and
  retries, so uploads continue when the app is suspended.
- **Networking is on demand.** The app reads a screen's data when it appears and on pull to
  refresh; it does not poll in the background.
- **A quiet launch and idle app (2026-10-28).** Measured through a logging proxy in front of the
  local stack (`npm run e2e:stack`, 26 listed items, a Dev build on the simulator), from launch
  through 150 s on Today:

  | Window                    | Before                   | After                                   |
  | ------------------------- | ------------------------ | --------------------------------------- |
  | First 10 s (the launch)   | 16 requests, 580,127 B   | 13 requests, 5,747 B                    |
  | `GET /v1/phone-runtime`   | 573,353 B (whole bundle) | 96 B (digest only)                      |
  | `GET /v1/today` at launch | 3                        | 2 (the second follows the opening sync) |
  | Next 140 s, idle          | 25 requests, 1,003 B     | 11 requests, 149 B                      |

  The launch no longer downloads the runtime the app ships (`RuntimeScripts`,
  [phone-execution.md](phone-execution.md)); the idle app no longer claims and checks the
  runtime after every 20-second wait that found nothing (7 of each in 140 s before, none after;
  a safety claim every 5 minutes); and Today loads once as it first appears, reloading only
  when the app comes back from the background. What is left while idle is the wait itself and
  the Tasks badge's 30-second poll.

## Server efficiency pass of 2026-10-28

The read-only efficiency audit of 2026-10-28 found most of production's API traffic and much
of its slowness in three places; all three were changed. Numbers from this laptop under heavy
load (load average 50-57 on 12 cores), so latencies are noisy; request counts and bytes are
exact.

**Response compression** (`apps/api/src/compression.ts`).
No answer was compressed: API Gateway's HTTP API does not compress, though the app's URLSession
accepts gzip and brotli. An `onSend` hook on the root now compresses every JSON, JavaScript, or
text answer of at least 1 KB with brotli (gzip for a client that accepts only that), never a
photo, for a client that asks with `X-Listora-Compression: accepted`. Brotli runs at quality 4:
on a 75 KB inventory page it took 0.19 ms of CPU against 0.31 ms for gzip and 39 ms at brotli's
default quality 11, which the API and worker sharing half a vCPU cannot spare per request. The
benchmark asks (`npm run perf:api -- --items 120 --other-sellers 4 --iterations 60`, then again
with `--encoding identity`):

| Endpoint                | Bytes before | Bytes sent after |
| ----------------------- | -----------: | ---------------: |
| Inventory, first page   |       28,558 |            4,818 |
| Inventory, 100 per page |      119,465 |           16,924 |
| Item detail, listed     |        9,843 |            1,581 |
| Today                   |        2,212 |              813 |
| Sales feed              |       46,096 |            5,586 |
| Tasks, open             |       26,455 |            4,238 |
| Operations              |       13,516 |            1,805 |
| Listings                |       34,893 |            3,137 |
| Connection health       |        4,113 |              924 |

3-11 times fewer bytes on every screen; answers under 1 KB (Usage) go as they are. The perf
integration test checks that every scenario of 2 KB or more is sent at under half its size.

The app asks (`CompressionOptInMiddleware` in `APIClient`); its builds from before it asked
never do, so they get every answer as before whatever their download code does with compressed
answers. The screens read compressed answers fine: the app's own client and transport (the
generated `Client` over `URLSessionTransport`, as `APIClient` builds it, on macOS), against a
300-item synthetic seller at production's sizes, decoded inventory 50 and 100 per page (63 and
123 KB, sent as 9 and 17 KB), item detail, a sold item, sales (97 KB, sent as 11 KB), a sale,
Today, tasks (42 KB, sent as 6 KB), an offer, and connection health, three rounds each, in 3-48
ms. While this was built, `PhoneExecutionUITests` and `LinkAccountsUITests` timed out now and then
(the app never settling, a minute at a time, while a marketplace's sign-in page was open), at
first only on runs with compression, so the app held off asking. They then timed out the same way
on main, with no compression, at a load average of 150-300 from other worktrees; and on a quieter
machine, two rounds each of this branch with the app asking and of main all passed. The stall is
the loaded simulator's, not compression's.

**The item screen waits instead of polling** (`waitForItemChange`,
[operations.md](operations.md#following-a-change)). While a listing's change ran, the item
screen read the item and each listing's operations every second, also while the change waited
for the phone or a retry: 12,083 of production's 17,430 non-health requests in 7 days (70%).
It now holds one wait of up to 20 s that the server answers the moment one of the item's
operations changes, and reads the item only then. One item screen open for 60 s on a Poshmark
listing waiting for the phone, its change failing at 45 s (scratch script driving the real API):

| Item screen, 60 s           | Requests |  Bytes | Change shown after |
| --------------------------- | -------: | -----: | -----------------: |
| Before (read every second)  |       90 | 63,152 |             516 ms |
| After (wait for the change) |        8 |  2,545 |              33 ms |

**One libvips thread** (`limitImageThreads`, in the worker and in the API, which processes the
pack check's photo). libvips used one thread per core, so a burst of photos (an import's 526)
took every core from the requests sharing the task (0.25 vCPU then): `GET /v1/items` p50 went from 15
to 204 ms within a minute of a processed photo. With one thread a 2048 x 1536 photo took 76-85
ms of CPU here against 97-99 ms with 6 (24 photos, two rounds each), and its wall time is the
same or a little longer (61-95 ms against 63-75 ms on this loaded laptop); the work no longer
fans out over several cores at once.

## Cloud cost

The personal environment's monthly estimate is unchanged at about $35, or $36 with browser
automation ([costs.md](costs.md)): none of these changes adds or removes a billed resource or
changes a task size. The quieter idle worker takes database load off the `db.t4g.micro`, whose
only usage charge is CPU above its burst baseline.

## Follow-ups (not done here)

- Profile inventory scrolling with Instruments (Animation Hitches) on a device with a 2,000-item
  account; the image work above is measured in bytes and decodes, not in hitches.
- Returning from an item to the inventory list reloads the first page and drops the pages
  scrolled past; keeping them (and refreshing the item that changed) would keep the position.
- Measure the runner's memory on real marketplace pages, then consider 2 GB.
- Decide the AI image size (768 px) with the real-provider eval.
