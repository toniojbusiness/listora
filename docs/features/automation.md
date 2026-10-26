# Browser automation (decision D1)

How Listora acts on marketplaces without an API it can use (Poshmark, Mercari, Depop until its
partner API is granted, and eBay until Listora's eBay developer keys exist). `@listora/automation` holds the browser runner and everything around it; the
session vault is in `@listora/connections` ([connections.md](connections.md)), next to the
token vault it seals with. The assisted adapters that serve these marketplaces until a seller
links a session, and whenever automation must stop, are in
[marketplaces.md](marketplaces.md#adapter-model).

**Decision D1, revised 2026-10-24.** D1 (the Poshmark and Mercari posture) was "assisted
only". The marketplaces granted the product owner permission to automate where no API exists,
Listora is for the product owner's personal use, and everything runs in the cloud. eBay granted
the same permission for the product owner's own account. So Poshmark, Mercari, Depop (until its
partner API is granted), and eBay (until its API is connected) use cloud browser automation:
the headless-Chromium browser runner (`browserRunner` in `infra/src/config.ts`) acts on
sessions the user logs into from the iPhone app.

- Session cookies are stored encrypted with the token key, by the same envelope encryption as
  OAuth tokens. Passwords never are.
- Actions are human-paced, within per-seller rate limits.
- The runner never solves or bypasses a CAPTCHA or bot check: it stops and falls back to an
  assisted task.
- Every action is still confirmed by read-back ([operations.md](operations.md)), never reported
  as a false success.

The runner, the `automation` mode, the session vault, sale-check scheduling, the Poshmark,
Mercari, Depop, and eBay automation adapters ([poshmark.md](poshmark.md), [mercari.md](mercari.md),
[depop-automation.md](depop-automation.md), [ebay-automation.md](ebay-automation.md)), and linking
from the app
([marketplace-linking.md](marketplace-linking.md)) are built.
[costs.md](costs.md#browser-automation) sizes and prices the runner.

## How it works

- **The runner** (`runner/`) drives Playwright's headless Chromium, one seller session at a time.
  A session is a fresh browser context with that seller's cookies on that marketplace's domains
  only. Adapters run **scripts**: named steps, each with its own timeout, where only the step
  that submits a change `mutates`. Scripts reach the page only through `PageDriver`, which paces
  every action and inspects the page after it, so the safety rules hold whatever a script does.
  `read` runs a script that may not mutate (form input refuses). A failed run leaves one
  screenshot of the viewport with every form field and the profile's private elements blacked
  out, in private storage under `automation/<account>/`, deleted after 14 days or with the
  account; a page off the marketplace's origins is never kept. The browser is honest about what
  it is: Playwright's own headless Chromium and user agent, no stealth, no fingerprint changes.
- **Network rules** (`safety/network.ts`). The runner checks every request and WebSocket before
  Chromium sends it. The main frame may only load the profile's own origins. No request may go
  to a private address: loopback, the private ranges, link-local (where the cloud's metadata
  and task credential endpoints are), or internal host names. Images, scripts, and styles from
  other public hosts (the marketplaces' CDNs) still load. Chromium follows HTTP redirects
  without asking, so a redirect hop is not checked. If a redirect sends the main frame
  elsewhere, the page inspection below stops the run. A run that stops logs its session's
  network, by origin only (`NetworkLog`, `runner/network-log.ts`): the requests these rules
  refused, the responses with an error status, and the requests that failed. So a page that
  broke because of Listora's rules can be told apart from one the marketplace answered with
  errors.
- **Safety rules** (`safety/`, `profiles.ts`). Pacing: a random delay before every action and
  keystroke, and between a seller's sessions, per marketplace (`AUTOMATION_<MARKETPLACE>_*`),
  never below the floors in `profiles.ts`. Rate limits: runs per hour and per day per seller,
  counted in `automation_run` across every runner. Checks: a CAPTCHA widget, a bot-check page
  (titles, wording, a 403), a verification-code step, a login page or password field, or a page
  off the marketplace's own origins (`challenges.ts`) stops the run at once. Nothing after it
  runs, even when a script catches the error: the stop is sticky for the run. The session is
  discarded, the connection becomes `reauth_required` with one `reconnect` task, and the step
  falls back to its assisted task. A 429 or 5xx page stops the run as retryable. Logs and
  history name scripts, steps, and origins only, and error messages never repeat what was
  typed.
- **Sessions** (`RunnerSessions`): for each run, a per-seller advisory lock (no two runners in one
  account), the session vault's session (opened only here; in AWS only the runner's role may
  decrypt the `listora-marketplace-session` purpose), the rate limit and pause, an
  `automation_run` record, then the cookies the marketplace refreshed (`rotate`) or, after a
  check, `markNeedsRelink`. Every session vault write bumps `credential_version` and names the
  version it read, so an older session never overwrites or discards a newer link.
- **The adapter base** (`AutomationAdapter`) turns a marketplace's scripts into a
  `MarketplaceAdapter`: kinds with a script are `automation`, the rest assisted, reads are
  `automation`. It maps every way a run ends onto an outcome and never claims more than it
  knows: only an applied script is `confirmed`, a failure after a mutating step is `unknown`,
  one before it `transient`, a marketplace validation message `rejected`, and a check, a missing
  session, or a page the script no longer understands the assisted task (a script throws
  `PageChangedError` when a page's data is not what it reads, which ends the run as
  `element_missing`). The fake site's adapter (`fake-site/`) is the reference and passes the
  shared conformance suite in a real browser.
- **Poshmark** (`poshmark/`, [poshmark.md](poshmark.md)) is automated on poshmark.com, or on the
  fake Poshmark with `FAKE_POSHMARK_URL`. With only `FAKE_AUTOMATION_SITE_URL` set, development
  drives the fake site instead, so a development setup never drives a real marketplace.
- **Mercari** (`mercari/`, [mercari.md](mercari.md)) is automated on mercari.com, or on the
  fake Mercari site with `FAKE_MERCARI_SITE_URL`. With only `FAKE_AUTOMATION_SITE_URL` set,
  development drives the fake site instead.
- **Depop** (`depop/`, [depop-automation.md](depop-automation.md)) is automated on depop.com, or
  on the fake Depop site with `FAKE_DEPOP_SITE_URL`, for sellers whose Depop connection is a
  browser session; one that uses Depop's API gets the API adapter. With only
  `FAKE_AUTOMATION_SITE_URL` set, development drives the fake site instead.
- **eBay** (`ebay/`, [ebay-automation.md](ebay-automation.md)) is automated on ebay.com, or on the
  fake eBay site with `FAKE_EBAY_SITE_URL`, for sellers whose eBay connection is a browser
  session; one that uses eBay's API gets the API adapter, and both address the same listings by
  item number and SKU. With only `FAKE_AUTOMATION_SITE_URL` set, development drives the fake site
  instead.
- **Routing.** The automation adapters join the marketplace adapters
  (`createMarketplaceAdapters`, its `automation` setting): a marketplace's
  `ConnectionAwareAdapter` serves its automation adapter under an `automation` connection whose
  session works (`connected` or `degraded`), its API adapter (eBay, Depop) under an `api`
  connection, and its assisted adapter otherwise ([marketplaces.md](marketplaces.md#adapter-model)).
  The API builds no automation adapters, so it reports an automation connection's steps as
  assisted. The worker and the runner build the same
  automation adapters (the worker's have no browser), so both route each operation to the same
  mode.
- **Where it runs.** Automated steps need a browser, which only the runner has. The worker hands
  such a step to the runner's task on the same listing queue ([operations.md](operations.md))
  and starts the runner (`launcher.ts`): locally as a child process, in AWS by setting the
  runner's ECS service to one task. A runner holds a Postgres session named
  `listora-browser-runner:<id>`, takes only automated steps, sale checks, and session checks (`RUNNER_TASKS`), one at a time, and
  exits after `RUNNER_IDLE_EXIT_SECONDS` with nothing to do, scaling its service back to zero.
  The worker's `automation_dispatch` task runs every minute: it queues due sale checks, starts
  the runner when its work waits and none is alive, and prunes old run records and
  screenshots.
- **Sale checks** (`sale-checks/`). Each automation connection has a `sale_check_schedule` row.
  A check reads the seller's sold orders through their session and hands each new one to the
  sale intake: in one transaction, an `inbound_event` (source `poll`, one per order) and the
  worker's `automation_sale_order` job (`sale-checks/orders.ts`). The worker records the sale
  there (`recordSale`, [ebay-notifications.md](ebay-notifications.md)) when a line is a Listora
  listing, which starts its auto-delist ([auto-delist.md](auto-delist.md)), and finishes the
  event `processed` or `ignored`. The worker records it, not the runner, because the auto-delist
  fan-out decides from each listing's capabilities whether it is marked sold or ended, and only
  the worker's adapters include the API adapters. The next check is due when the expected sales since now reach what an average
  default interval holds (`interval.ts`): every 12 hours by default, sooner over the hours and
  days the seller's sales on that marketplace usually happen and while items are hot, later when
  idle, within `SALE_CHECK_MIN_HOURS` and `SALE_CHECK_MAX_HOURS`. A forwarded sale email asks for
  a check at once (`requestSaleCheck`). A check that met a check waits for the relink. A
  marketplace whose adapter reads no orders yet is checked at the longest interval, without
  starting the runner.
- **Linking** (`linkAutomationSession`, called by the API's `linkMarketplaceSession`) stores the
  cookies the app captured (on the marketplace's domains only), revives the connection, moves the
  marketplace's unconnected listings to it, asks the runner for a read-only **session check**
  (`session-checks/`), and makes a first sale check due at once; relinking takes the same way.
  The app shows a marketplace as linked only after its session check passed, on Link accounts and
  Marketplaces alike. The flow, from the app's sign-in web view to the check, is in
  [marketplace-linking.md](marketplace-linking.md).
- **Hosting.** The runner is the compute stack's `runner` service, from the Dockerfile's
  `runner` stage (the application's files on top of headless Chromium, its own ECR repository),
  with no task while idle and never two at once ([infra.md](infra.md)). A session the runner's
  browser cannot open (Chromium did not start) ends as `browser_unavailable`: a failure on
  Listora's side, never reported as the marketplace's answer.

## Local development

`scripts/dev-browser.sh` installs the headless Chromium build Playwright pins into
`.local/playwright`. Set `FAKE_AUTOMATION_SITE_URL` and start `npm run dev:fake-site`: Poshmark,
Mercari, Depop, and eBay connections that hold a linked session are then automated against that
local site. The worker starts the runner as a child process whenever automated work waits
(`BROWSER_RUNNER_LAUNCH=process`, the local default), or run it by hand with
`npm run dev:runner` (`none`). The runner needs the token vault's key (`TOKEN_ENCRYPTION_KEY`
locally), because every session it opens is sealed.

The fake site (`FakeAutomationSite`) serves listing, search, order, and photo pages, and injects
faults: a CAPTCHA, a bot check, a login challenge, an expired session, a rate limit, a server
error, a validation refusal, a slow page, a stale read, and an off-site redirect. Tests never
contact a real marketplace. Like the database, a missing browser fails the browser tests; it
never skips them.

| Switch                                       | Effect                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `FAKE_AUTOMATION_SITE_URL`                   | The fake site serves each marketplace without its own fake              |
| `FAKE_POSHMARK_URL`                          | The Poshmark adapter drives the fake Poshmark instead of poshmark.com   |
| `FAKE_MERCARI_SITE_URL`                      | The Mercari adapter drives the fake Mercari site instead of mercari.com |
| `FAKE_DEPOP_SITE_URL`                        | The Depop adapter drives the fake Depop site instead of depop.com       |
| `FAKE_EBAY_SITE_URL`                         | The eBay adapter drives the fake eBay site instead of ebay.com          |
| `AUTOMATION_STEP_TIMEOUT_MS`, `_CALL_`       | One script step's timeout, and one automated call's                     |
| `AUTOMATION_<MARKETPLACE>_*`                 | Pacing, the pause between sessions, and the per-seller rate limits      |
| `SALE_CHECK_DEFAULT_HOURS`, `_MIN_`, `_MAX_` | The sale-check interval without history, and the adapted one's bounds   |
| `BROWSER_RUNNER_LAUNCH`, `BROWSER_RUNNER_*`  | How the worker starts the runner (`process`, `ecs`, or `none`)          |
| `RUNNER_IDLE_EXIT_SECONDS`                   | How long the runner stays up with nothing to do                         |
| `PLAYWRIGHT_BROWSERS_PATH`                   | Where the headless Chromium is installed                                |

## Data

- **`marketplace_connection`** (in [connections.md](connections.md#data)) gains the `automation`
  mode. An automation connection keeps its browser session in `token_ciphertext`, sealed as the
  token vault's `session` kind, and holds a session exactly while it is `connected` or
  `degraded`: one waiting for a relink holds none, so nothing retries around a check (a
  database constraint). `credential_version` is bumped by every session write (link, rotation,
  relink), so a runner holding an older session never overwrites a newer one.
- **`automation_run`**: one browser session the runner opened, for an operation step, a sale
  check, or a health check: the script, its outcome, the check it met (`challenge_kind`), the
  failed step, an error code, and the key of its redacted screenshot (deleted with the
  account). It is the per-seller rate limits' count, and the record of what automation did and
  where it stopped.
- **`sale_check_schedule`**: when each automation connection is next checked for sales and why
  (`scheduled`, `email`, `retry`, or `linked`), the last check's time and outcome, and the
  newest order time it has seen.
- **`session_check`**: whether the newest session linked on each automation connection works:
  pending, passed, or failed with a reason ([marketplace-linking.md](marketplace-linking.md)).
