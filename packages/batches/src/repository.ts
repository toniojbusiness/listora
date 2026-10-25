/**
 * `item_batch` and `item_batch_item` rows. Every function filters on the account, so another
 * account's batch reads as missing.
 */
import type { DbExecutor, ItemBatchItemTable, ItemBatchTable, ItemStatus } from '@listora/db';
import { photoSetHash } from '@listora/shared';
import type { Selectable } from 'kysely';

import type { BatchJobQueue } from './queue.ts';
import type { BatchItemFacts, BatchItemProblem } from './status.ts';

export type BatchRow = Selectable<ItemBatchTable>;
export type BatchItemRow = Selectable<ItemBatchItemTable>;

/** The most items one batch holds (positions 0 to 999). */
export const MAX_BATCH_ITEMS = 1000;

export async function insertBatch(
  db: DbExecutor,
  accountId: string,
  userId: string | null,
): Promise<BatchRow> {
  return db
    .insertInto('item_batch')
    .values({ account_id: accountId, created_by_user_id: userId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findBatch(
  db: DbExecutor,
  accountId: string,
  batchId: string,
): Promise<BatchRow | undefined> {
  return db
    .selectFrom('item_batch')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('id', '=', batchId)
    .executeTakeFirst();
}

/** Locks the batch row, which orders concurrent additions of items at the same position. */
export async function lockBatch(
  db: DbExecutor,
  accountId: string,
  batchId: string,
): Promise<BatchRow | undefined> {
  return db
    .selectFrom('item_batch')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();
}

/** The batch's items in haul order. */
export async function listBatchItems(
  db: DbExecutor,
  accountId: string,
  batchId: string,
): Promise<BatchItemRow[]> {
  return db
    .selectFrom('item_batch_item')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('batch_id', '=', batchId)
    .orderBy('position')
    .execute();
}

export async function findBatchItem(
  db: DbExecutor,
  accountId: string,
  batchId: string,
  itemId: string,
): Promise<BatchItemRow | undefined> {
  return db
    .selectFrom('item_batch_item')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('batch_id', '=', batchId)
    .where('item_id', '=', itemId)
    .executeTakeFirst();
}

export async function findBatchItemAt(
  db: DbExecutor,
  accountId: string,
  batchId: string,
  position: number,
): Promise<BatchItemRow | undefined> {
  return db
    .selectFrom('item_batch_item')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('batch_id', '=', batchId)
    .where('position', '=', position)
    .executeTakeFirst();
}

export async function insertBatchItem(
  db: DbExecutor,
  row: { accountId: string; batchId: string; itemId: string; position: number },
): Promise<BatchItemRow> {
  return db
    .insertInto('item_batch_item')
    .values({
      account_id: row.accountId,
      batch_id: row.batchId,
      item_id: row.itemId,
      position: row.position,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Records that the app attached all `photoCount` photos of the item and queues the job that
 * starts its analysis, in the caller's transaction. Submitting again (the seller's Retry) clears
 * the last start error and queues the job again.
 */
export async function submitBatchItem(
  trx: DbExecutor,
  jobs: BatchJobQueue,
  submission: {
    accountId: string;
    batchId: string;
    itemId: string;
    photoCount: number;
    now: Date;
  },
): Promise<BatchItemRow> {
  const row = await trx
    .updateTable('item_batch_item')
    .set({
      submitted_at: submission.now,
      photo_count: submission.photoCount,
      start_error_code: null,
      start_error_message: null,
      start_error_retryable: null,
    })
    .where('account_id', '=', submission.accountId)
    .where('batch_id', '=', submission.batchId)
    .where('item_id', '=', submission.itemId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await jobs.enqueue(trx, {
    accountId: submission.accountId,
    batchId: submission.batchId,
    itemId: submission.itemId,
  });
  return row;
}

/** Why the worker did not start the item's analysis, until the next submit. */
export async function recordStartError(
  db: DbExecutor,
  key: { accountId: string; batchId: string; itemId: string },
  error: BatchItemProblem,
): Promise<void> {
  await db
    .updateTable('item_batch_item')
    .set({
      start_error_code: error.code,
      start_error_message: error.message,
      start_error_retryable: error.retryable,
    })
    .where('account_id', '=', key.accountId)
    .where('batch_id', '=', key.batchId)
    .where('item_id', '=', key.itemId)
    .where('submitted_at', 'is not', null)
    .execute();
}

/** Measured interaction: active and waiting time in milliseconds, and taps. */
export interface Interaction {
  activeMs: number;
  waitingMs: number;
  taps: number;
}

/**
 * Replaces the batch's measured interaction and each listed item's share of it; items left out
 * have none. Returns the ids listed that are not items of the batch (nothing is written then).
 */
export async function replaceInteraction(
  trx: DbExecutor,
  key: { accountId: string; batchId: string },
  batch: Interaction,
  items: readonly ({ itemId: string } & Interaction)[],
): Promise<{ unknownItemIds: string[] }> {
  const members = new Set(
    (await listBatchItems(trx, key.accountId, key.batchId)).map((row) => row.item_id),
  );
  const unknownItemIds = items.map((item) => item.itemId).filter((id) => !members.has(id));
  if (unknownItemIds.length > 0) return { unknownItemIds };
  await trx
    .updateTable('item_batch')
    .set({ active_ms: batch.activeMs, waiting_ms: batch.waitingMs, taps: batch.taps })
    .where('account_id', '=', key.accountId)
    .where('id', '=', key.batchId)
    .execute();
  await trx
    .updateTable('item_batch_item')
    .set({ active_ms: null, waiting_ms: null, taps: null })
    .where('account_id', '=', key.accountId)
    .where('batch_id', '=', key.batchId)
    .execute();
  for (const item of items) {
    await trx
      .updateTable('item_batch_item')
      .set({ active_ms: item.activeMs, waiting_ms: item.waitingMs, taps: item.taps })
      .where('account_id', '=', key.accountId)
      .where('batch_id', '=', key.batchId)
      .where('item_id', '=', item.itemId)
      .execute();
  }
  return { unknownItemIds: [] };
}

export function interactionOf(row: {
  active_ms: number | null;
  waiting_ms: number | null;
  taps: number | null;
}): Interaction | undefined {
  if (row.active_ms === null || row.waiting_ms === null || row.taps === null) return undefined;
  return { activeMs: row.active_ms, waitingMs: row.waiting_ms, taps: row.taps };
}

/**
 * What `describeBatchItem` needs for each of `rows`, read in three queries whatever the batch's
 * size: the items' statuses, their photos, and the standard analyses of their current photo sets.
 */
export async function batchItemFacts(
  db: DbExecutor,
  accountId: string,
  rows: readonly BatchItemRow[],
): Promise<Map<string, BatchItemFacts>> {
  const itemIds = rows.map((row) => row.item_id);
  if (itemIds.length === 0) return new Map();
  const [items, photos, analyses] = await Promise.all([
    db
      .selectFrom('inventory_item')
      .select(['id', 'status'])
      .where('account_id', '=', accountId)
      .where('id', 'in', itemIds)
      .execute(),
    db
      .selectFrom('photo')
      .select(['item_id', 'status', 'failure_reason', 'sha256'])
      .where('account_id', '=', accountId)
      .where('item_id', 'in', itemIds)
      .orderBy('item_id')
      .orderBy('position')
      .execute(),
    db
      .selectFrom('ai_analysis')
      .select([
        'item_id',
        'photo_set_hash',
        'status',
        'error_code',
        'error_message',
        'error_retryable',
      ])
      .where('account_id', '=', accountId)
      .where('item_id', 'in', itemIds)
      .where('tier', '=', 'standard')
      .execute(),
  ]);
  const statuses = new Map<string, ItemStatus>(items.map((item) => [item.id, item.status]));
  const photosByItem = Map.groupBy(photos, (photo) => photo.item_id);
  const analysesByItem = Map.groupBy(analyses, (analysis) => analysis.item_id);
  const facts = new Map<string, BatchItemFacts>();
  for (const row of rows) {
    const status = statuses.get(row.item_id);
    if (status === undefined) continue;
    const itemPhotos = photosByItem.get(row.item_id) ?? [];
    const hashes = itemPhotos.flatMap((photo) => (photo.sha256 === null ? [] : [photo.sha256]));
    const hash = hashes.length > 0 ? photoSetHash(hashes) : undefined;
    const analysis = (analysesByItem.get(row.item_id) ?? []).find(
      (candidate) => candidate.photo_set_hash === hash,
    );
    facts.set(row.item_id, {
      itemStatus: status,
      submitted: row.submitted_at !== null,
      photos: itemPhotos.map((photo) => ({
        status: photo.status,
        failureReason: photo.failure_reason,
      })),
      startError:
        row.start_error_code === null ||
        row.start_error_message === null ||
        row.start_error_retryable === null
          ? undefined
          : {
              code: row.start_error_code,
              message: row.start_error_message,
              retryable: row.start_error_retryable,
            },
      analysis:
        analysis === undefined
          ? undefined
          : {
              status: analysis.status,
              errorCode: analysis.error_code,
              errorMessage: analysis.error_message,
              errorRetryable: analysis.error_retryable,
            },
    });
  }
  return facts;
}
