# Activity and sale-detection health

When a seller runs into a problem, or a sale is missed, the records say what happened and why:
one searchable timeline per item and per marketplace action, a record of every sale check, the
health those checks add up to, and an explanation of each sale. Nothing is stored twice: the
timeline reads the records the server, the browser runner, and the phone already keep, plus the
two this feature adds (each browser session's steps and their times, and each sale check).

Code: `packages/activity` (the timeline and the sale explanation, `@listora/activity`),
`packages/automation/src/sale-checks/` (the check records in `job.ts`, the health in
`health.ts`), `apps/api/src/activity`, the admin CLI's `activity.ts`, the worker's
`sale-check-health.ts`, and the app's `ItemActivityView` (InventoryFeature) and `FoundSection`
(SalesFeature).

## The timeline

`loadActivity` returns one list, newest first, for an item, an operation, a sale, or an account's
marketplace, within a time range. Each entry has the seller's words (a title and a detail), who
did it (`listora`, `cloud_browser`, `iphone`, `you`, or `marketplace`), how it went (`succeeded`,
`failed`, `in_progress`, `waiting`, or `info`; only a confirmed outcome is `succeeded`), the ids
it is about, and, for something that ran, how long it took. It comes from:

| Record            | Entry                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `audit_log`       | An item change ("Item created", "Sold on Poshmark")                                                      |
| `operation_event` | A step of a marketplace action ("Delist on Depop after the sale": "Depop confirmed it.")                 |
| `automation_run`  | One browser session on the runner or the phone, with its steps and their times, and where it stopped     |
| `sale_check_run`  | A sale check, or a read of the sold history: where it ran, how many sold orders it saw, how many new     |
| `inbound_event`   | An order a marketplace reported or a check found, and what Listora did with it (recorded, nothing to do) |
| `sale`            | A sale, and how Listora learned of it                                                                    |
| `delist_run`      | The delist after a sale: started, reminded, escalated, done                                              |
| `user_task`       | A task for the seller, and when they did or dismissed it                                                 |

It keeps what the records keep: redacted operation excerpts, step names, error codes, and the
ids operators search the logs by (a browser session's `runId` is on every log line it wrote,
including `automation script stopped` with the page's structure-only evidence). No page content,
typed value, or buyer's name or address is in any of them.

- **Step timings.** Every browser session records its steps in order with how long each took
  (`automation_run.steps`, from `ScriptResult.stepMs`), on the runner and on the phone, whose
  runtime reports them with its answer. A phone runtime older than step timings sends none, and
  the steps show without times.
- **Item and operation timelines** show the item's or the operation's records only, in the
  seller's account. An account's timeline, optionally for one marketplace, also shows every sale
  check, every sign-in check, and every order.

## Sale checks: every one recorded

Each automated sale check (decision D1, [automation.md](automation.md)) records a
`sale_check_run` when it starts (where it runs: `runner` or `phone`; why: the schedule's reason)
and finishes it with what it read: the orders it saw, the items in them, the ones it handed to
the sale intake for the first time, the newest and oldest sale times, at most 100 of the orders
themselves (order id, sale time, each item's listing id, title, and price), and the browser
session that read them. A check that fails records its code and the seller's words for it
("Mercari's sold items page has changed, so Listora couldn't read it."). A check whose runner or
phone stopped before it finished is closed as interrupted when the next one starts. The order a
check hands over names the check (`inbound_event.payload.saleCheckRunId`), and so does the sale
it records (`sale.sale_check_run_id`).

## Sale-check health: a missed sale is never silent

Each automation connection's schedule keeps whether its sale checks work (`health`):

- **`failing`**: `SALE_CHECK_ALERT_FAILURES` (2) checks failed in a row. A check that works makes
  it `healthy` again and resets the count.
- **`overdue`**: the check that was due has not run for `SALE_CHECK_OVERDUE_HOURS` (6) past its
  due time. On the phone this means Listora has not been opened there; in the cloud, that the
  runner has not run it. The worker's `sale_check_health` task (every 5 minutes) marks it.

A connection only the seller can fix (`reauth_required`, `revoked`) has its own reconnect card
and notification instead. A problem with a working connection is Listora's to fix, so it is
the owner's, not the seller's:

- **The seller** sees nothing on Today, in the morning summary, or on any screen. The one case
  they can fix is checks that run on their iPhone and are overdue because Listora has not been
  opened there: a notification (`sale_checks_need_attention`, "Open Listora to keep Depop in
  sync") asks them to open it, once per problem. The schedule's `alerted_at` settles every
  problem once (set in the transaction that queues the notification, when there is one), and a
  check that works ends the problem.
- **Support** reads the connection's `saleChecks` (when sales were last checked and last worked,
  the next check, the last error) from `listConnections` and `admin sale-checks`; the app does
  not show it.
- **The operator** sees `UnhealthySaleChecks` per marketplace in the trust metrics, and the
  `sale-checks-unhealthy` alarm ([observability.md](observability.md)); the task logs
  `event: "sale_check_overdue"` and `event: "sale_check_alert"`, and each check
  `event: "sale_check_failed"`, `"sale_check_finished"`, or `"sale_history_read"`.

## Proving a sale check on real sold history

A **history read** (`sale_check_run.kind = 'history'`) runs the marketplace's sale-check script
read-only against the seller's real account and records every sold order its pages show, with
nothing handed to the sale intake: no order, no sale, no delist, no status change, and the
schedule untouched. It runs where the connection runs: on the phone as `sale_history` work, behind
routine changes, or in the cloud as the sale-check task with `history: true`. An operator asks for
one and reads it back:

```sh
npm run admin -- sale-history read mercari --account <account-id>
npm run admin -- sale-history show mercari --account <account-id>
```

## Why a sale went the way it did

`loadSaleExplanation` (`getSaleExplanation`, `GET /v1/sales/{saleId}/explanation`, and
`npm run admin -- sale-why <sale-id>`) says how Listora learned of the sale (which check saw it,
where and when, and how many sold orders that check saw; or the marketplace's notification, a
forwarded email, the seller's entry), when the order was reported and the sale recorded, each
delist it started on the other marketplaces with its status, attempts, error, and when it
settled, and the sale's whole timeline. The sale screen shows the first part as "How Listora found
it".

## In the API and the app

- `listItemActivity` (`GET /v1/items/{itemId}/activity`) and `listOperationActivity`
  (`GET /v1/operations/{operationId}/activity`): a page of entries, newest first, with a cursor to
  older ones. Another account's item or operation is `404`.
- `getSaleExplanation`, above, and `Connection.saleChecks` on every automation connection.
- These endpoints are the seller's (`forSeller` in `loadActivity`): only what the seller did or
  can act on (item changes, marketplace actions, sales, delists, tasks). Browser sessions, sale
  checks, orders, step timings, error codes, run references, the check that saw a sale, and a
  delist's attempts are Listora's diagnostics, which only the operator's timeline below shows.
- The item screen's **Activity** row opens the item's timeline: each line in the server's words,
  who did it ("Listora", "You", the marketplace), and when. The sale screen has **How Listora
  found it**: when it sold and each delist's result.

## Searching as an operator

`npm run admin -- activity` searches one timeline by account, item, SKU (with `--account`),
operation, sale, marketplace, and time (`--since`, `--until`); `sale-why` explains a sale;
`sale-checks` lists every automation connection's health and the latest checks (`--json` for
all of them). In AWS, `scripts/admin-remote.sh <env> [--profile <name>] -- <command>` runs the
same CLI (which the application image carries) as a one-off task with the migration task's
database access and prints its output; for
example `scripts/admin-remote.sh personal --profile prequal-main -- sale-checks`. CloudWatch Logs
then has the details by `runId` (`/listora/<env>/api` for phone runs, `/runner` for the runner's,
`/worker` for the health task).

## Local development

Nothing to configure. The sale-check thresholds are `SALE_CHECK_ALERT_FAILURES` and
`SALE_CHECK_OVERDUE_HOURS` (`.env.example`). The fake sites serve sold orders, so a history read
and the health rules run locally against them; tests never contact a marketplace.

## Data

Migration `20261027011100_sale_check_health`:

- `automation_run.steps`: the steps of a browser session, in order, with their times.
- `sale_check_run`: one sale check or history read: kind, reason, host, start and finish,
  outcome, the window it read from, counts, sale times, the orders it read (bounded, no buyer
  data), error code and message, and its browser session. Deleted with its connection or account,
  and 90 days after it started by the retention job ([privacy.md](privacy.md#retention)).
- `sale_check_schedule`: `last_succeeded_at`, `failures_in_a_row`, `last_error_code`,
  `last_error_message`, `health`, `unhealthy_since`, and `alerted_at`.
- `sale.sale_check_run_id`: the check that saw the sale, while its record is kept.
- `phone_work.purpose` gains `sale_history`, one waiting per connection.

## Open items

- A "Check sales now" action on the marketplaces screen (the card only opens it).
- The eBay API's order poll ([ebay-notifications.md](ebay-notifications.md)) is not recorded as
  sale checks yet; it runs every 5 minutes on a connection that is not in use until Listora's eBay
  keys exist.
- A failed phone run still keeps no screenshot ([phone-execution.md](phone-execution.md)); its
  step and its structure-only evidence are in the log line its `runId` names.
