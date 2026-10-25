import type {
  InteractionTotals,
  ItemBatch,
  ItemBatchItem,
  ItemBatchProgress,
} from '@listora/api-contract';
import {
  batchItemFacts,
  batchProgress,
  describeBatchItem,
  interactionOf,
  listBatchItems,
  type BatchItemRow,
  type BatchRow,
  type Interaction,
} from '@listora/batches';
import type { DbExecutor } from '@listora/db';

import { coverPhotoRows } from '../items/repository.ts';
import { itemSummaryView, type ItemViewContext } from '../items/views.ts';
import { itemListingRows } from '../listings/repository.ts';
import { listingStates } from '../listings/views.ts';
import type { Tenant } from '../tenancy.ts';
import { itemRowsById } from './repository.ts';

/** The batch with every item's state, and how many items are in each. */
export async function batchView(
  db: DbExecutor,
  tenant: Tenant,
  batch: BatchRow,
  context: ItemViewContext,
): Promise<ItemBatch> {
  const items = await batchItemViews(
    db,
    tenant,
    await listBatchItems(db, tenant.accountId, batch.id),
    context,
  );
  const interaction = interactionOf(batch);
  return {
    id: batch.id,
    items: items.map(({ view }) => view),
    progress: progressView(batchProgress(items.map(({ state }) => state))),
    ...(interaction === undefined ? {} : { interaction: interactionView(interaction) }),
    createdAt: batch.created_at.toISOString(),
    updatedAt: batch.updated_at.toISOString(),
  };
}

export async function batchItemView(
  db: DbExecutor,
  tenant: Tenant,
  row: BatchItemRow,
  context: ItemViewContext,
): Promise<ItemBatchItem> {
  const [item] = await batchItemViews(db, tenant, [row], context);
  if (item === undefined) throw new Error(`batch item ${row.item_id} has no item`);
  return item.view;
}

/**
 * The views of `rows`, in their order, read in a fixed number of queries whatever the batch's
 * size. Each item's state is worked out from its rows now (`describeBatchItem`).
 */
async function batchItemViews(
  db: DbExecutor,
  tenant: Tenant,
  rows: readonly BatchItemRow[],
  context: ItemViewContext,
): Promise<{ view: ItemBatchItem; state: ReturnType<typeof describeBatchItem>['state'] }[]> {
  const ids = rows.map((row) => row.item_id);
  const [items, covers, listingRows, facts] = await Promise.all([
    itemRowsById(db, tenant, ids),
    coverPhotoRows(db, tenant, ids),
    itemListingRows(db, tenant, ids),
    batchItemFacts(db, tenant.accountId, rows),
  ]);
  const listings = Map.groupBy(
    await listingStates(db, tenant, [...listingRows.values()].flat()),
    (state) => state.row.item_id,
  );
  return rows.flatMap((row) => {
    const item = items.get(row.item_id);
    const itemFacts = facts.get(row.item_id);
    // The item and its batch row go together (the foreign key cascades).
    if (item === undefined || itemFacts === undefined) return [];
    const status = describeBatchItem(itemFacts);
    const interaction = interactionOf(row);
    const view: ItemBatchItem = {
      position: row.position,
      item: itemSummaryView(item, covers.get(item.id), context.storage, listings.get(item.id)),
      state: status.state,
      statusDisplay: status.display,
      photos: {
        total: itemFacts.photos.length,
        ready: itemFacts.photos.filter((photo) => photo.status === 'ready').length,
      },
      ...(status.problem === undefined ? {} : { problem: status.problem }),
      ...(interaction === undefined ? {} : { interaction: interactionView(interaction) }),
    };
    return [{ view, state: status.state }];
  });
}

function progressView(progress: ReturnType<typeof batchProgress>): ItemBatchProgress {
  return {
    total: progress.total,
    uploading: progress.uploading,
    preparingPhotos: progress.preparing_photos,
    analyzing: progress.analyzing,
    readyForReview: progress.ready_for_review,
    saved: progress.saved,
    failed: progress.failed,
  };
}

function interactionView(interaction: Interaction): InteractionTotals {
  return {
    activeMs: interaction.activeMs,
    waitingMs: interaction.waitingMs,
    taps: interaction.taps,
  };
}
