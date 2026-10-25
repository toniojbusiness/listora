# Auto-delist

Plan task T-20. When an item sells on one marketplace, Listora delists it everywhere else and
shows the seller, per marketplace, exactly what is true: delisted (confirmed by the
marketplace), still delisting, failed with Retry, waiting for the seller, or done (the seller
confirmed). It never shows a delist as done that a read-back did not confirm or the seller did
not confirm ([operations.md](operations.md)). Code: `packages/auto-delist` (the orchestrator),
`recordSale` in `packages/sales` (the entry point), `packages/push`
([push.md](push.md)), the worker's `auto-delist.ts` and `push.ts` features, and
`apps/api/src/sales` (the sales feed).

## Sale intake: one entry point

Every sale source ends in `recordSale` (`@listora/sales`): eBay's `ORDER_CONFIRMATION` webhook
and the 5-minute order poll today ([ebay-notifications.md](ebay-notifications.md)), and Depop
webhooks, automation sale checks, forwarded emails (T-23), and the manual "Mark sold" (T-26)
as they arrive. A sale is one marketplace order, recorded once per account, marketplace, and
order id, whichever source reports it first. Each order line is matched to the item by the
marketplace's listing id, else the seller SKU; a manual or parsed line can name the item (and
its listing) directly. A bundle records one `sale_item` per item, and each item gets its own
delist run.

## The fan-out

`recordSale` calls `startAutoDelist` (`fan-out.ts`) **in the transaction that records the
sale**, so a recorded sale always has its delists and a rolled-back one never starts any. For
each sold item:

1. **Item lock.** The items are locked in id order (`for no key update`), so two sales of one
   item arriving at once are handled one after the other. The lock does not conflict with the
   key-share lock that inserting each sale's `sale_item` row takes on the item, so the two
   never deadlock.
2. **Double sale?** If the item already sold in an order that still stands (not canceled or
   returned), the sale opens a double-sale incident instead (below).
3. **Run.** The item gets a `delist_run` and the status `sold_pending_delist` (an archived item
   is unarchived: its status follows its sales).
4. **Moot work is canceled** on each of the item's listings (`cancelMootOperations` in
   `@listora/operations`): edits (revise, price) waiting to run or retry, and publishes that
   never reached the marketplace, so a sold item is never published again. Running and
   verifying operations, and publishes that may have reached the marketplace, are kept: their
   read-backs may find a live listing. Work that waits for the user is kept too; the delist
   supersedes it when it runs ([operations.md](operations.md)).
5. **Delists.** Every listing on another marketplace that may be live gets a delist operation
   with `origin = 'auto_delist'`, the run's id, and urgent priority. The kind follows the
   listing's capabilities: `mark_sold` where the marketplace's API marks a sale made elsewhere
   (Depop: `mark-as-sold`), otherwise `end`. The engine runs it in the listing's mode: an API
   listing is ended and read back; an assisted one becomes an urgent `delist_manually` task
   with a link to the listing; an automation listing is delisted by the runner once that mode
   exists. A listing that cannot be live needs no delist: one that is ended or sold (without a
   pending listing id a relist may have left), or a draft that was never sent anywhere, in
   both cases with nothing in flight. The listing that sold is never touched.
6. **Push.** One time-sensitive notification: "Levi's trucker jacket sold on eBay. Listora is
   delisting it on Depop. Delist it on Mercari and Poshmark now." A run with nothing to delist
   is completed at once, the item is `sold`, and nothing is pushed.

Each step is idempotent (the run is unique per sale and item, and each delist's idempotency
key is `auto_delist:<run>:<listing>`), so recording a sale again changes nothing. The audit
log records `item.sold` (with the delists), `item.delisted`, and `item.double_sale`.

## The delist run's truth

`loadDelistRuns` (`results.ts`) computes every run from its operations and their tasks each
time it is read; the API and the SLA job both use it. Per listing:

| State               | When                                          | Label                                                              |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `delisted`          | The operation succeeded by a read-back        | `Delisted (confirmed by eBay)`, `Marked sold (confirmed by Depop)` |
| `user_confirmed`    | The seller confirmed an assisted delist       | `Done (you confirmed)`                                             |
| `pending`           | Queued, running, or waiting to retry          | `Delisting...`, `Delisting... retry 2 of 6`                        |
| `verifying`         | Its outcome is unknown and is being read back | `Checking...`                                                      |
| `needs_user_action` | The seller has to delist it                   | `Action needed - delist on Poshmark`                               |
| `failed`            | It failed; the reason and Retry are shown     | `Delist failed - Retry` (Retry is `retryOperation`)                |
| `canceled`          | Listora stopped delisting it                  | `Delist canceled`, with "check the listing there"                  |

Only `delisted` and `user_confirmed` count as done. The run is `completed` when every listing
is done (or there was nothing to delist), `attention_needed` (`needs_attention` in the API)
when one failed, waits for the seller, or was canceled, and otherwise `in_progress`. Its label
names the most urgent part: `Delist failed on Depop - Retry`, `Action needed - delist on
Poshmark and Mercari`, `Delisting on Depop...`, or `Delisted everywhere`.

## SLA re-alerts

The worker's `auto_delist_sla` job runs every minute (`sla.ts`). For every run that is not
completed, oldest first and with `skip locked`:

- its stored status follows its results; a completed run records `completed_at`, and its item
  becomes `sold` once no other run of the item is still open;
- **10 minutes** after the sale (the run's start), anything not delisted or confirmed (pending,
  checking, failed, or waiting for the seller) re-alerts the seller once: "It sold on eBay 10
  minutes ago. Delist it on Mercari now.";
- **30 minutes** after it, the alert escalates once ("Double-sale risk: ...") and the run's
  `escalated` flag turns on: the app shows a banner on the home screen until the run completes.

Each alert is queued in the transaction that records it (`realerted_at`, `escalated_at`).
Canceled delists and runs of a canceled or returned sale raise no alerts.

## Double sales

An item that sold again opens an incident on the later sale (`double-sale.ts`): an urgent
`resolve_double_sale` user task with the later sale's marketplace, the earlier sale, and that
marketplace's steps to cancel an order (`orderCancelGuide` in `@listora/marketplaces`), plus a
push ("It sold on Depop after it sold on eBay. Cancel one of the orders; Listora has the
steps."). The later sale starts no delist of its own: the earlier sale's run already delists
everything else. Listora never cancels an order itself. The cancel steps follow the
marketplaces' help as Listora understands it and still have to be checked in each app (like the
assisted deep links, plan red flag RF15).

## In the API

- `listSales` is the sales feed, newest first, filtered by `itemId`, sale `status`, and
  `delistStatus` (the stored run status, at most a minute behind; for example `in_progress` and
  `needs_attention` for the home banner). `getSale` is one sale. Each `Sale` has its
  `delistRuns` (one per item it started a run for) and `doubleSales`, and `isDoubleSale`.
- `getItem` adds the item's `saleSummary` (sale, time, and price), the `delistRun` of its latest
  sale (the "Sold" banner and the delist results screen), and its newest open `doubleSale`.
- `createSale` (manual "Mark sold") is T-26; the tasks API that lets the seller confirm an
  assisted delist (`completeTask`) is T-21. Both end in the functions above.

## Local development

Nothing needs a credential. With `EBAY_ENV=fake`, selling a listing on the fake eBay
(`fake.sell`) sends `ORDER_CONFIRMATION`, which the worker records and fans out; pushes are
logged by the fake push driver (`PUSH_DRIVER=fake`). The chaos test
(`packages/sales/src/delist-chaos.int.test.ts`) runs the whole path against the fake eBay, the
fake Depop, and the assisted adapters, and checks every snapshot of the run against the
marketplaces.

## Data

Migration `20261025050030_auto_delist` adds `user_task.sale_id` (the sale a task is about) and
the `resolve_double_sale` task kind, at most one per later sale and item, and indexes on the
runs that are not completed (the SLA job) and on each item's runs (the item page).
`delist_run`, `delist_run_listing`, and `user_task` are described in
[operations.md](operations.md#data).

## Open items

- iOS: the "Sold" banner and the delist results screen on the item detail land with the item
  screens (T-19), from `Item.delistRun`, `Item.doubleSale`, and `Sale.delistRuns`.
- Listing actions (T-19) must refuse to publish or relist a sold item, under the item lock.
- APNs delivery and device registration ([push.md](push.md)).
- Items with a quantity above one: today every sale delists the item everywhere.
- A delist waits behind an older operation that is verifying (its read-backs follow the backoff
  schedule) or a publish that may have reached the marketplace; the SLA alerts cover the wait.
- A `mark_sold` chosen while a Depop connection used the API fails if the connection is
  assisted by the time it runs; the seller then delists by hand.
