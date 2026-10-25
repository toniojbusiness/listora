import type { FieldError } from '@listora/api-contract';
import {
  findBatch,
  findBatchItem,
  findBatchItemAt,
  insertBatch,
  insertBatchItem,
  lockBatch,
  replaceInteraction,
  submitBatchItem,
  type BatchJobQueue,
} from '@listora/batches';
import { inTransaction, type InventoryItem } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import {
  changedDetails,
  columnsFromDetails,
  detailsFromRow,
  normalizeDetails,
  provenanceAfterWrite,
} from '../items/details.ts';
import { insertItem, lockItem } from '../items/repository.ts';
import { translateWriteError } from '../items/routes.ts';
import type { ListingViewContext } from '../listings/views.ts';
import { listPhotoRows } from '../photos/repository.ts';
import { batchItemView, batchView } from './views.ts';

export interface BatchRouteDependencies extends RouteDependencies {
  /** Photo URLs in the items' summaries. */
  storage: ObjectStorage;
  /** Each marketplace's capabilities, for the items' listings. */
  connections: ListingViewContext;
  /** Where submitting an item adds the job that starts its analysis. */
  batchJobs: BatchJobQueue;
  now: () => Date;
}

/**
 * Batches (docs/features/batch.md): `createItemBatch`, `getItemBatch`, `addItemBatchItem`,
 * `submitItemBatchItem`, `replaceItemBatchInteraction`. An item joins a batch at a position,
 * which it keeps: adding at a taken position returns the item there, so a batch submitted again
 * never gets a second item. A submit records that every photo is attached and queues the job
 * that starts the analysis once the photos are processed (@listora/batches).
 */
export function registerBatchRoutes(app: FastifyInstance, deps: BatchRouteDependencies): void {
  contractRoute(app, deps, 'createItemBatch', async ({ tenant, db }) => {
    const batch = await insertBatch(db, tenant.accountId, tenant.userId);
    return { status: 201, body: await batchView(db, tenant, batch, deps) };
  });

  contractRoute(app, deps, 'getItemBatch', async ({ tenant, db, params }) => {
    const batch = await findBatch(db, tenant.accountId, params.batchId);
    if (!batch) throw notFound('Batch');
    return { status: 200, body: await batchView(db, tenant, batch, deps) };
  });

  contractRoute(app, deps, 'addItemBatchItem', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      // The batch lock orders concurrent additions at one position.
      const batch = await lockBatch(trx, tenant.accountId, params.batchId);
      if (!batch) throw notFound('Batch');
      const existing = await findBatchItemAt(trx, tenant.accountId, batch.id, body.position);
      if (existing) return { status: 200, body: await batchItemView(trx, tenant, existing, deps) };

      const details = normalizeDetails(undefined);
      let item: InventoryItem;
      try {
        item = await insertItem(
          trx,
          tenant,
          columnsFromDetails(details),
          provenanceAfterWrite(details, undefined),
        );
      } catch (error) {
        throw translateWriteError(error);
      }
      await writeAudit(trx, tenant, {
        itemId: item.id,
        action: 'item.created',
        changes: {
          sku: item.sku,
          batchId: batch.id,
          batchPosition: body.position,
          ...changedDetails({}, detailsFromRow(item)),
        },
      });
      const row = await insertBatchItem(trx, {
        accountId: tenant.accountId,
        batchId: batch.id,
        itemId: item.id,
        position: body.position,
      });
      return { status: 201, body: await batchItemView(trx, tenant, row, deps) };
    }),
  );

  contractRoute(app, deps, 'submitItemBatchItem', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      // The item lock orders this against photo changes and the batch job.
      const item = await lockItem(trx, tenant, params.itemId);
      const row =
        item && (await findBatchItem(trx, tenant.accountId, params.batchId, params.itemId));
      if (!item || !row) throw notFound('Batch item');
      const photos = await listPhotoRows(trx, tenant, item.id);
      if (photos.length !== body.photoCount) {
        throw new ApiError(
          'invalid_state_transition',
          `This item has ${String(photos.length)} of its ${String(body.photoCount)} photos. ` +
            'Attach the rest, then submit it again.',
        );
      }
      const submitted = await submitBatchItem(trx, deps.batchJobs, {
        accountId: tenant.accountId,
        batchId: row.batch_id,
        itemId: item.id,
        photoCount: body.photoCount,
        now: deps.now(),
      });
      return { status: 202, body: await batchItemView(trx, tenant, submitted, deps) };
    }),
  );

  contractRoute(app, deps, 'replaceItemBatchInteraction', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const batch = await lockBatch(trx, tenant.accountId, params.batchId);
      if (!batch) throw notFound('Batch');
      const seen = new Set<string>();
      const duplicates: FieldError[] = [];
      body.items.forEach((entry, index) => {
        if (seen.has(entry.itemId)) {
          duplicates.push({ field: `items[${String(index)}].itemId`, message: 'is listed twice' });
        }
        seen.add(entry.itemId);
      });
      if (duplicates.length > 0) throw validationFailed(duplicates);

      const { unknownItemIds } = await replaceInteraction(
        trx,
        { accountId: tenant.accountId, batchId: batch.id },
        body.batch,
        body.items.map((entry) => ({ itemId: entry.itemId, ...entry.interaction })),
      );
      if (unknownItemIds.length > 0) {
        const unknown = new Set(unknownItemIds);
        throw validationFailed(
          body.items.flatMap((entry, index) =>
            unknown.has(entry.itemId)
              ? [
                  {
                    field: `items[${String(index)}].itemId`,
                    message: 'is not an item of this batch',
                  },
                ]
              : [],
          ),
        );
      }
      const updated = await findBatch(trx, tenant.accountId, batch.id);
      if (!updated) throw notFound('Batch');
      return { status: 200, body: await batchView(trx, tenant, updated, deps) };
    }),
  );
}
