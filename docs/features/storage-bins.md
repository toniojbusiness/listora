# Storage bins

Past a hundred listings, memory no longer finds an item quickly when it sells. Storage bins name
where each item is kept, by the short code on the bin's sticker (`B-12`): the seller makes a bin,
prints its sticker, and scans it to put an item in. When the item sells, its sale and Pack check
say "Find it: bin B-12". Must-have rank 5 of the thrift-scan plan. No AI and no marketplace call
is involved; a bin is only Listora's own record.

Code: `apps/api/src/storage-locations` (routes, repository, the code rules in `codes.ts`), the
sale's bin in `apps/api/src/sales` (`saleItemRows`, `saleView`), Pack check's existing join in
`packages/pack-check` (`orders.ts`), and on the iPhone: `Core/Bins` (the sticker payload, the code
rules, the "Find it" words), `PackCheckFeature/Bins` (the screens, which share Pack check's
scanner and sticker printing), the item screen's Bin row (`InventoryFeature`), the saved screens'
"Put in a bin" (`ReviewFeature`'s `BinPutAwayView`), and the sale screen's "Find it"
(`SalesFeature`).

## How it works, for the seller

- **Make bins.** Settings > Storage bins lists every bin with how many items are in it. New bin
  fills in the next code (`B-13` after `B-12`); "Where it is" (Garage shelf 3) is optional. A bin
  opens on its items, Print bin sticker, Rename, and Delete bin (its items stay in inventory, in
  no bin).
- **Bin stickers.** The same AirPrint sheet and label sizes as item stickers
  ([pack-check.md](pack-check.md#item-stickers)): a QR code holding `LISTORA-BIN:<code>`, "BIN",
  the code large, and where it is. An item sticker holds `LISTORA:<SKU>`, so neither scan is
  ever taken for the other.
- **Put an item in a bin.** The item screen's Details has a Bin row ("Put in a bin", or
  "B-12 · Garage shelf 3"). It opens the picker: Scan bin sticker first (the phone over the bin),
  then the bins to tap, New bin, and "Take out of bin B-12". A scanned code no bin has yet offers
  "Make bin B-40", and the item goes in it once made. The picker closes only once Listora has the
  move; a failure says why and Try again sends the same move.
- **When an item is saved or kept.** The "Saved to inventory" screen after the review has "Put in
  a bin". A run's kept items (and a batch's) are reviewed together, and the end of that review
  has "Put all 23 in a bin": a haul from one trip usually goes in one bin.
- **Find it.** A sale that still has to ship (detected or confirmed) shows "Find it: bin B-12"
  under its header; an order of several items in different bins says "Find them: bins B-3,
  B-12". Pack check's to-ship cards and its packing session show the same line, and item
  stickers print "Bin B-12" (they said "Shelf" before). Today's ship card already showed the
  bin.

## The rules

- **Codes.** Letters, digits, spaces, and `- . /`, at most 32 characters, stored trimmed, with
  single spaces, in capitals: `b-12` is `B-12`, and two bins can never differ only by case. A
  code another bin of the account has is `409 already_exists` ("You already have a bin B-12.
  Pick another code."), also when two requests race (the `(account_id, code)` unique
  constraint).
- **The next code** is the number after the highest of the newest bin's series, as wide as that
  series writes it (`B-010` after `B-009`), never one that exists; `B-1` first.
- **Order.** Bins list by code as people read them: `B-2` before `B-12`.
- **An item is in at most one bin.** Putting it in another moves it. Every move bumps the item's
  `version` and adds an `item.storage_changed` entry to its history ("Put in bin B-12", "Taken out
  of its bin"), naming both bins by code. Putting an item in the bin it is in changes nothing.
- **Sold items leave the bin.** A bin's count and items are the ones that have not sold
  (`sold_pending_delist`, `sold`, and `shipped` are left out); the item keeps its bin, so its sale
  can still say where to find it.
- **Limits.** At most 1000 bins an account (one answer, no paging) and 200 items in one put. A
  bin's screen lists its newest 500 items.
- **Tenancy.** Another account's bin is `404`; items are checked by id in this account (`422`
  naming the `itemIds[n]` that isn't).

## The API

`listStorageLocations` (every bin by code, with `nextCode`), `createStorageLocation`,
`getStorageLocation` (the bin and its items), `replaceStorageLocation` (rename; a label left out
is cleared), `deleteStorageLocation`, `addStorageLocationItems` (one item from its screen, or a
run's kept items together), and `removeStorageLocationItem`. `Item.storageLocation` and
`details.storageLocationId` (which `replaceItem` still sets) are unchanged; `SaleItem` gained
`storageLocation`. The resource keeps the schema's name, storage locations; the app calls them
bins.

## Local development

Nothing to switch on: the API serves the routes, and the e2e stack's seed already puts a sold
item in bin `B-12`. In UI tests, `LISTORA_SCANNED_CODES` scripts the bin scanner like Pack
check's (`LISTORA-BIN:B-12`).

## Tests

- `apps/api/src/storage-locations/codes.test.ts`: codes kept one way, refused characters, the
  next code, the order.
- `apps/api/src/storage-locations/storage-locations.int.test.ts`: the next code offered, codes
  never twice, putting in, moving, and taking out with each history entry, a run's items
  together, renaming and deleting, the bin on the sale and in Pack check, and another account.
- `Core` `BinCodeTests`: the sticker payload against item stickers, typed codes, the "Find it"
  words. `PackCheckFeatureTests` `BinsTests`: scanning a bin puts the item in it, an item sticker
  moves nothing, an unknown code becomes a new bin, a failed put shows no bin and retries the same
  request, taking out, a run's items together, a taken code, and the bin sticker.

## Data

`storage_location` (from schema v1): `code` (1 to 32 characters, unique per account), `label`,
and a `parent_id` no screen uses yet. `inventory_item.storage_location_id` points at it, cleared
when the bin is deleted.

## Follow-ups

- A bin's own screen could scan item stickers to put several items in at once.
- Nested locations (a shelf of bins) through `parent_id`.
- A bin to choose at Keep while scanning, for sellers who sort at the store.
