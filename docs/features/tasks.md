# Assisted mode: the task inbox

Where Listora can't act on a marketplace itself (Poshmark, Mercari, Depop, and eBay without a
connected API or a working linked session, plan task T-21), it prepares the work and the user does the last step in the
marketplace's app. Each such step is a **user task**. The iPhone's Tasks tab is the inbox of
them; the server finishes a task only on the user's word, so an assisted listing reads "Done (you
confirmed)" and never "confirmed by <marketplace>" ([operations.md](operations.md)).

The app code is the `TasksFeature` package (`apps/ios/Packages/Features/Sources/TasksFeature`);
the endpoints are in `apps/api/src/tasks`. Tasks are created by the operation engine from the
assisted adapters' `pendingUser` outcome ([marketplaces.md](marketplaces.md#adapter-model)).

## How a task comes to be and ends

1. The seller lists, changes, ends, or relists a listing on an assisted marketplace. The listing
   actions offer these in mode `assisted` (`availableActions`, [inventory.md](inventory.md));
   checking an assisted listing is never offered, since Listora cannot read it.
2. The worker runs the operation through the assisted adapter, which never contacts the
   marketplace: the operation becomes `needs_user_action` and, in the same transaction, a task
   is recorded with a deep link and the copy-assist payload (title, description, price, photos in
   posting order). A create or relist is `list_manually`, a price change or revise
   `edit_manually`, an end `delist_manually`. An auto-delist after a sale is `urgent`.
3. The user finishes it in the marketplace's app, then confirms:
   - `completeTask` calls the engine's `confirmOperationByUser`, the only way such an operation
     can succeed: the operation's evidence is `user_confirmation`, the listing records
     `user_confirmed_at` (never `last_verified_at`), and the item's status follows.
   - For a list task, the new listing's URL (pasted in the task, `externalUrl`) links the listing
     first: it must be a single listing on the task's marketplace (`parseListingUrl`) that no
     other listing has (`422` / `409` otherwise, and nothing changes). Later tasks for the listing
     then open the listing's own page.
   - Sharing the listing from the marketplace's app to the Share Extension does the same:
     `linkItemListing` on an item with an open list task for that marketplace completes that
     task with the shared URL instead of linking a second listing.
   - `dismissTask` gives up: the operation **fails** (`dismissed_by_user`, through
     `dismissOperationByUser`), so the listing shows "Publish failed - Retry" (or "Delist
     failed - Retry"), and Retry runs the step again, which makes a new task. A dismissed task is
     never counted as done.
4. Every completion and dismissal is in the item's history (`task.completed`, `task.dismissed`,
   with the linked URL and the user's note).

Answer-offer tasks are buyers' offers read from the marketplaces ([offers.md](offers.md)): the
seller answers one with Accept, Decline, or Counter, and its task closes once the answer is read
back from the marketplace, or once the marketplace no longer shows the offer waiting; `completeTask`
refuses it, and dismissing only hides it until the offer changes.

Confirm-sale and match-review tasks come from forwarded sale emails
([email-sales.md](email-sales.md#the-tasks)): the app shows what the email said, and confirming
or picking the item records the sale. Such tasks of any other origin (imports) have no producer
yet, and `completeTask` refuses them; a task kind added later is shown with its title,
instructions, and link and a request to update the app.

## The app

- **Tasks tab.** Open tasks, urgent first (pinned under a red "Urgent" header: an item sold),
  then oldest first, each with the item's cover, the server's title, the item's title and SKU.
  The tab's badge is the number of open tasks. The inbox reads the server on appear, on pull to
  refresh, and every 30 seconds while the app is in the foreground. With nothing pending it says
  "You're all caught up".
- **A list or edit task** is numbered steps: save the photos to the camera roll (add-only photo
  access, saved one after another in posting order, so the marketplace app's picker shows them
  in order), copy the title, description, and price with one tap each, open the marketplace
  (the deep link), and for a list task paste the listing's link (a `PasteButton`, so iOS never
  asks to allow pasting) before "Done - I posted it".
- **A delist task** opens the exact listing and ends with "Done - I removed it"; it never says the
  marketplace confirmed anything.
- **Item screen.** An assisted listing waiting on the user has "Open task", which opens the same
  task screen as a sheet (`TaskDestination` from `AppDependencies`). The List flow offers the
  assisted marketplaces next to eBay and reviews each chosen marketplace's version in turn;
  "Create Poshmark task" queues it.
- **Reminders.** Urgent tasks get local notifications 10 and 30 minutes after they were created,
  then hourly for three hours, while they stay open (`TaskReminding`; the app's driver is
  `UserNotificationReminders` on `UNUserNotificationCenter`, and the tests use a recording
  fake). Permission is asked the first time there is an urgent task. Finishing the task removes
  its reminders; tapping one opens the Tasks tab. Server push for urgent delists comes with the
  auto-delist orchestrator (T-20).
- Every confirmation is sent with one Idempotency-Key and resent with the same key when the
  answer was lost, so a second tap never confirms twice; a refusal shows the server's message.

## Local development and tests

- No credentials are involved: assisted adapters need no connection, and the local stack
  (`packages/e2e`) runs them as in production.
- `apps/api/src/tasks/tasks.int.test.ts` drives the API with a real operation worker: a Poshmark
  listing becomes a task with copy-assist and photos in order, Done with a pasted link
  activates it as "you confirmed", the delist task opens the listing, bad links change nothing,
  a dismissed task fails with a Retry that makes a new task, a shared link finishes the open
  task, urgent tasks sort first across pages, and another account's tasks are invisible.
- `AssistedTasksUITests` runs list and delist tasks through the app against the local stack,
  including saving the photos to the simulator's camera roll and opening Poshmark in Safari.
  `TasksFeatureTests` cover the inbox order, badge count, reminders, copy, photo order and
  failures, and the confirmation keys.

## Data

`user_task` ([operations.md](operations.md#data)): kind, urgency, the item, listing, operation,
and delist run it belongs to, the deep link, the copy-assist payload, and its status (`open`,
`done`, `dismissed`; the contract calls `done` `completed`).
