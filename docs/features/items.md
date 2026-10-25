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
  `packages/api-contract/components/schemas/items.yaml`.

## Data

- **Inventory:** `inventory_item` (status, canonical attributes, prices, cost,
  `field_provenance`, optimistic-lock `version`, and `pre_archive_status`, the status an
  archived item had before it was archived), `photo` (role, status, failure reason, hashes,
  derivatives, OCR and barcodes), and `storage_location`. `photo` stores the upright pixel
  `width` and `height`; each entry of `derivatives` records its key, size, byte size, and
  sha256.
- **History:** `audit_log` (item changes the user can see).
