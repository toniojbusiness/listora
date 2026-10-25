# Full-stack end-to-end suite

Plan task T-27. One suite drives the iPhone app on the simulator against everything the backend
has, with every external service on its fake: photos to an AI draft, review, price, and save;
listing on eBay and Depop through their APIs and on Poshmark and Mercari by browser automation;
a sale from eBay's notification and the auto-delist after it; a delist that fails and its Retry;
a CAPTCHA that stops automation; marking an item sold by hand; and a connection that needs the
seller. It is the definition of "working" end to end, so it runs nightly and on demand, not on
every pull request.

Code: `apps/ios/ListoraUITests/FullStackUITests.swift` (the tests), `E2EStack.swift` (their
handle on the stack), `apps/ios/ListoraUITests/FullStack/FakeAI/` (the fake AI's answer), and
`packages/e2e` (the stack: `stack.ts`, `marketplaces.ts`, `control.ts`, `seed.ts`).

## Running it

```sh
npm ci && scripts/dev-db.sh   # once (README setup)
make e2e-full                 # IOS_SIMULATOR='<name>' for another simulator
```

`make e2e-full` installs the browser runner's Chromium if it is missing (`scripts/dev-browser.sh`),
starts the full stack, runs only `FullStackUITests` on the simulator, stops the stack, and names
the tests that failed or passed only on a retry, like `make ios-test` (the flaky test rule in the
[README](../../README.md#ci)). Each test may take 10 minutes. Results and the kept screenshots are
in `.build/ios/E2EFull.xcresult`; the API's and the worker's logs (with the runner's, which the
worker starts) are in `.build/ios/e2e-full-logs`. Under `make ios-test` the suite skips: that
stack has eBay only.

The stack alone, for exploring by hand or with curl:

```sh
npm run e2e:stack -- --marketplaces all --fake-ai-fixtures apps/ios/ListoraUITests/FullStack/FakeAI
```

It prints the API URL, both sellers' session tokens, and the control URL, and runs until Ctrl-C.

## The full stack

`startLocalStack({ marketplaces: 'all' })` is the stack `make ios-test` uses
([architecture.md](../architecture.md#7-testing-and-ci)) with every marketplace added:

| Part                    | What it is                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database                | A scratch database on the `scripts/dev-db.sh` cluster, migrated, dropped at the end                                                                          |
| API, worker             | `apps/api` and `apps/worker` from this checkout, as child processes                                                                                          |
| Browser runner          | Started by the worker as its child (`BROWSER_RUNNER_LAUNCH=process`), kept up for the run                                                                    |
| eBay                    | The fake eBay, with the seller connected through its consent page, delivering eBay's signed notifications to the API's `/webhooks/ebay`                      |
| Depop API               | The fake Depop, with the seller's `api` connection bound to its development seller (`DEPOP_USER_CONNECTION_ID`, until Depop connect exists)                  |
| Poshmark, Mercari       | The fake Poshmark and the fake Mercari site, with sessions linked as the app's linking does (`linkAutomationSession`)                                        |
| Depop automation        | The fake Depop site, for a second seller whose Depop is a linked session (an API connection always takes precedence, so the first seller's Depop is the API) |
| AI, storage, auth, push | The fake AI provider, local photo storage, dev sign-in for both sellers, the recording push sender                                                           |

Automation runs at the fastest pace and the most runs the safety rules allow (`PACING_FLOOR`,
`LIMITS_CEILING` in `@listora/automation`), so a listing takes seconds; no setting goes past them.
Operation delays are a tenth of production's (`OPERATION_RETRY_DELAY_SCALE`).

### The control endpoint

The tests run in the simulator and cannot reach the fakes' in-process controls, so the stack
serves the few they need on 127.0.0.1 (`packages/e2e/src/control.ts` lists every route): seeded
items (ready, or live on chosen marketplaces and confirmed there), faults on the fake eBay, the
fake Depop, and each fake site (a CAPTCHA, a login challenge, a refusal, a server error), a buyer
buying an item's eBay listing (which makes the fake eBay send its notification), and a fresh
linked session. Nothing in the app calls it.

## The scenarios

Every status a test waits for is the server's label, which says "confirmed by" only after the
marketplace was read back.

| Test                                                                 | Scenario                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testPhotosToListedEverywhereThenAnEbaySaleDelistsTheRest`           | 1, 2: fixture photos, the AI draft, review, cost, price, save; List with all four chosen; each "Active (confirmed by ...)"; an eBay sale by notification; eBay sold, Depop marked sold, the others delisted |
| `testADelistThatFailsOnOneMarketplaceShowsRetryAndTheRetryDelistsIt` | 3: Poshmark refuses the delist after an eBay sale: "Delist failed - Retry" with Poshmark's reason; Retry delists it and the run is "Delisted everywhere"                                                    |
| `testACaptchaStopsAutomationForATaskAndTheConnectionNeedsRelinking`  | 4, 6: a CAPTCHA on Depop's sell form: the listing is "Action needed - list on Depop" with tasks to list by hand and reconnect; the banner and Marketplaces say Depop needs relinking                        |
| `testMarkSoldFromTheItemScreenDelistsEverywhereElse`                 | 5: Mark as sold on Mercari from the item screen; eBay, Depop, and Poshmark each confirm the delist                                                                                                          |

The tests are independent: each seeds its own items, clears every fault first, and the CAPTCHA
test links a fresh Depop session before and after itself.

## CI

`.github/workflows/e2e-full.yml` runs `make e2e-full` on a macOS runner every night and when
started by hand (`workflow_dispatch`), never on a pull request. It uploads the result bundle, the
stack's logs, and the failing-test summary on every run. The `packages/e2e` integration tests
(`stack.int.test.ts`) start the full stack and list on every marketplace through the API, so the
backend check of every pull request still catches a broken stack.

## Open items

- Relinking an automation connection from the app (Settings > Link accounts) is a separate task
  ([pull request 72](https://github.com/toniojbusiness/listora/pull/72)); until it lands the
  Marketplaces screen shows a connection that needs relinking with no button, so the CAPTCHA test
  checks the status, the detail, the banner, and the reconnect task, not a Relink button. When it
  lands, the test should tap Relink and finish the link.
- The API builds no automation adapters, so for an automation connection it reports the assisted
  adapter's capabilities (`Connection.capabilities` and each listing action's `mode` say
  `assisted`). The app decides from the connection's mode, so nothing it shows is wrong today.
- After a sale the item reads "Sold, delisting" for up to a minute after its delist run is
  "Delisted everywhere": only the delist SLA job, which runs every minute (`auto_delist_sla`),
  moves a finished item to `sold`. Finishing the item when its run completes would close the gap.
