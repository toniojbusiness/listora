# Inventory items

The master item: one per physical item, with one SKU, managed in `apps/api/src/items` and
`@listora/db` (`createInventoryItem`, the SKU allocator). Photos are in [photos.md](photos.md),
analysis in [ai.md](ai.md), and listings in [marketplaces.md](marketplaces.md).

## In the API (`apps/api/src/items`)

- **Writes** that change an item append an `audit_log` entry in the same transaction.
  `fieldProvenance` is server-owned: a detail written through the API is `user`, an unchanged
  one keeps its source (values compare as key-sorted JSON). Responses omit empty values
  (absent means no value).
- **Item status.** Archiving records the item's earlier status in `pre_archive_status`, so
  unarchiving never overwrites a status the server owns (listed, sold, shipped). Which
  transitions the user may make is part of the contract: see `ItemStatus` in
  `packages/api-contract/components/schemas/items.yaml`. A sale makes the item
  `sold_pending_delist` and, once every other listing is delisted or confirmed, `sold`
  ([auto-delist.md](auto-delist.md)); `getItem` then shows its `saleSummary` and `delistRun`.

## Deleting an item

`deleteItem` removes the item from Listora with every listing of it, and keeps the history of
what was done on the marketplaces: what the item was (`deleted_item`: its id, SKU, and title) and
what each listing was (`deleted_listing`: marketplace, status, marketplace id), with each
listing's operations moved onto its `deleted_listing` row (`deleted_listing_id`; the listing's
delete clears `listing_id`). The operations' events, browser sessions, and phone work stay with
them. An operation still waiting for the seller is canceled first (reason `item_deleted`), since
its task goes with the listing. Photos, analyses, tasks, and the item's own change history go with
the item. It never changes a marketplace.

That history is for the owner and operators only: `admin activity --item <id>` (or `--sku`)
shows every action and error under the old id, and an `Item deleted` entry with its SKU and
title ([activity.md](activity.md#searching-as-an-operator)). No seller view shows it: the
seller's timelines leave out operations on no tracked listing, and `getOperation` and the item's
activity answer `404`. The engine never loads one either (`Tracked` in
`packages/operations/src/transitions.ts`).

What it refuses, each with `409 invalid_state_transition` and a message that says what to do:

- **A listing that may be live** (any status but `draft`, `ended`, or `sold`), naming the
  marketplaces, unless the request says `leaveListings=true`. A listing already off its
  marketplace never stops a delete: one never posted, ended (including one the marketplace
  removed, which a read-back marks ended), or sold. The app asks first
  ([inventory.md](inventory.md)): end those listings, then delete; or remove the item from Listora
  only, leaving the listings up and no longer tracked.
- **A change still in flight** (an operation `queued`, `running`, `retrying`, or `verifying`),
  even with `leaveListings`: its step may be reaching the marketplace right now, and its result
  would be lost. The seller waits for it or cancels it. One enqueued while the delete runs makes
  the delete fail instead (`marketplace_operation_has_listing`).
- **An item that was sold** (`sale_item` rows): its sales, fees, and profit are kept, so it is
  archived instead.

## Data

- **Inventory:** `inventory_item` (status, canonical attributes, prices, cost,
  `field_provenance`, optimistic-lock `version`, and `pre_archive_status`, the status an
  archived item had before it was archived), `photo` (role, status, failure reason, hashes,
  derivatives, OCR and barcodes), and `storage_location`. `photo` stores the upright pixel
  `width` and `height`; each entry of `derivatives` records its key, size, byte size, and
  sha256.
- **History:** `audit_log` (item changes the user can see).
- **Deleted items** (migration `20261028203814_deleted_item_history`): `deleted_item` (id, SKU,
  title, `deleted_at`) and `deleted_listing` (id, item, marketplace, status, external listing id,
  `deleted_at`), each with the id the item or listing had; `marketplace_operation.listing_id` is
  nullable, and `deleted_listing_id` holds a deleted item's operation (one of the two is always
  set). Kept until the account is deleted.
