/**
 * Photos for sold items that have none (docs/features/sales.md, "Sales history"). A sold item
 * made from an order line without its listing (a check by an app built before sold items, which
 * sent no sold listing) has only the line's title and price. A later check that reads the same
 * order with its sold listing hands the order over no more (its sale is recorded), so the photos
 * the listing shows reach the item this way instead: the check stores the order once more as an
 * `inbound_event` (`photos:order:<id>:<run>`) and queues `automation_sold_item_photos` for it,
 * and the worker fetches the photos from the marketplace's image CDN (`SoldItemMaker`,
 * @listora/imports) and adds them to each item that still has none, processed like any photo
 * (its thumbnail and listing size). Nothing on the marketplace changes, and no extra page is
 * read: the photos are the ones the check's own read showed.
 *
 * Each check that reads such an order tries again, so a photo the CDN didn't give this time can
 * come with the next; an item that got photos is never asked about again.
 */
import { z } from 'zod';

import {
  addJob,
  inTransaction,
  type Db,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
} from '@listora/db';
import type { RemoteOrder } from '@listora/marketplaces';
import { finishInboundEvent, recordInboundEvent } from '@listora/sales';
import type { Logger } from '@listora/shared';

import { orderEventPayload } from './orders.ts';

/** The worker task that adds sold items' photos from their sold listings. */
export const SOLD_ITEM_PHOTOS_TASK = 'automation_sold_item_photos';

export interface SoldItemPhotosJobPayload {
  accountId: string;
  inboundEventId: string;
}

export function isSoldItemPhotosJobPayload(value: unknown): value is SoldItemPhotosJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, inboundEventId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof inboundEventId === 'string';
}

/**
 * Fetches photos and adds them to an item (@listora/imports, wired by the worker): `fetch`
 * before any transaction, `add` in one. Null or empty from `fetch`: none could be fetched.
 */
export interface SoldItemPhotoMaker<Fetched = unknown> {
  fetch(photoUrls: readonly string[]): Promise<Fetched | null>;
  add(trx: DbTransaction, accountId: string, itemId: string, fetched: Fetched): Promise<number>;
}

/** An order line's sold listing and the photos it shows. */
interface PhotoLine {
  externalListingId: string;
  photoUrls: string[];
}

/** A recorded order's item without photos, and the line its sold listing is. */
interface ItemWithoutPhotos {
  itemId: string;
  externalListingId: string;
}

/**
 * Stores the order for its sold items' photos and queues the worker's job, in the caller's
 * transaction, when a line's sold listing shows photos and the line's item has none. Returns
 * whether it did.
 */
export async function queueSoldItemPhotos(
  trx: DbTransaction,
  check: { accountId: string; connectionId: string; marketplace: Marketplace; runId: string },
  order: RemoteOrder,
): Promise<boolean> {
  const lines = photoLines(
    order.items.map((item) => ({
      externalListingId: item.externalListingId,
      photoUrls: item.listing?.details.photoUrls,
    })),
  );
  if (lines.length === 0) return false;
  const items = await itemsWithoutPhotos(
    trx,
    check.accountId,
    check.marketplace,
    order.externalOrderId,
    lines,
  );
  if (items.length === 0) return false;
  const event = await recordInboundEvent(trx, {
    accountId: check.accountId,
    source: 'poll',
    marketplace: check.marketplace,
    providerEventId: `photos:order:${order.externalOrderId}:${check.runId}`.slice(0, 255),
    signatureOk: null,
    // `purpose` tells the activity timeline it is for photos, not a sale to record.
    payload: { ...orderEventPayload(check.connectionId, order, check.runId), purpose: 'photos' },
    externalUserId: null,
  });
  if (event.duplicate) return false;
  await addJob(trx, {
    task: SOLD_ITEM_PHOTOS_TASK,
    payload: { accountId: check.accountId, inboundEventId: event.id },
    jobKey: `inbound:${event.id}`,
  });
  return true;
}

export interface SoldItemPhotosDependencies {
  db: Db;
  logger: Logger;
  photos: SoldItemPhotoMaker;
}

/** The order the event stored: its id and each line's sold listing photos. */
const photosEventSchema = z.object({
  externalOrderId: z.string().min(1),
  items: z.array(
    z.object({
      externalListingId: z.string().nullable(),
      listing: z
        .object({ details: z.object({ photoUrls: z.array(z.string()) }) })
        .optional()
        .catch(undefined),
    }),
  ),
});

/**
 * The worker's side: adds each item of the event's order that still has no photos its sold
 * listing's photos, and finishes the event `processed` (an item got photos) or `ignored`.
 */
export async function addSoldItemPhotos(
  deps: SoldItemPhotosDependencies,
  payload: SoldItemPhotosJobPayload,
): Promise<void> {
  const log = deps.logger.child({
    task: SOLD_ITEM_PHOTOS_TASK,
    inboundEventId: payload.inboundEventId,
  });
  const event = await deps.db
    .selectFrom('inbound_event')
    .select(['id', 'marketplace', 'payload', 'processed_at'])
    .where('account_id', '=', payload.accountId)
    .where('id', '=', payload.inboundEventId)
    .executeTakeFirst();
  // Finished before (the job ran again), or deleted with the account.
  if (event?.processed_at !== null) return;
  const parsed = photosEventSchema.safeParse(event.payload);
  const order = parsed.success ? parsed.data : { externalOrderId: '', items: [] };
  const lines = photoLines(
    order.items.map((item) => ({
      externalListingId: item.externalListingId,
      photoUrls: item.listing?.details.photoUrls,
    })),
  );
  const wanted =
    lines.length === 0
      ? []
      : await itemsWithoutPhotos(
          deps.db,
          payload.accountId,
          event.marketplace,
          order.externalOrderId,
          lines,
        );
  // Each item's photos are fetched outside any transaction, then added while it still has none
  // (its row locked first, so two jobs never both add them).
  let added = 0;
  for (const item of wanted) {
    const line = lines.find((each) => each.externalListingId === item.externalListingId);
    if (line === undefined) continue;
    const fetched = await deps.photos.fetch(line.photoUrls);
    if (fetched === null) continue;
    added += await inTransaction(deps.db, async (trx) => {
      await trx
        .selectFrom('inventory_item')
        .select('id')
        .where('account_id', '=', payload.accountId)
        .where('id', '=', item.itemId)
        .forUpdate()
        .execute();
      const still = await itemsWithoutPhotos(
        trx,
        payload.accountId,
        event.marketplace,
        order.externalOrderId,
        [line],
      );
      if (!still.some((each) => each.itemId === item.itemId)) return 0;
      return deps.photos.add(trx, payload.accountId, item.itemId, fetched);
    });
  }
  await finishInboundEvent(
    deps.db,
    payload.accountId,
    event.id,
    added > 0 ? 'processed' : 'ignored',
  );
  log.info(
    { event: 'sold_item_photos', marketplace: event.marketplace, items: wanted.length, added },
    'sold item photos settled',
  );
}

function photoLines(
  items: readonly { externalListingId: string | null; photoUrls: readonly string[] | undefined }[],
): PhotoLine[] {
  return items.flatMap((item) =>
    item.externalListingId === null || item.photoUrls === undefined || item.photoUrls.length === 0
      ? []
      : [{ externalListingId: item.externalListingId, photoUrls: [...item.photoUrls] }],
  );
}

/** The items of the recorded order whose line is one of `lines` and which have no photos. */
async function itemsWithoutPhotos(
  executor: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
  externalOrderId: string,
  lines: readonly PhotoLine[],
): Promise<ItemWithoutPhotos[]> {
  const rows = await executor
    .selectFrom('sale')
    .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
    .innerJoin('marketplace_listing', 'marketplace_listing.id', 'sale_item.listing_id')
    .select(['sale_item.item_id as itemId', 'marketplace_listing.external_listing_id'])
    .where('sale.account_id', '=', accountId)
    .where('sale.marketplace', '=', marketplace)
    .where('sale.external_order_id', '=', externalOrderId)
    .where(
      'marketplace_listing.external_listing_id',
      'in',
      lines.map((line) => line.externalListingId),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('photo')
            .select('photo.id')
            .where('photo.account_id', '=', accountId)
            .whereRef('photo.item_id', '=', 'sale_item.item_id'),
        ),
      ),
    )
    .execute();
  return rows.flatMap((row) =>
    row.external_listing_id === null
      ? []
      : [{ itemId: row.itemId, externalListingId: row.external_listing_id }],
  );
}
