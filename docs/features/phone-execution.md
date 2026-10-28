# On-phone execution

Some marketplaces refuse Listora's cloud browser: Depop blocks the runner's address, Mercari
shows it a bot check, and Poshmark serves its signed-in pages without their data ("Something
went wrong"). Relinking cannot fix any of that. So their automated steps run in the iPhone app
instead, in the seller's own session, on their own device and network. Only eBay stays in the
cloud, on its API. Each connection says where its automated steps run, and a marketplace can
move back to the cloud once configuration allows the cloud for it again.

The server keeps one operation queue and decides every outcome. The phone only runs the same
marketplace scripts the browser runner runs ([automation.md](automation.md)) and reports what
each one saw. A change is shown as done only once the server has the phone's read-back
([operations.md](operations.md)).

Code:

- `packages/automation/src/phone/`: the phone runtime (`runtime.ts`, bundled for the app by
  `npm run phone:bundle` into the app's `phone-runtime.js`), its page backend (`backend.ts`,
  `dom.ts`), and the server's half of phone runs (`work.ts`, `transcript.ts`, `answers.ts`,
  `watch.ts`, and `signals.ts`, which wakes the open app's wait for work).
- `packages/operations/src/phone-queue.ts`: operation steps handed to the phone.
- `apps/api/src/phone/`: device registration and the phone-run routes.
- `packages/push`: the APNs driver and background pushes ([push.md](push.md)).
- The app's `PhoneExecutionFeature` (the runner, the runtime host, the check hand-off, the
  background tasks) and `Core/Phone` (the installation id and the sessions the phone keeps).

## Where a marketplace runs

- **Execution location.** `marketplace_connection.runs_on` is `cloud` or `phone`, and
  `phone_device_id` names the phone that runs it: the one the seller linked the marketplace on.
  Poshmark, Mercari, and Depop default to `phone` (`profiles.ts`, overridable per marketplace with
  `AUTOMATION_<MARKETPLACE>_RUNS_ON`). eBay automation and every API or assisted step stay where
  they always run. `PUT /v1/connections/{marketplace}/execution` moves one marketplace, and the work that
  waits (and no phone runs at the moment) moves with it.
- **Whether the cloud is allowed.** Each profile's `cloudAllowed` says whether a marketplace may
  run in the cloud at all: false for Poshmark, Mercari, and Depop, which refuse the cloud runner,
  true for eBay (`AUTOMATION_<MARKETPLACE>_CLOUD_ALLOWED` changes it, so a marketplace can go back
  to the cloud without an app update). The connection's `execution.cloudAllowed` carries it, with
  `cloudBlockedReason` ("Depop blocks cloud servers, so Listora runs it from your phone") while
  it is false. The app then offers no "Run in the cloud" and shows that reason, and the API
  refuses a move to the cloud with `409 marketplace_action_unavailable`. A connection already in
  the cloud can still move to the phone.
- **Status from one source.** The connection's `execution` (in `listConnections`,
  `getConnection`, `listMarketplaceSessions`, and the health summary) says where it runs
  ("Runs on your iPhone", the device's name, how many changes wait and since when), and the
  status display says what the phone found: `Linked` (runs from your iPhone), `Checking on your
iPhone...` while its check waits for the phone (saying so when it tries again after an attempt
  that didn't get through), or `Link on your iPhone` while no phone holds a session for it
  (whatever the cloud found before). A marketplace that runs on the phone never asks the seller
  to sign in again unless the phone's own check found the session signed out. Link
  accounts and Marketplaces show "Runs on this iPhone" for this installation's marketplaces, and
  Marketplaces has a button to move each one where the cloud is allowed.
- **Linking.** The app registers its device (`registerDevice`, keyed by an installation id kept
  in the Keychain) before it sends a sign-in, and the link names that installation. The phone
  keeps the sign-in's own cookies in its Keychain (readable after first unlock, never synced),
  so it can act in the session; the server keeps its sealed copy as before. The session check
  then runs on the phone, at once.
- **The phone's sessions belong to one Listora account.** Signing in to another account on the
  phone removes them, and so does deleting the account. Every run stores the cookies the
  marketplace refreshed.

## How a phone run works

1. **Handing over.** When the engine would enqueue a browser runner step for a connection that
   runs on the phone, it writes a `phone_work` row instead and keeps the operation's status and
   job. Session checks, sale checks, read-only reads of the sold history
   ([activity.md](activity.md)), the pages of a listing import ([imports.md](imports.md)), reads
   of the buyers' offers and the seller's answers to them ([offers.md](offers.md)) do the same. A delist after a sale goes first (`priority`), and a history read and an import page
   wait behind routine changes.
2. **Claiming.** The app claims the next work for its device (`POST /v1/phone-runs`). The claim
   is a lease (10 minutes, renewed by every answer). One run per connection at a time, so the
   app runs marketplaces side by side: it claims once for every marketplace with no run under
   way, naming the runs it still runs (`running`); a run the device holds that it does not name
   stopped (the app was closed mid-call) and is recovered at once. The runner's per-seller rate
   limits and pause between sessions apply, counted in `automation_run` (`host = 'phone'`) with
   the runner's runs; the pause comes before a run's first call only, since its later calls (a
   send's read-back) are the same visit. A device whose runtime speaks another call version is
   told to update the app (`app_update_required`) and gets nothing. A claim that finds nothing
   says when to claim again (`nextClaimInSeconds`): when the device's next work is due (a check
   tried again after a failed attempt, a change the engine is about to hand over), at most 5
   seconds while marketplaces run on it (`PHONE_IDLE_CLAIM_SECONDS`), and 5 minutes when none
   does. Work behind a marketplace's run under way doesn't count: its lane claims when it ends.
   **While the app is open** (`appOpen`), the device's changes waiting out a backoff run at once,
   each once its last step is 3 seconds behind (`OPEN_APP_GAP_MS`, so two read-backs stay
   apart), as Try now runs them (their history says `try_now`, `app_open`). A wait the
   marketplace asked for (a 429) or Listora's pacing set (`automation_paced`, `automation_busy`)
   stands.
3. **Read only.** A write script on a read-only connection is never handed to the phone: the
   server answers it itself, and every call it does hand over says `readOnly`, which makes the
   runtime refuse a write before any step ([read-only.md](read-only.md)).
4. **Calls.** The server runs the work itself: the executor's phases, the adapters, and the
   checks' own code, with sessions answered from the phone's answers. The first script call
   without an answer is handed to the phone; the phone runs it and answers
   (`POST /v1/phone-runs/{runId}/calls/{index}`, idempotent); the server runs the work again
   from its start with one more answer. Work whose calls are all answered records its result
   there and then, by the same rules as the runner's (read-back before success, freshness,
   retries, the fallback to an assisted task).
5. **Lapsed runs.** A phone that stops mid-run (the app killed, the phone offline) lets the
   lease lapse. An operation step is recovered like any interrupted step: its job finds the
   lapsed run and a read-back decides. A check waits for the phone again. A call never answered
   is finished in `automation_run` as canceled.
6. **Waiting too long.** An operation that waits for the phone longer than 24 hours fails with
   `phone_unavailable` and a Retry. Until then its status says what the seller can do: "Delisting... open
   Listora on your iPhone", with a detail asking them to open it (how long it waited is not shown).

## The phone runtime

`runtime.ts` is the browser runner's own code bundled for the phone: the same marketplace
scripts (`<marketplace>/scripts.ts`), the same session core (`runner/script-session.ts`: pacing,
an inspection after every action, read-only reads, sticky stops), and the same result shape.
Only the page backend differs. The app runs the bundle in a hidden controller web view and
gives it the marketplace page through one message handler. The app only relays: it loads
pages, evaluates the runtime's page functions in an isolated script world, reads the page's own
data (`pageData`, one fixed read of a page global, in the page's own world, the only place that
data lives), reports the main frame's navigations, HTTP status, and dialogs, fetches listing
photos, and hands checks to the seller. Every rule stays in the runtime.

- **A page load during a read.** A click that loads a page (Poshmark's Update, read live on
  2026-10-27) can cut short the page function that runs next, and its answer is lost with the
  old page. The host reports that as `navigated`, and the runtime runs the read again on the new
  page once it has loaded, within the step's wait; a click the page navigated away from counts as
  done. Only reads are run again: an action that changes the page (filling, picking, uploading)
  is never repeated. The browser test host reports Playwright's "Execution context was destroyed"
  as `navigated`; the iPhone app reports WebKit's own message, so a lost read there still ends
  the step (open item).

- **No keyboard in the background.** The web views live in a window of their own, behind the
  app's, that can never become the key window, which the keyboard follows: a page that focuses
  one of its fields while Listora works never brings up the keyboard or its bar. The check
  hand-off moves the page into a visible window, where the seller types as usual.
- **One lane per marketplace.** Each marketplace runs in web views of its own (a controller page
  and its marketplace page), so marketplaces run side by side. While the app is open, each
  marketplace's page stays between calls (blank, still signed in, its WebKit process and cache
  warm; the app makes them for the marketplaces it holds a session for as it opens), so a call
  starts at once; a session that changed meanwhile (a relink, another account) gets a new page,
  and the pages go when the app leaves the foreground or iOS warns of low memory. Listing
  photos are the server's `listing` image, sized and compressed once when the photo was
  processed ([photos.md](photos.md)); the app downloads each one once and hands it to every
  marketplace that posts it.
- **Progress.** Each step the runtime starts goes to the app (`progress`, never waited for): the
  step in plain words ("Adding the photos", from the script's step name) and its number. The item
  screen's card for that listing shows it while the phone works on its change, each
  marketplace's on its own card: the step, "Step 4 of 9", and "Working on your iPhone, about 40
  seconds left", estimated from the same call's step times the last time it ran to the end on
  this phone (kept in the app's defaults, per marketplace and call). The phone stays awake while
  any marketplace works. Each answer also carries its
  steps' times (`stepMs`), which the server logs for every call (`phone call answered`, with
  the marketplace, the call, and each step's milliseconds).
- **The marketplace page** is an off-screen `WKWebView` with a data store of its own, filled
  with the cookies the phone keeps. It asks for desktop pages at a desktop size, as Safari's
  "Request Desktop Website" does, so the marketplaces serve the pages the scripts read. It is
  WebKit, as it says: no disguised user agent, no fingerprint changes, no proxy. The main frame
  may load only the marketplace's own origins; a window the site opens is not opened.
- **Checks are handed to the seller.** A CAPTCHA, a bot check, a login code, or a sign-in page
  stops the run, and the app shows that page in a visible in-app browser above every screen:
  "Depop wants to check it's you. Complete the check below, then tap Done." The seller completes
  it themselves. Done runs the call again from its start when it had changed nothing yet. Not
  now, or a check met while the app is in the background, ends the run as `stopped_for_check`:
  the work waits and retries later, and the seller gets a local notification. A sign-in page the
  seller declined counts as the check itself, which asks them to link again. Listora never
  solves, skips, or hides a check.

## When the phone runs

- **While the app is open** it runs the work waiting for this phone at once, without its backoff
  (`appOpen`), then waits for its next work (`GET /v1/phone-runs/wait`, `waitForPhoneWork`) and
  claims again as soon as the server answers, and whenever a marketplace's run ends
  (`PhoneRunner.follow`), even while other marketplaces run. The server answers the wait the
  moment work for the phone may be claimable: `phone_work` notifies the `phone_work` channel with
  the account's id when work is handed over, comes due, or its claim ends (a trigger), and the
  API, listening on its own connection (`listenForNotifications` in `@listora/db`), wakes the
  account's waits; it also answers when work it knows of comes due, and otherwise after 20
  seconds (`PHONE_WAIT_MAX_SECONDS`, under the API gateway's 30-second limit). So a delist after a
  sale starts within a second of the engine handing it to the phone, without a push, which iOS
  may drop and a build signed with a personal team never gets. The app looks at most once a
  second; while the API's notification connection is down, a wait looks every 5 seconds
  (`PHONE_IDLE_CLAIM_SECONDS`), as claims did before, and an app that can't reach the wait (an
  older server) sleeps what its last claim said: an app opened before any marketplace ran on it
  is told 5 minutes, and once the seller links one, 5 seconds or sooner. A trigger during a wait
  (linking, a change in the app) ends it. Nothing is claimed by a wait, so one the app gives up on
  leaves nothing behind.
- **After a change in the app**: linking a marketplace, Check again, publishing, changing a
  price, ending, relisting, retrying, recording a sale, and choosing what to relist.
- **A push.** A sale whose delists run on the phone sends a visible, time-sensitive notification
  that says what sold and "Tap to delist it on Depop from your iPhone."; tapping it opens the app,
  which runs the delists. The same notification also asks iOS to wake the app
  (`content-available`), and the worker's watch sends a background push for work that waits,
  at most every 15 minutes per account. iOS throttles and may drop both, so nothing depends on
  them.
- **Background app refresh** (`com.listora.phone-work.refresh`) and an overnight
  `BGProcessingTask` that needs external power and network (`com.listora.phone-work.processing`),
  for larger batches such as relists and price drops while the phone charges.

A trigger during a claim makes the runner look again once the claim ends, and a marketplace whose
run ends claims its next work at once. Signed out, it runs nothing.

## Speed

Measured on the captain's phone runs (the `phone call answered` step times, 2026-10-26): a Depop
delist was its End (about 8 s), a read-back after the pause between sessions (5 to 20 s then),
and the confirming read 30 to 40 s later (the engine's check 15 s on, the handover, the app's
next look, the pause again); a listing spent most of its minute in pacing (0.8 to 2.5 s before
every action); a retry after a failure waited its backoff even with the app open; and the
marketplaces ran one after another. What makes them fast now:

- pacing of a practiced seller (`DEFAULT_PACING`, [automation.md](automation.md)): 0.45 to 1.1 s
  per action, 2 to 4 s between sessions, and no pause inside a run;
- no lookup before a create unless an earlier attempt may have posted
  ([operations.md](operations.md), idempotent re-execution);
- marketplaces side by side, delists first, each in a warm web view;
- the open app runs work at once: a change it queues is claimed within a second of the engine
  handing it over, and a retry or a confirming read runs 3 s after the step before it;
- the open app hears of new work at once: a delist after a sale (or any work) handed to the phone
  ends the app's wait the moment its transaction commits, where it used to wait for the app's
  next look, up to 5 seconds later ("When the phone runs");
- End and Relist on Mercari and Poshmark load one page before they act, and Poshmark's End,
  Relist, and Change price don't read the listing again before the read-back does: about 11 s
  less per Poshmark End or Relist and 6 s less per price change ([poshmark.md](poshmark.md)).

The targets: a delist about 15 s after the app opens, a listing 45 to 60 s per marketplace, every
marketplace at once.

On the captain's iPhone (2026-10-27, a Shaka Wear tee, from the tap to the marketplace's
confirmed read-back): a listing took 32 s on Depop (about 61 s before), 29 s on Mercari (36 s),
and 44 s on Poshmark (about 2 minutes under its review before); End all ended all three side by
side in 11 to 13 s.

## Local development

- `npm run phone:bundle` rebuilds the app's `phone-runtime.js`; a test fails when the
  committed bundle is out of date.
- The fake sites ([poshmark.md](poshmark.md), [mercari.md](mercari.md),
  [depop-automation.md](depop-automation.md)) serve the phone too. The local stack
  (`packages/e2e`) starts a fake Depop site, and its control endpoint can make it show a check
  (`POST /depop/faults`) or queue a Depop listing for the phone (`POST /items/depop`).
- `AUTOMATION_<MARKETPLACE>_RUNS_ON=cloud` keeps a marketplace's new connections in the cloud.
- Push: `PUSH_DRIVER=fake` logs what would be sent ([push.md](push.md)). A build signed with a
  personal team has no push entitlement and simply gets no token; everything else works.

## Tests

- **Conformance** (`phone/conformance.int.test.ts`): each marketplace's adapter conformance
  suite runs against its fake site through the phone runtime, with headless Chromium standing
  in for the app's web view (the app's own web view is in the end-to-end tests below).
- **Server** (`phone/work.int.test.ts`, `apps/api/src/phone/phone.int.test.ts`): routing per
  connection, the lifecycle (waiting for the phone, running, verified, failed, waiting too
  long), a check tried again once due and when the phone is told to claim, one run per
  marketplace side by side and the recovery of runs the app no longer names, no pause inside a
  run, the open app running backoffs at once but not pacing waits, lapsed leases,
  idempotent answers, the runtime version, the refused move of a marketplace that blocks
  the cloud, and the open app's wait: answered within a second of a delist handed to the phone
  or a claim ending, not by a lease renewal, every few seconds without notifications, and at its
  end when nothing comes (`db/src/notifications.int.test.ts`: notifications only on commit, and
  listening again after the connection is cut).
- **App, unit** (`PhoneExecutionFeatureTests`): the runner's loop, the claim the moment the
  server answers the wait (at most one look a second, and the claim's own wait from a server
  without one), marketplaces side by side and
  one run per marketplace, the runs named in each claim, a free marketplace claiming at once,
  each marketplace's progress, warm web views while the app is open, retried answers,
  registration, and claiming again when the server says while the app is open; Link
  accounts and Marketplaces show where each marketplace runs and trigger the phone; Marketplaces
  offers the cloud only where the server allows it (`MarketplaceExecutionTests`).
- **App, end to end** (`PhoneExecutionUITests`, on the local stack): linking Depop on the fake
  Depop site and its check on the phone; a bot check handed to the seller, completed, and the
  run going on; a listing published and ended from the phone, waiting on the phone while the
  app is closed.

## Data

- `app_device`: the seller's devices: installation id, name, app version, runtime version, the
  APNs token and environment.
- `marketplace_connection.runs_on` and `phone_device_id`: where a connection's automated steps
  run.
- `phone_work`: work handed to the phone (an operation step, a session check, a sale check, a
  history read, an import page with its `import_id`, a read of the offers, or an answer to one
  with its `offer_response_id`), since when it waits, its lease, and the
  answered calls of the run under way. A trigger (`phone_work_notify`, migration
  `20261027195355_phone_work_notify`) notifies the `phone_work` channel with the account's id when
  work is inserted, or its due time moves or its claim ends; a claim renewing its lease notifies
  nobody.
- `automation_run.host`: `runner` or `phone`.

## Open items

- Infrastructure: the APNs key (`APNS_*`) in Secrets Manager and `PUSH_DRIVER=apns` in the
  deployed environment.
- A new runtime version needs an app update; until the phone has it, its work waits.
- Background runs are best effort: iOS decides when the refresh and processing tasks run, and
  a web view in the background may be suspended mid-call (its lease then lapses and the work
  is recovered).
- A failed phone run keeps no screenshot (the runner's screenshot rules would need a phone
  equivalent); the server logs its step and reason (`automation script stopped`, `host: phone`)
  as the runner logs its own, and its run record keeps its steps and their times
  ([activity.md](activity.md)).
- The iPhone app does not yet report a read a page load cut short as `navigated` (WebKit's
  message for it has not been read on a device), so there such a read still ends the step.
