# Inventory, item screen, and the listing flow

The iPhone's Inventory tab, the item screen, and listing an item on eBay with honest status
(plan task T-19). The app code is the `InventoryFeature` package
(`apps/ios/Packages/Features/Sources/InventoryFeature`); the listing and operation endpoints it
calls are in `apps/api/src/listings` and `apps/api/src/operations`, on the operation engine
([operations.md](operations.md)).

## The screens

- **Inventory** lists the account's items, newest first (`listItems`): cover photo, title, SKU,
  price, item status, and each listing's status on its marketplace, exactly as the server words
  it. It opens as a grid of large photos; the toolbar button switches to a list of rows and back,
  and the choice is kept on the iPhone (`InventoryLayout`). Search goes over SKU, title, brand,
  and keywords. The quick filters above the list (`InventoryFilter`) are one tap each: All, Needs
  you, Drafts, Ready to list, Listed, Sold (sold, delisting, or shipped), and Archived; the filter
  menu narrows by marketplace (items with a listing there that is not ended or sold) and brand
  (exact, ignoring case). The list reads the server every time it appears and on pull to refresh,
  so an item saved in the review flow is there when the seller opens the tab. With no items the
  empty state points to Add Item; with filters that match nothing it offers to clear them, and an
  empty Needs you says nothing needs the seller.
- **Needs you**: an item whose listing's newest change (not counting canceled ones) failed or
  waits for the seller (`listItems` with `attention=true`). Its photo carries a "Needs you" badge
  (red for a failure, amber for a step that waits for the seller), the quick filter shows how many,
  and the Inventory tab's badge counts them (`InventoryAttention`, read when the app comes to the
  front and each time the list loads; it counts one page, so "50+" at most). An item on no
  marketplace says "Not listed anywhere yet", and a draft "Review it, then list it".
- **Bulk actions** (`BulkActionModel`, `BulkActionSheet`): Select in the toolbar, or a long press
  on an item, chooses items; the selection bar replaces the tab bar with List all, Price, End all,
  Relist all, and Delete. Each opens a sheet that asks what the change is, then runs it over every
  item, a few items at a time, reading each item fresh (its listings and the actions they allow
  now) and going through the same calls as the item screen, each with its own Idempotency-Key,
  sent again with that key when the answer was lost. The sheet then shows each item's outcome on
  each marketplace, in words: started (Listora took the change; the item shows its progress until
  the marketplace confirms, never "done"), done (only what the server itself completed: a delete,
  a list price saved), skipped with what to do, or failed with the server's or marketplace's
  message, and Try again reruns the failed items only.
  - **List all** chooses the marketplaces where Listora lists itself (an API or linked
    connection) and offers the assisted ones, which make a task. Each listing starts from the same
    copy as the List flow (`SuggestedCopy`). What the List flow's review would stop is skipped,
    never guessed: already on that marketplace, no title or price, a title over eBay's 80
    characters, or no category Listora can map (each says to list it from the item). A draft
    whose earlier listing failed is sent again by that try's Retry, since it may have reached the
    marketplace and the server takes no new draft for it; one still working is left alone.
  - **Change price** lowers or raises by a percentage (5 to 30%) or an amount, with an example from
    the first item. Every live listing changes, and the item's own list price too (`replaceItem`,
    applied once more on the newest version after a `409`); a listing price below the item's floor
    on that marketplace is skipped with the floor, since the item screen is where the seller
    chooses to go below it.
  - **End all** asks why (sold elsewhere, no longer available) once; **Relist all** relists every
    ended listing.
  - **Delete** confirms first; an item still on a marketplace, or with sales, is kept with the
    server's reason (`deleteItem`).
  - A listing whose last change is still running takes no other (one change at a time), and is
    reported as such, with when to try again.
- **List everywhere**: on the item screen, once two or more marketplaces can take the item, the
  same List sheet for that item alone (each card's own List stays, as a smaller button, for
  reviewing one marketplace's version first). "List it now" on the review flow's Saved screen
  opens the new item in Inventory with it open (`ItemReviewOutcome.saved(listNow:)`,
  `AddItemEnvironment.onListItem`).
- **Item screen**: photos, title, SKU, status, list price; one row per marketplace (eBay, Depop,
  Poshmark, Mercari) with the listing's `statusDisplay`, how Listora works with that marketplace
  ("Listora does it for you through eBay", "... in your linked Poshmark account", or "You finish
  each step in the Mercari app"), the listing's own price, its last settled change and when ("Last
  change: Price changed (confirmed by eBay), Oct 24, 3:05 PM"), View on the marketplace and Share
  (the listing's `externalUrl`), the actions the server allows
  (`availableActions`) plus Retry when the newest operation failed and can be retried, and the
  listing's history
  (every operation, newest first; opening one shows its steps from `listOperationEvents`). Then
  cost and profit (the sale's profit once sold, "with estimated fees" until the marketplace
  reports them; before that "Profit at list price", labeled as before fees and shipping), Mark as
  sold, and the details with the storage location. A marketplace with no usable connection (only
  eBay needs one) says how to list there ("Connect your eBay account in Settings > Marketplaces to
  list it here."). The size row edits the item's size (`replaceItem`, read again and applied once
  more after a `409`): every marketplace refuses clothing and shoes without one, so a listing
  refused for its size can be fixed and listed again. A `draft` item (from another device, or an
  earlier install, so not a draft on this iPhone) offers Review item, which opens the review
  flow. A sold item shows its sale (profit, ROI, the
  delist run), and after a canceled or returned sale, "Relist it?" ([sales.md](sales.md)). Relist
  is offered only while the item is not sold or archived.
- **List flow**: List opens the marketplace choice, with the row's marketplace selected. eBay is
  offered when the account's eBay connection is usable (its API, or a linked eBay session,
  [ebay-automation.md](ebay-automation.md)); Poshmark, Mercari, and Depop (without an API or
  automation connection) are offered as assisted: listing them creates a task the seller finishes in the
  marketplace's app ([tasks.md](tasks.md)). A marketplace the item is already on is not offered.
  Each chosen marketplace's version is reviewed in turn ("Poshmark listing (2 of 2)"), starting
  from the seller's own copy for it from the review screen (`ListingCopyStore`), else the
  accepted analysis's variant for it, else the item's title and description, with the item's
  list price; eBay's title is counted against its 80 characters. Publish (or "Create Poshmark
  task") creates the draft listing (`createListing`, or `replaceListingDraft` for a draft a
  refused publish left) and publishes it (`publishListing`); a refusal (`422`, for example "eBay
  needs at least one photo.") stays on the review with the message.
- **Assisted listings**: a listing waiting on the seller ("Action needed - list on Poshmark") has
  "Open task", which opens its task; Retry after a dismissed task makes a new one.
- **Changes**: Change price, End listing (sold elsewhere, or no longer available), Relist, and
  Check status each queue one operation. Retry re-queues the failed operation
  (`retryOperation`). Change price warns, without refusing, when the new price is below the
  item's floor on that marketplace (`getItemPricing`), as the price screen does. End listing
  asks for the reason on its own card, so the confirmation opens at the button. A change waiting
  to try again says when ("Waiting to retry at 9:41 PM", or "Checking again at" for a check
  between read-backs) and offers Try now (`tryOperationNow`), which runs that attempt at once.
  When two or more marketplaces can take the same change, Relist all and End all (with one
  reason for all) queue it on each at once; each card then shows how its own change goes, and a
  marketplace Listora couldn't reach is named in the notice.
- **Work on this iPhone**: while the phone runs a listing's change, that listing's card shows
  the step it is on, its number, and about how long is left ([phone-execution.md](phone-execution.md)).
- **Activity**: the item's timeline, newest first: every step of every marketplace action, each
  browser session on the iPhone or in the cloud with its steps and their times, its tasks, sales,
  the checks that saw them, and its delists ([activity.md](activity.md)).

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
  publish is retried, never published twice, since it may have been applied), or whose publish
  was refused before sending (nothing reached the marketplace, so the seller fixes it and
  publishes again; `replaceListingDraft` allows that draft too), price, revise,
  end, and check for an active listing, relist and check for an ended one. A failed operation
  never blocks the others (a failed price change still lets the seller delist). The same rule
  computes `availableActions`, each in the mode the marketplace's capabilities give it: `api`,
  or `assisted` (the action makes a task, [tasks.md](tasks.md)); an assisted listing is never
  offered a check, since Listora cannot read it.
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
