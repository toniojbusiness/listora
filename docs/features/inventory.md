# Inventory, item screen, and the listing flow

The iPhone's Inventory tab, the item screen, and listing an item on eBay with honest status
(plan task T-19). The app code is the `InventoryFeature` package
(`apps/ios/Packages/Features/Sources/InventoryFeature`); the listing and operation endpoints it
calls are in `apps/api/src/listings` and `apps/api/src/operations`, on the operation engine
([operations.md](operations.md)).

## The screens

- **Inventory** lists the account's items, newest first (`listItems`): cover photo, title, SKU,
  price, item status, and each listing's status on its marketplace, exactly as the server words
  it. Search goes over SKU, title, brand, and keywords; the filter menu narrows by item status,
  marketplace (items with a listing there that is not ended or sold), and brand (exact, ignoring
  case). The list reads the server every time it appears and on pull to refresh, so an item saved
  in the review flow is there when the seller opens the tab. With no items the empty state points
  to Add Item; with filters that match nothing it offers to clear them.
- **Item screen**: photos, title, SKU, status, list price; one row per marketplace (eBay, Depop,
  Poshmark, Mercari) with the listing's `statusDisplay`, how Listora works with that marketplace
  ("Through eBay's API" or "Assisted"), the listing's own price, the actions the server allows
  (`availableActions`) plus Retry when the newest operation failed, and the listing's history
  (every operation, newest first; opening one shows its steps from `listOperationEvents`). Then
  cost and profit (the sale's profit once sold; before that "Profit at list price", labeled as
  before fees and shipping), and the details with the storage location.
- **List flow**: List opens the marketplace choice. eBay is offered when the account's eBay
  connection is usable; the other marketplaces show their mode (assisted, finished in the
  marketplace's app; listing them from here comes with the task inbox, T-21). The eBay review
  starts from the seller's own eBay copy from the review screen (`ListingCopyStore`), else the
  accepted analysis's eBay variant, else the item's title and description, with the item's list
  price, and counts the title against eBay's 80 characters. Publish creates the draft listing
  (`createListing`, or `replaceListingDraft` for a draft a refused publish left) and publishes it
  (`publishListing`); a refusal (`422`, for example "eBay needs at least one photo.") stays on the
  review with the message.
- **Changes**: Change price, End listing (sold elsewhere, or no longer available), Relist, and
  Check status each queue one operation. Retry re-queues the failed operation
  (`retryOperation`).

## Never show success the server has not confirmed

- Every status the app shows is the server's `statusDisplay` label, unchanged ("Active
  (confirmed by eBay)", "Delisting... retry 2 of 6", "Delist failed - Retry", "Checking...",
  "Action needed - delist on Poshmark", "Done (you confirmed)"). The app never sets a status
  itself: after an action it reads the item back and shows what the server says, which is
  "Publishing..." or "Delisting..." until the engine has verified the change on the marketplace.
- **Live updates.** While any listing's newest operation is unfinished (queued, running,
  retrying, verifying), the item screen reads the item again every second; for a retry it waits
  until the retry is due, at most 15 seconds. Polling stops when the screen goes away.
- An action is sent with one Idempotency-Key, and sent again with the same key when the answer
  was lost, so a dropped connection never queues a change twice. A refusal shows its message.

## The API behind it

- **Listing actions** (`apps/api/src/listings/actions.ts`): `createListing` makes a `draft` with
  Listora's variant (title, description, price, category, condition, item specifics, hashtags).
  A marketplace Listora reaches only through its API (eBay) needs the account's connection
  (`409 marketplace_not_connected`, or `marketplace_reauth_required` for one that needs
  reconnecting). `publishListing`, `reviseListing`, and `relistListing` build the listing content
  from the item as it is now (its ready photos' listing images) and the variant, refuse what the
  marketplace's adapter would refuse (`422`, the adapter's message, before anything is queued),
  and queue the operation; `changeListingPrice`, `endListing`, and `verifyListing` queue theirs
  with the desired state. Each answers `202` with the listing and the operation.
- **One change at a time.** A listing allows an action only when no operation on it is
  unfinished, and only in the state it needs: `publish` for a draft never queued (a failed
  publish is retried, never published twice, since it may have been applied), price, revise,
  end, and check for an active listing, relist and check for an ended one. A failed operation
  never blocks the others (a failed price change still lets the seller delist). The same rule
  computes `availableActions`, under the marketplace's capabilities and only for API actions
  until assisted ones have their task inbox.
- **Listing views** show the newest operation that was not canceled as `latestOperation` and
  derive `statusDisplay` from it (`describeListingStatus`); an operation's own `statusDisplay`
  names what it did ("Price changed (confirmed by eBay)", `describeOperation`), so the history
  never borrows the listing's current state. The variant is Listora's version of the listing:
  a price change or revise records the requested values at once, with the status saying they
  are being applied.
- **Item status follows the listings**: the engine makes a `draft` or `ready` item `listed` once
  one of its listings is confirmed active (read-back or user confirmation) and a `listed` item
  `ready` again once none is (`syncItemListedStatus` in `@listora/operations`).
- **Operations** (`apps/api/src/operations`): `listOperations` (by item, listing, status),
  `getOperation`, `listOperationEvents` (oldest first, numbered, with a user-readable message per
  step), and `retryOperation` and `cancelOperation` through the engine's own commands.

## Local development and tests

- The local stack the UI tests run against (`packages/e2e`, started by `make ios-test`) also runs
  the fake eBay in its process, gives the API and worker a token vault key of its own, and
  connects the test user's eBay account through the fake's consent page, so a test can publish at
  once. The worker's operation delays are a tenth of production's (`OPERATION_RETRY_DELAY_SCALE`
  in `.env.example`), so an eBay change, which needs two matching reads one delay apart, is
  confirmed in about 3 seconds.
- **Control endpoint** (`packages/e2e/src/control.ts`, `LISTORA_E2E_CONTROL_URL`): UI tests seed a
  ready-to-list item (`POST /items`) and make the fake eBay fail the next matching request
  (`POST /ebay/faults`, `DELETE /ebay/faults`). Local only; the app never calls it.
- `ListingFlowUITests` drives inventory → item → List → publish to "Active (confirmed by eBay)",
  a price change, an injected delist refusal to "Delist failed - Retry", Retry to "Delisted
  (confirmed by eBay)", and search by SKU. `ReviewFlowUITests` ends in the Inventory tab, where the
  item it saved is listed. `apps/api/src/listings/actions.int.test.ts` runs the same flow against
  the API with a real operation worker and the fake eBay.
