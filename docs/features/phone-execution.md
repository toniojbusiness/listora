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
  `watch.ts`).
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
   job. Session checks, sale checks, and read-only reads of the sold history
   ([activity.md](activity.md)) do the same. A delist after a sale goes first (`priority`), and a
   history read waits behind routine changes.
2. **Claiming.** The app claims the next work for its device (`POST /v1/phone-runs`). The claim
   is a lease (10 minutes, renewed by every answer). One run per connection at a time, and the
   runner's per-seller rate limits and pause between sessions apply, counted in
   `automation_run` (`host = 'phone'`) with the runner's runs. A device whose runtime speaks
   another call version is told to update the app (`app_update_required`) and gets nothing. A
   claim that finds nothing says when to claim again (`nextClaimInSeconds`): when the device's
   next work is due (a check tried again after a failed attempt), at most 10 seconds while
   marketplaces run on it (`PHONE_IDLE_CLAIM_SECONDS`), and 5 minutes when none does.
3. **Calls.** The server runs the work itself: the executor's phases, the adapters, and the
   checks' own code, with sessions answered from the phone's answers. The first script call
   without an answer is handed to the phone; the phone runs it and answers
   (`POST /v1/phone-runs/{runId}/calls/{index}`, idempotent); the server runs the work again
   from its start with one more answer. Work whose calls are all answered records its result
   there and then, by the same rules as the runner's (read-back before success, freshness,
   retries, the fallback to an assisted task).
4. **Lapsed runs.** A phone that stops mid-run (the app killed, the phone offline) lets the
   lease lapse. An operation step is recovered like any interrupted step: its job finds the
   lapsed run and a read-back decides. A check waits for the phone again. A call never answered
   is finished in `automation_run` as canceled.
5. **Waiting too long.** An operation that waits for the phone longer than 24 hours fails with
   `phone_unavailable` and a Retry. Until then its status says so: "Delisting... waiting on your
   iPhone (12 minutes)", with a detail asking the seller to open Listora.

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

- **While the app is open** it runs the work waiting for this phone at once, then claims again
  whenever the server says (`PhoneRunner.follow`). So work queued or due meanwhile (a check tried
  again 30 seconds after a failed attempt, a sale check, a delist after a sale) starts within
  seconds without a push, which iOS may drop and a build signed with a personal team never gets.
  A run started during that wait (linking, a change in the app) ends it, and the next look follows
  what that run's last claim said: an app opened before any marketplace ran on it is told 5
  minutes, and once the seller links one, 10 seconds.
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

The runner runs one batch at a time; a trigger during a run makes it look again once the run
ends. Signed out, it runs nothing.

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
  long), a check tried again once due and when the phone is told to claim, lapsed leases,
  idempotent answers, the runtime version, and the refused move of a marketplace that blocks
  the cloud.
- **App, unit** (`PhoneExecutionFeatureTests`): the runner's loop, one run at a time, retried
  answers, registration, and claiming again when the server says while the app is open; Link
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
- `phone_work`: work handed to the phone (an operation step, a session check, a sale check, or a
  history read), since when it waits, its lease, and the answered calls of the run under way.
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
