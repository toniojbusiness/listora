# Hauls

Resellers often buy many items for one price: 30 items from the bins for $50. Asking "how much
did you buy this item for?" then has no direct answer, so the cost screen also offers "Part of a
haul": the seller enters what the whole haul cost and how many items it had, and each item costs
its share ($50 / 30 = $1.67). Code: `apps/api/src/hauls` (routes, repository, the share math in
`shares.ts`) and the iPhone's `ReviewFeature` (`CostView`, `HaulCostSection`,
`ReviewFlowModel+Haul`, and the batch review's `BatchReviewModel.markHaul`). No AI and no
marketplace call is involved.

## Shares and rounding

Each item in a haul costs its share of the total, in integer cents: the total over the count,
rounded down, plus one cent for the items that joined first while leftover cents remain. A full
haul's shares add back up to the total exactly: $50 over 30 is 20 items at $1.67 and 10 at
$1.66, $50.00 in all. The count is how many items the haul had, not how many are in Listora yet,
so the first item from a 30-item haul already costs $1.67. The haul's `eachCost` (total over count
to the nearest cent, half up) is only shown ("$1.67 each, from a $50 haul of 30"); each item's own
cost is its share, which is that or a cent less.

- **Items join later.** `addHaulItems` adds items after the ones already in it. Their order of
  joining is their place for the leftover cents. When the count is reached, each new item adds
  one to it, and every item's share drops.
- **The count can be fixed.** `replaceHaul` changes the total, count, date, or place; every item in
  the haul gets its new share. A count below the items already in it is `422`.
- **Leaving.** `removeHaulItem` takes an item out; it keeps its last share until the seller sets
  its own cost, and the items still in the haul move up a place. Deleting an item does the same
  for the rest of its haul. An item joining another haul leaves its old one, which is settled too.
- **One cost, kept by the haul.** The API writes every member's `cost_cents` (with its own history
  entry and a new `version`), so the profit dashboard, the sales screens, Today's money, and the
  price floors read the per-item cost from the item as they always have. While an item is in a
  haul, a `replaceItem` that changes its cost is `422 validation_failed` on `details.cost`: only
  the haul changes it. Each item also takes the haul's date and place when the haul has them.
- **Locks.** A change takes its hauls' row locks (in id order) before any item's, so two requests
  moving items between the same hauls cannot deadlock.

## The API

`listHauls` (newest first, paged), `createHaul` (with `itemIds` that join it at once, in order),
`getHaul`, `replaceHaul`, `addHaulItems`, and `removeHaulItem`. `Item.haul` is the haul an item is
part of, with `itemsAdded`. Item ids from another account are `422` field errors, and another
account's haul is `404`.

## On the iPhone

The cost screen's segmented control picks "This item" (the price on the keypad, as before) or
"Part of a haul". A haul shows the seller's latest hauls as choices, so the next item from the
same trip is one tap, and "New haul": its total and how many items it had, both typed on the same
in-app keypad (tap a field to point the keypad at it), with the share shown as it is typed. A new
haul takes the screen's date and place. A saved haul shows each item's cost, how many are in
Listora so far, and **Fix count**. Continue creates or joins the haul and reads the item back
with its share; choosing "This item" for an item in a haul takes it out first. A new haul's
request keeps its Idempotency-Key across retries of the same haul, so it is recorded once.

The item screen's cost says when it is the item's share of a haul ("Its share of a $50.00 haul of
30").

In the batch review, **One $12 haul: $4.00 each** marks every item still to approve as one haul
in one step (one `createHaul` with their ids), and each page then shows its share. Typing a price
on a page afterwards makes it that item's own price.

## Local development

Nothing needs a credential. `shares.test.ts` covers the rounding, `hauls.int.test.ts` the API on a
real Postgres (the $50 over 30 split, joining, the count, leaving, moving, deleting, a batch, other
accounts, and the profit dashboard's cost of goods), and `ReviewFeatureTests` (`HaulCostTests`,
`BatchReviewTests`) the app's models against a fake server. `BatchListingUITests` marks a 3-item
batch as one haul on the local stack and checks every item's share on the server.

## Data

Migration `20261028185247_hauls` adds `haul` (the total in cents, its currency, the count, and the
date and place) and, on `inventory_item`, `haul_id` and `haul_joined_at` (both or neither), with a
composite foreign key to the account's haul. Deleting the account deletes its hauls.

## Follow-ups

- Deleting a haul, and a screen listing every haul with its items.
- An item's saved "Don't sell below" floor is set when it is saved; a later change to its haul's
  share does not move it (the price screen always reads the current cost).
