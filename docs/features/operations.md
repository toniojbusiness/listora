# Operation engine: never false success

Every marketplace write is a `marketplace_operation` row whose state machine the worker drives
(`@listora/operations`; the state diagram is in `state-machine.ts`).

1. **Write path.** The API, or the auto-delist orchestrator, calls `enqueueOperation`. It
   inserts the operation (`queued`, `idempotency_key`, desired-state snapshot, and for a
   create, revise, or relist its listing content) and enqueues its Graphile Worker job **in
   the same transaction**. Enqueueing the same key again returns the existing operation. The
   desired state names the fields a read-back must show, so an empty one is refused; for a
   content operation it comes from the content ([marketplaces.md](marketplaces.md#adapter-model)).
2. **Execution.** One job runs one step. A step commits `running` before it can send anything, so a
   step cut short is detectable afterwards. No transaction stays open during a marketplace call, and
   a step records its result only if the operation is still exactly as the step found it. Jobs run
   one at a time per listing (`queue_name = listing:<id>`, `job_key = operation:<id>`), and a newer
   operation waits until every older one on its listing is finished, so changes apply in order even
   while an older one waits to retry. A delist after a sale doesn't wait out an older operation's
   backoff: the older one's read-back runs at once (a try-now in its history, `delist_waiting`),
   never its send or a wait the marketplace or pacing asked for, and the delist looks again every
   30 seconds instead of 5 minutes until it can go (`hurryOlderChecks` in `executor.ts`). A daily
   job deletes listing queues that have no jobs left.
   Each step runs in the operation's capability mode under the listing's connection
   (`operationMode`, [marketplaces.md](marketplaces.md#adapter-model)): an `unsupported` operation
   fails without being sent, and a send builds its payload from the stored content and fails without
   sending when the adapter's validation refuses it. An `automation` step needs a browser: the
   worker hands its job over, unchanged and without using an attempt, to the browser runner's
   task (`AUTOMATION_OPERATION_TASK`, the same job key and listing queue), which runs it by the
   same rules ([automation.md](automation.md)); its next steps come back to the worker first.
   Under a connection that runs on the phone, the step waits in `phone_work` for the seller's
   iPhone instead (`phone-queue.ts`): the operation keeps its status and its job, which only
   rechecks the wait, recovers a phone run that stopped mid-step like any interrupted step, and
   fails the operation with `phone_unavailable` (and a Retry) after 24 hours. The phone's
   answers are decided by the same phases, in the API ([phone-execution.md](phone-execution.md)).
   Automated and API operations are decided the same way. The adapter outcome determines the
   next state:
   - `confirmed`: the API (or the browser session) took the change **and** `readListing` shows
     the desired state → `succeeded`. A read-back that disagrees or fails → `verifying`.
   - `rejected` (validation or permanent error) → `failed`, with a user-readable reason and fix.
   - `transient` (429, 5xx, network failure before send) → `retrying` with backoff and jitter
     (30 s, 2 m, 10 m, 30 m, 2 h, 6 h, ±20%, at least the marketplace's `Retry-After`), then
     `failed` with a Retry action.
   - `unknown` (timeout after the request may have been sent, a lost connection, an adapter that
     throws or misses its deadline) → `verifying`. `readListing` decides: the desired state
     holds → `succeeded`; it does not → `retrying`. The request is never re-sent blindly. The
     read-back after a send with an unknown result, and the second read a `readFreshness: 'none'`
     match needs, come soon (`CHECK_SOON_MS`, 15 seconds, never later than the backoff): the
     seller is waiting to see the listing, and nothing is sent again meanwhile. A create or
     relist whose send the marketplace confirmed, and that a read still can't find without the
     marketplace saying it is gone, is read again later and never sent again: a marketplace's
     own search, and even a new listing's own page, can lag minutes behind a listing it just took
     (Poshmark's closet and listing page, 2026-10-27), and sending again would post it twice.
     When its attempts run out it fails, and the seller checks.
   - `pendingUser` (assisted, or an automated step that met a check automation must not pass)
     → `needs_user_action` until the user confirms (`confirmOperationByUser`), or `failed` when
     the user dismisses the task (`dismissOperationByUser`, with a Retry that makes a new task;
     [tasks.md](tasks.md)). An assisted operation is never read back, and any other
     outcome for it (`confirmed`, `unknown`) fails as unconfirmed; an API operation that answers
     with a user task fails the same way.
3. **Attempts.** Every step, a send or a read-back, uses one attempt, and an operation gets
   seven. The delays are the worker's `OPERATION_RETRY_DELAY_SCALE` times the schedule above (1
   in production; the local stack for UI tests uses 0.1). A step whose result is unknown is always followed by a read-back, even after the
   last attempt. A scheduled refresh gets three ([listing-refresh.md](listing-refresh.md)), so
   one a marketplace won't confirm waits for its next interval. Retry (`retryOperation`) gives a
   failed operation a fresh set of attempts; it
   is refused once a newer operation exists on the listing, since it would undo that one. Try
   now (`tryOperationNow`, also the admin's `operation-try-now`) runs a waiting operation's next
   attempt at once: only a `retrying` or `verifying` one, which keeps its status, attempts, and
   error, and whose attempt runs exactly as it would have later (a retry reads the listing back
   first); only the time moves, and its history records the move. A step that runs on the
   seller's iPhone is taken on the phone's next look. A
   create, revise, or relist whose content the adapter's own validation refuses fails before
   anything is sent (`validation_failed`, `REFUSED_CONTENT_ERROR`, "Poshmark needs a size for
   Men's Shirts. Fix it, then try again."). Retrying the same content can only fail again, so
   that failure is not retryable (`error.retryable: false`, the label has no "- Retry"): the
   seller fixes the item or the listing and sends it again, which a draft that never reached the
   marketplace allows ([inventory.md](inventory.md#the-api-behind-it)).
4. **Idempotent re-execution.** An operation that may have been applied before is read back
   before every later send, and succeeds without sending again when the change already took
   effect (a 5xx can hide an applied write). "May have" is read from the results its earlier
   sends recorded (`mayHaveSentBefore`, history.ts): only a send that shows it changed nothing
   (refused, sent nothing, an automated script that stopped before any step that changes the
   listing, or a session that never opened) does not count; a confirmed, unknown, or interrupted
   send, a 5xx, and a task for the user do. The adapter hears the same answer
   (`OperationRequest.mayHaveApplied`), so a create or relist looks for a listing an earlier
   attempt may have posted only when one may have. Adapters also pass the operation's
   idempotency key to the marketplace's own duplicate protection where it has one.
   **Pending listing ids.** A listing id a send returns (eBay's `RelistItem` issues a new one)
   is stored at once, in the transaction that records the step, as the listing's
   `pending_external_listing_id`: unverified, and never linked to another listing of the
   account. Every later step and operation on the listing targets the newest known id, the
   pending one over the verified one, so a new listing is never lost even when its read-backs
   fail. A read-back that confirms it promotes it to `external_listing_id`. An end on a listing
   with both ids targets both, since either may be live, and succeeds only when each reads
   back ended under the freshness rule (`confirmEveryReadBack` joins the proofs) or is
   authoritatively absent. **Absent listings.** The goal of an end or mark-sold is that nothing
   is live, so an authoritative not-found satisfies its target (eBay drops ended listings
   after a while): a refused end is read back before it fails, a precheck that finds the id
   absent sends nothing to it, and on success the absent id is retired from the listing row. A
   create, relist, or edit is never confirmed by an absence.
5. **Read freshness.** A stale read can show an older state that happens to match (after end,
   relist, end, the first end), so a read-back confirms only when it is current
   (`confirmByReadBack` in `evidence.ts`, the only maker of read-back proofs). Listora keeps the
   newest revision it has seen of each marketplace listing, from reads and confirmed sends,
   including the revision a send was confirmed with, so the rule survives a crash:
   `marketplace_listing.remote_revision` for the verified id and `pending_remote_revision` for
   the pending one. A read older than that revision is stale and decides nothing,
   neither success nor a resend; another read follows after the backoff delay. With
   `readFreshness: 'none'`, a matching read confirms only when the operation's previous read, a
   delay earlier and with no send in between, matched too (the operation waits in `verifying`
   with code `confirming`). That assumes staleness lasts less than the delay; adapters should
   provide a revision wherever the marketplace has one.
6. **Crash recovery.** Each worker holds a Postgres session named `listora-worker:<pool id>`,
   which the operating system closes when the process dies, even on SIGKILL. Live workers
   release the job locks of pools that have no session within about 10 seconds (Graphile
   Worker alone waits 4 hours). The job runs again, finds its step `running`, and reads the
   listing back. A worker that loses its own session exits at once. So every Graphile Worker
   runner must be started through `startOperationWorker`, with the same database role, on a
   direct connection (not a transaction pooler).
7. **Listing truth.** A verified success records what the marketplace showed on the
   `marketplace_listing`: status, external id and URL (a confirmed pending id becomes the
   external id), `remote_snapshot` (with its revision), `remote_revision`, `last_verified_at`.
   A user confirmation changes only the status. Between operations, a **drift resync**
   (`runListingResync`, when the marketplace reports a change or a sale) records what a read
   shows the same way, in the listing's queue and never under an unfinished operation; without
   read revisions it records a change only after two matching reads a delay apart. Either way
   the item's status follows: a `draft` or `ready` item is `listed` once a listing of it is
   confirmed active, and a `listed` item is `ready` again once none is (`syncItemListedStatus`).
8. **History.** Every transition appends an `operation_event` with a redacted request/response
   excerpt (`redactForStorage` in `@listora/shared`), error code, and attempt number.
9. **Invariant, enforced in code and tests:** no code path sets `succeeded` without a verified
   read-back or a user confirmation event. `transitionOperation` is the only code that writes
   operation rows, and it sets `succeeded` only with a `SuccessProof`, which only `evidence.ts`
   can create, and only for a current read; a test scans the code for any other writer. Chaos
   tests inject 429s, 5xx errors (also after the change was applied), timeouts after send,
   stale reads, and a worker killed mid-operation, over listings that are ended and relisted
   more than once.
10. **Concurrency (T-16, T-24).** Token refresh is single-flight per connection: for eBay, in one
    process and across workers (the connection's row lock, [connections.md](connections.md));
    Depop rotates refresh tokens, so rotated tokens are kept in memory until they are stored (the
    Depop adapter's tokens, [depop.md](depop.md)). Rate limits use per-seller and app-wide sliding
    windows.

**Auto-delist** ([auto-delist.md](auto-delist.md)). A sale event (webhook, poll, email, or
manual entry) is deduplicated by its order (see `sale` under [Data](#data)). Then, in one
transaction, `recordSale` (`@listora/sales`) records the sale, sets the item to
`sold_pending_delist`, cancels the item's moot operations (`cancelMootOperations`: edits waiting
to run or retry, and publishes that never reached the marketplace), and creates a high-priority
delist operation for every other listing that may be live, which an assisted listing turns into
an urgent task. A `delist_run` gathers the per-marketplace results. If anything is still not
delisted or confirmed after 10 minutes, Listora alerts the user again, and after 30 minutes it
escalates the alert. A second sale opens a double-sale incident.

**Status vocabulary** shown to users: `Active (confirmed by eBay)`, `Delisting...`,
`Delist failed - Retry`, `Checking...`, `Action needed - delist on Poshmark`,
`Done (you confirmed)`, and for a step the phone runs, `Delisting... open Listora on your
iPhone` and `Delisting on your iPhone...`. A label says what the seller can do, never Listora's
internals: a retry shows as the work in progress (`Delisting...`, with Try now in the app),
without its attempt count, its last error, or when it is next tried, and a wait for the phone
without how long it has waited; those stay in the operation's record for the support views. A
retry before its time is never shown as a wait for the phone. A relist says what it does where Listora
knows (`relistMode`): `Reactivating...` brings back the listing Listora ended (Mercari activates
it, Poshmark puts it back for sale), and `Relisting (new listing)...` posts a new one (Depop,
whose End deletes, and any listing whose id a read-back cleared because the marketplace removed
it; the executor sends such a relist as the marketplace's create, after the same checks).
Assisted listings never show "confirmed by <marketplace>".
`describeListingStatus` (`status-display.ts`) renders these labels from the listing's newest
operation: "confirmed by <marketplace>" only for a read-back's evidence, "you confirmed" only
for the user's confirmation, and a listing without a successful operation is never shown as
confirmed. The API serves them as `statusDisplay` on every listing, from its newest operation
that was not canceled; `describeOperation` labels one operation in a listing's history by what
it did ("Price changed (confirmed by eBay)"). The listing actions and the app that shows them are
in [inventory.md](inventory.md).

## Data

- **Sales and delist:** `inbound_event` (deduplicated per account, source, marketplace, and
  provider event id, so an id that repeats in another account or on another marketplace is
  never dropped as a duplicate; `external_user_id` names the marketplace user it is about, so
  that user's data can be deleted). `sale` is one marketplace order (unique per account,
  marketplace, and external order id) with the order-level fields: sold time, currency,
  shipping charged, detection source, status, and ship-by. Its `sale_item` rows are the items
  it sold, one per item (an order can be a bundle), each with its price and, when known, the
  item's listing on the sale's marketplace. `delist_run` is one per sold item and must point
  at an item of its sale; the `delist_run_listing` view lists its operations and user tasks.
  `fee_line` belongs to a sale and optionally to one of its items ([sales.md](sales.md#fee-lines)). Also `user_task` (its
  `sale_id` names the sale a task is about: the later sale of a `resolve_double_sale`) and
  `expense`. Auto-delist operations have `origin = 'auto_delist'` and reference their
  `delist_run`.
