# Pack check

An optional mode, off until the seller turns it on in Settings > Pack check, that checks each
package's shipping label before it ships. It answers the problem the product owner raised: a
printer that prints a label twice, and a label stuck on the wrong package, so one buyer gets two
packages and another none. Pack check only ever **reads** the marketplaces; it never changes a
listing or an order.

Code: `packages/pack-check` (the scan rules, the to-ship list, packing, label reads' records,
the setting), `packages/automation/src/label-reads` and each marketplace's `labels` script (the
reads themselves), `apps/api/src/pack-check`, the activity timeline's `package` entries
(`packages/activity`), and the iPhone's `PackCheckFeature` (with the "Print sticker" button in
`InventoryFeature`, "Pack orders" in `SalesFeature`, and the package photo in the sale's "How
Listora found it").

## The to-ship list

`listPackOrders` lists every sale that still stands and is not shipped (`detected` or
`confirmed`, sold in the last 60 days), newest first, at most 200, with its items (title, SKU,
shelf code, photo), the buyer's first name, the label, and whether it is packed. A packed order
stays on the list for a day, so a packing session shows what it packed. `labelStatus` and
`packStatus` are the server's words ("USPS •••• 8490 (from Depop)", "Packed 12 minutes ago
(label and sticker matched)"); the app shows them as given. The app opens it from Sales >
Pack orders (shown while Pack check is on) and from Settings > Pack check.

## Reading labels

A label's tracking number and the buyer's first name come from the marketplace's own order page,
read through the seller's session where the connection's automated steps run: on the seller's
iPhone for Depop, Poshmark, and Mercari ([phone-execution.md](phone-execution.md)). A read is
`phone_work` with purpose `label_read`, one per connection; the phone's claim picks up to 10
orders that need one (`ordersToRead`): unshipped, not packed, sold in the last 30 days, with no
label yet, and not read again sooner than 30 minutes after a read that found no label, 15 after
a failed read, or 6 hours after one that didn't find the order. The result is a `sale_label`
row per order. Reads are asked for when a sale check records a new sale (with Pack check on),
when Pack check is turned on, and each time the to-ship list opens (`refreshPackLabels`); the
app then runs the phone's work and lists the orders again a few times. A connection whose steps
run in the cloud is not read (no marketplace with a label read may run there today); its labels
are scanned instead.

What each marketplace's page gives, as read on the captain's accounts (2026-10-27):

| Marketplace | Where                                                                                                          | Verified                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mercari     | The order page, `/transaction/order_status/<item id>/` (the sold tab's "View order")                           | Read-only on the one real sale (delivered): the order was found and the buyer's first name read. Neither that page nor the help center's tracking page shows a tracking number for a delivered order, so it read as "no label". An open order's "Tracking" line is read where the shipping block shows one; not seen on a real order yet. |
| Depop       | The receipts Depop's sold items page loads, `webapi.depop.com/presentation/api/v1/receipts/?role=seller`       | The empty answer (`{"objects": [], "page_info": {"has_more": false}}`) is real; the account has no sale, so a receipt's fields are not. They are read by name only (`tracking_number`, the buyer's `first_name`); a receipt naming no id or product fails the read visibly and logs its structure (`element_missing` evidence).           |
| Poshmark    | `/order/sales` (the Seller Hub's sales), `$_order_list.userSales.data.sales_summary`, then an order's own page | The empty list ("You have not sold anything yet.") is real; the account never sold. Orders are read by field name as on Depop.                                                                                                                                                                                                            |

A read never guesses: a value counts only under a field that names it, and a number must be a
tracking number (`canonicalTracking`). A failed read leaves the order to be scanned.

## Scanning

The camera (VisionKit's `DataScannerViewController`: Code 128, QR, Data Matrix, PDF417, Code 39,
EAN-13) reads the label's barcode; the seller can also type the number. `checkPackScan` (only
reads) says what the scan means for the order being packed, or, with no order chosen, which order
the label is for:

- **The label's number** (`tracking.ts`): a USPS IMpb barcode is `420`, the ZIP, then the
  tracking number, often with a `]C1` symbology identifier or an FNC1 separator; those go
  (`canonicalTracking`). A scan matches a known number when it is that number or a longer barcode
  ending with it (FedEx), never a number shorter than 10 characters.
- **Verdicts** (`verdict.ts`): `match` (green: "This label is for the black Shaka Wear tee, 2XL";
  only this lets the app offer Packed), `wrong_order` (a red stop: "This label is for the Free
  People dress. Do not use it on this package."), `already_packed` (the label went on a package
  already: when, and on which order's), `sticker_mismatch`, `unknown_label` (Listora has no
  label for the order: the photo check), `sticker_scanned`, `not_a_label`, and `found`.
- **Item stickers**: scanning the item's sticker with the label makes the match exact (the item
  in the box is the order's); without one, the item's photo, shown large with every answer, is
  the seller's check.

## Packing

`packOrder` records which label went on the package, after checking the scan again inside the
transaction under a lock on the sale, so a stale screen or a second phone can't pack the wrong
label. The **duplicate-print guard** is the database's: `sale_pack` is unique per order and per
tracking number, so a label is packed once; a second print of it scanned on another package is
`already_packed` ("It went on the package for the black Shaka Wear tee, 2XL 12 minutes ago. If
your printer printed it twice, throw this copy away."). A label Listora doesn't know is packed
only with `photoCheck` (the seller compared the item with the order's photo): the scan becomes
the order's label (`source` `scan`), and a later marketplace read that shows another label
marks the package to check again (`labelMismatch`). `unpackOrder` takes it off to pack again.

The app packs one order (a card) or a batch (Pack all) in turn; ending a session names the
orders still not packed, so none is forgotten.

## Item stickers

Printed from the item screen ("Print sticker", and offered after listing while Pack check is
on) through AirPrint: a QR code holding `LISTORA:<SKU>`, the SKU, the shelf code, and the title,
on a 2.25 × 1.25 in or 2.125 × 1 in label roll (Dymo, Rollo, Zebra, Munbyn, Brother) or a letter
sheet of 30 (Avery 5160).

## Package photo

One optional photo of the open package with its label visible, for a claim: the app re-encodes
it without metadata (at most 1600 px) and uploads it through an upload session; `addPackPhoto`
decodes and re-encodes it again (`processImage`'s `listing` image: upright, no EXIF, no
location), stores it under an unguessable public name like an item's listing photos, and deletes
the upload. It shows in the sale's "How Listora found it" (the activity's `package` entries) and
in the packing screen; `removePackPhoto` deletes it, to take another.

## Packing slip

An optional slip for inside the package, printed through AirPrint on a 4 × 6 in label or a letter
page: "Thank you, Sarah!", the marketplace's order number, and each item's photo, title, and SKU.

## Permissions and wording

The camera is asked for with plain words first ("Listora reads the barcode with your camera. It
doesn't take or keep a picture."), then iOS's prompt (`NSCameraUsageDescription` names packing).
A camera turned off offers Settings and the typed number. Printing uses the system's AirPrint
sheet, which needs no permission; the sticker screen says it shows the printers on the Wi-Fi.

## Local development

Nothing needs a credential. The fake Depop site serves the receipts API with each sale's label
(`FakeDepopSite.sell(slug, soldAt, { trackingNumber, buyerFirstName })`). The local stack's control
endpoint seeds two orders to pack with the double-print fixtures (`POST /pack/orders`), and the
app's scanner reads `LISTORA_SCANNED_CODES` (codes separated by `|`) in UI tests. The
scanned-label fixtures are in `@listora/pack-check/testing`.

## Tests

- `packages/pack-check`: the barcode layouts (USPS IMpb with and without separators, ZIP+4, typed,
  UPS, FedEx), every verdict and its words, the double print, stickers, and naming.
- `apps/api/src/pack-check/pack-check.int.test.ts`: the list, green and red, the double print with
  when and which order, stickers, the photo check, the package photo in the sale's activity,
  unpacking, label reads asked of the phone, and tenancy.
- `packages/automation`: the label read run on the phone runtime against the fake Depop site and
  recorded (`phone/work.int.test.ts`), and the pages' parsers (`label-reads/parsers.test.ts`).
- iPhone: `PackCheckFeatureTests` (sessions, the double print, the end-of-session summary, retries,
  settings, stickers, slips, the photo's metadata) and `PackCheckUITests` (the whole flow on the
  local stack with scanned-label fixtures).

## Data

Migration `20261027234658_pack_check`:

- `pack_check_setting`: one per account, `enabled` (false by default).
- `sale_label`: one per sale: `tracking_number` (canonical), `carrier`, `source` (`marketplace` or
  `scan`), `buyer_first_name` (the first name only; never the buyer's full name or address), and
  the last read's `read_status`, `read_error`, and `read_at`.
- `sale_pack`: one per sale and per tracking number: `matched_by` (`sticker`, `label`, `photo`),
  `sticker_sku`, `packed_by_user_id`, `packed_at`, and the package photo's `photo_key` and
  `photo_added_at`.
- `phone_work.purpose` and `automation_run.purpose` gain `label_read`.

All of it is deleted with the account (the package photos with it); the photos also go when the
seller removes them or unpacks the order.

## Open items

- Depop's and Poshmark's label reads are mapped from their empty pages only; map them against a
  real sale's receipt and order page when one exists (the reads fail visibly until then if the
  shape differs). The same for an open Mercari order's tracking line.
- Delivering package photos through signed URLs instead of unguessable public ones, once storage
  has signed reads.
- eBay's labels (its Fulfillment API) are not read; eBay orders are packed with the photo check.
