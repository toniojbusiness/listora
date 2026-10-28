# Batch listing

A reseller photographs a whole haul (say 20 items) in one continuous session, and Listora turns
it into one draft item per physical item with almost no extra taps: the photos are split into
items as they are taken, the seller checks the grouping, every item uploads and is analyzed in the
background while they keep shooting, and a swipe-through review approves each item in one tap.

| Part                             | Where                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Grouping rules (pure)            | `BatchGrouper` in `apps/ios/Packages/Core/Sources/Core/Batch`                                          |
| On-device photo signals (Vision) | `VisionPhotoSignalReader` in the `PhotoSignalsFeature` package target                                  |
| Capture, grouping, batch screen  | `AddItemFeature/Batch` (`BatchCaptureView`, `BatchGroupingView`, `BatchView`, the store)               |
| Rapid review                     | `ReviewFeature/Batch` (`BatchReviewView`, `BatchReviewModel`)                                          |
| Batch resource and its job       | `packages/batches` (`@listora/batches`), `apps/api/src/batches`, `apps/worker/src/features/batches.ts` |
| Contract                         | `packages/api-contract/paths/batches.yaml`, `components/schemas/batches.yaml`                          |

## Capture

Add Item has a **One item / Batch** switch above its actions. In Batch mode, **Shoot a batch**
opens the batch camera and **Import a batch** picks up to 200 photos from the library, in the
order picked. The seller shoots each item's front, back, and tag, one item after another. Every
photo is prepared as in single-item capture (upright, at most 2048 px, no metadata) and saved to
the batch on the iPhone at once, so a crash or a relaunch loses nothing. A blurry shot shows
**Retake** without stopping the session.

The prompt names the item being shot ("Item 3 · 2 photos"). **Next item** (or a swipe to the
left) starts the next item by hand; otherwise Listora starts one when it sees one, and says so.
**Done** groups the session's photos and opens the grouping check. Closing the camera asks whether
to discard the new photos or check them.

## Telling items apart

`VisionPhotoSignalReader` reads two cheap signals from each photo on the device, at 640 px:
Vision's image feature print (photos of one item have nearby prints) and how much printed text
the photo has (fast text recognition; 12 characters or fewer is a garment, 40 or more surely a tag
close-up). `BatchGrouper` then decides, photo by photo, whether it starts a new item:

- The seller's **Next item** always does. A **tag** close-up never does: the guide asks for the tag
  last, so it belongs to the item being shot.
- Any other photo is compared with the current item's photos that are not tags (the nearest print
  counts): a distance of 0.35 or less reads as the same item, 0.85 or more as a different one.
- The way a haul is shot weighs in: the photo right after a tag (+0.35), an item's third full shot
  (+0.15), and a pause of 20 seconds or more (+0.25) lean toward a new item; an item's second shot,
  usually its back (-0.15), toward the same one.
- A score of 0.45 or more starts a new item. Confidence is the distance from 0.45, full at 0.25
  away. **Two items are never merged quietly**: an even call splits, and every decision under 0.5
  confidence is highlighted for the seller ("Item 3 may be the same item as item 2", or "Photo 3
  may start a new item").
- With no feature print to compare (reading failed, or the simulator), only the shooting pattern
  decides, from an even 0.5, and every such decision is highlighted for the seller to check.
- How fast the seller shoots counts only as a long pause. A quick shot right after another is no
  reason to merge: look-alike items shot quickly would otherwise be merged without a flag.

The thresholds are calibrated on the synthetic hauls in
`Packages/Features/Tests/PhotoSignalsFeatureTests/Fixtures` (rendered by
`make ios-batch-fixtures`): an item's front and back are 0.13 to 0.58 apart, different items 0.62
to 1.12, but two look-alike navy tees only 0.48, which is why the shooting pattern decides close
calls. Check them against real hauls (follow-up). Each photo's role comes from the same signals: a
tag-like photo is the tag, the first two others the front and back, the rest details.

**The simulator computes no feature prints.** Its default compute device fails ("Failed to
create espresso context"), and its CPU gives nearly the same print for any photo (0.002 apart), so
there `VisionPhotoSignalReader.readsFeaturePrints` is false and the reader reports none: grouping
in the simulator (the UI test) runs on tags and the shooting pattern, with every boundary to
check. The grouping of real prints is tested on prints of the fixture hauls recorded with Vision on
a Mac (`CoreTests/Fixtures/batch-signals.json`, `Tools/record-batch-signals.swift`, also run by
`make ios-batch-fixtures`), and on live prints on a device.

## Checking the grouping

`BatchGroupingView` shows one card per proposed item with its photos. A photo drags onto another
item; tapping it offers **Start a new item here**, **Move to item N**, **Make it an item of its
own**, and **Remove photo**; an item's menu merges it into the one before. Close calls sit between
or inside the cards with their two answers. **Create N items** turns every stack into a draft of
the batch (refused while an item has more than 24 photos), and **Keep shooting** opens the camera
again: the new photos are grouped after the stacks the seller already has, which never change.

## Uploads and analyses in the background

A confirmed stack is a draft like any other (`docs/features/photos.md`, the upload queue in
`apps/ios/README.md`) with its batch and position. The upload queue (`UploadPlanner`) creates the
server batch (`createItemBatch`), each draft's item in it at its position (`addItemBatchItem`,
with the draft's stored key), uploads and attaches the photos (tag photos read on the device
first), and, once every photo is attached in order, submits the item (`submitItemBatchItem`). A
batch draft whose photos change is submitted again. The seller keeps shooting meanwhile.

On the server, a submit queues the `batch_item_analysis` job (`@listora/batches`) in the worker's
task pool, next to photo processing and the analyses themselves, never in the operation steps'
pool. The job starts the item's analysis as soon as its photos are processed, under the same rules
as `startItemAnalysis`: the photo set's existing analysis is kept (never paid for twice), a failed
one is queued again, and the AI guards are checked first. A refusal (the day's AI budget, the
plan's quota, AI switched off, an account block) is recorded on the item instead of queued. While
photos process, the job checks again 2 seconds later; after 15 minutes it stops with a retryable
reason, so nothing waits forever.

**Idempotent re-submits.** An item's position in its batch is unique: adding at a taken position
answers `200` with the item already there. So an app that sends its batch again, even after the
24-hour `Idempotency-Key` window, never creates a second item; a draft deleted on the iPhone whose
add answer never arrived finds its server item the same way, and deletes it. Submitting again is
always safe and is the item's Retry.

## The batch screen

`BatchView` lists the batch's items in haul order. An item shows its upload on the iPhone until
the server has every photo, then the server's own `statusDisplay`, word for word:

| State              | Label (tone)                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploading`        | Uploading photos... (in progress)                                                                                                                   |
| `preparing_photos` | Preparing photos (2 of 3)... (in progress)                                                                                                          |
| `analyzing`        | Analyzing... (in progress)                                                                                                                          |
| `ready_for_review` | Ready to review (action needed)                                                                                                                     |
| `saved`            | Saved (success: the seller saved it)                                                                                                                |
| `failed`           | Photo failed - replace it, Analysis failed - Retry, Couldn't start the analysis - Retry, or Paused - today's AI budget is used up (with the reason) |

Every state is worked out from the rows (the item, its photos, the analysis of its current photo
set, the batch item) each time the batch is read (`describeBatchItem`), so it never disagrees with
them. The screen reads the batch every 2 seconds while it shows. An item still analyzing after 5
minutes says "Taking longer than usual - Retry". Retry submits a failed item again; a failed photo
offers **Edit photos** (the draft's editor). **Review N items** opens the rapid review of every
item analyzed or being analyzed. Deleting the batch deletes its photos and its unsaved items;
saved items stay in the inventory.

## Rapid review

`BatchReviewView` swipes through the items. Each page is the single-item review's model
(`ReviewFlowModel`, [review.md](review.md)), so an item goes through the same analysis, details,
cost, and price rules: its photos, then only what Listora was unsure about ("Check these",
editable in place), the cost on the in-app keypad (open on the first item) with where it was
bought, and the price tiers with the recommended one chosen and the server's own label. **Apply to
all N items** gives every item still to approve its cost in one tap: all of them marked as one
haul whose total is split across them ("One $12 haul: $4.00 each", a saved haul,
[hauls.md](hauls.md)), or the same amount each, with the date and source. **Approve at $26.00 & next** saves the edits, the cost, then the price (after the cost's
floors are known), the highest floor, and status `ready` with its SKU, and shows the next item not
yet approved. **Skip for now** comes back to the item after the others. A refusal stays on the
item with the server's message.

## Instrumentation

The batch's own screens (capture, grouping, the batch) are measured in one `InteractionMeter`
session (`batch-<id>`), and each item's review page in the item's own session (its draft's id),
counted only while that page shows. The summary after the last item shows the whole batch's
active time and taps and the time per item, against the goal of about 30 seconds an item. The app
sends the measurement with `replaceItemBatchInteraction` (a full replacement, sent again whenever
it changes): the batch's total (its screens plus every saved item's review) and each saved item's
own review.

## Local development and tests

Nothing needs a credential: the local stack's worker runs the batch job, and the fake AI answers
the analyses.

- `apps/api/src/batches/batches.int.test.ts`: positions and re-submits, the submit's photo count,
  the job (waiting for photos, starting, keeping an existing analysis, guard refusals, a failed
  photo, the photo deadline), saved items, the interaction, deletion, and tenancy.
- `packages/batches/src/status.test.ts`: every state rule.
- `CoreTests/BatchGroupingTests`: the grouping rules on hand-made signals.
- `CoreTests/BatchFixtureGroupingTests`: grouping the fixture hauls' recorded Vision signals (a
  haul with tags, one without, and two look-alikes, which must never be merged quietly), at a
  seller's pace and at the fake camera's.
- `PhotoSignalsFeatureTests`: the reader on the fixture photos (tags read as tags), and grouping
  on live prints, which runs on a device.
- `AddItemFeatureTests/BatchTests`: the batch store (grouping edits, confirming, deletion) and the
  upload queue's batch steps against the fake server.
- `ReviewFeatureTests/BatchReviewTests`: approve and next, the same cost each, the batch marked as
  one haul (and its retry), skipping, refusals, and measuring only the page showing.
- `BatchListingUITests`: a 3-item haul shot with the fake camera (`ListoraUITests/BatchFixtures`),
  grouped, uploaded and analyzed on the local stack, reviewed with the three marked as one haul,
  and saved with SKUs, each costing its share.

## Data

- **Server:** `item_batch` (the batch, who created it, and the seller's measured interaction) and
  `item_batch_item` (one row per item: its unique position, when the app submitted it and with how
  many photos, the reason the job did not start its analysis, and the item's measured interaction).
  Deleting an item removes it from its batch; deleting the account deletes both.
- **iPhone (GRDB, migration "v2: batches"):** `batch` (its server id, keys, next position, the
  measured interaction and whether the server has it), `batchStack` and `batchShot` (the photos
  and their grouping until the seller confirms it), and on `draft` the batch, position, and the
  photos last submitted.

## Follow-ups

- Calibrate the grouping thresholds on real hauls, and consider uploading a batch's photo bytes
  before the grouping is confirmed.
- Resume a paused item on its own once the day's AI budget resets, instead of on Retry.
- A list of batches on the server (`GET /v1/item-batches`) for a second device.
