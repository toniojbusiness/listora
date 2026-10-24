import type { FieldError } from '@listora/api-contract';
import { inTransaction, type DbTransaction } from '@listora/db';
import type { PhotoJobQueue } from '@listora/photos';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { lockItem } from '../items/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { photoFromRow } from './mapping.ts';
import {
  deletePhoto,
  insertPhoto,
  listPhotoRows,
  reorderPhotos,
  updatePhotoRole,
} from './repository.ts';
import { deletePhotoObjects } from './stored-objects.ts';
import type { PhotoUploads } from './uploads.ts';

/** The most photos an item can have (the contract's `PhotoOrder.photoIds` limit). */
export const MAX_PHOTOS_PER_ITEM = 24;

export interface PhotoRouteDependencies extends RouteDependencies {
  uploads: PhotoUploads;
  storage: ObjectStorage;
  photoJobs: PhotoJobQueue;
}

/**
 * Photos: `addItemPhoto`, `reorderItemPhotos`, `updateItemPhoto`, `deleteItemPhoto`.
 * `addItemPhoto` takes its file from an upload session (`PhotoUploads`) and adds the photo's
 * processing job in the same transaction; the worker derives its images (@listora/photos).
 * Removing a photo deletes its stored objects once the removal has committed.
 */
export function registerPhotoRoutes(app: FastifyInstance, deps: PhotoRouteDependencies): void {
  contractRoute(app, deps, 'addItemPhoto', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const photos = await lockedItemPhotos(trx, tenant, params.itemId);
      if (photos.length >= MAX_PHOTOS_PER_ITEM) {
        throw validationFailed(
          [],
          `An item can have at most ${String(MAX_PHOTOS_PER_ITEM)} photos. Remove one first.`,
        );
      }

      const claim = await deps.uploads.claim(trx, tenant, body.uploadFileId);
      switch (claim.status) {
        case 'not_found':
          throw notFound('Upload file');
        case 'incomplete':
          throw new ApiError(
            'upload_incomplete',
            'This file has not finished uploading. Upload it again.',
          );
        case 'expired':
          throw new ApiError('upload_expired', 'This upload has expired. Start a new upload.');
        case 'attached':
          throw new ApiError(
            'already_exists',
            'This uploaded file is already attached as a photo.',
          );
        case 'ready':
          break;
      }
      const { file } = claim;
      // The worker replaces these with the image's real upright size once it has read it.
      const { width, height } = body;
      const missing: FieldError[] = [];
      if (width === undefined)
        missing.push({ field: 'width', message: 'is required for this file' });
      if (height === undefined)
        missing.push({ field: 'height', message: 'is required for this file' });
      if (width === undefined || height === undefined) throw validationFailed(missing);

      const position = Math.min(body.position ?? photos.length, photos.length);
      let row;
      try {
        row = await insertPhoto(trx, tenant, {
          itemId: params.itemId,
          position,
          role: body.role,
          storageKey: file.storageKey,
          width,
          height,
          sha256: file.sha256,
          ocrLines: body.ocrLines ?? [],
          barcodes: body.barcodes ?? [],
        });
      } catch (error) {
        if (isPgError(error, PG_ERROR.uniqueViolation, 'photo_storage_key_key')) {
          throw new ApiError(
            'already_exists',
            'This uploaded file is already attached as a photo.',
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      await deps.photoJobs.enqueue(trx, { accountId: tenant.accountId, photoId: row.id });
      await writeAudit(trx, tenant, {
        itemId: params.itemId,
        action: 'photo.added',
        changes: { photoId: row.id, role: row.role, position: row.position },
      });
      return { status: 201, body: photoFromRow(row, deps.storage) };
    }),
  );

  contractRoute(app, deps, 'reorderItemPhotos', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const photos = await lockedItemPhotos(trx, tenant, params.itemId);
      const current = new Set(photos.map((photo) => photo.id));
      const requested = new Set(body.photoIds);
      if (
        requested.size !== body.photoIds.length ||
        requested.size !== current.size ||
        body.photoIds.some((id) => !current.has(id))
      ) {
        throw validationFailed([
          { field: 'photoIds', message: "must list every one of the item's photos exactly once" },
        ]);
      }
      const unchanged = photos.every((photo, index) => body.photoIds[index] === photo.id);
      if (!unchanged) {
        await reorderPhotos(trx, tenant, params.itemId, body.photoIds);
        await writeAudit(trx, tenant, {
          itemId: params.itemId,
          action: 'photo.reordered',
          changes: { photoIds: [...body.photoIds] },
        });
      }
      const reordered = await listPhotoRows(trx, tenant, params.itemId);
      return {
        status: 200,
        body: { data: reordered.map((row) => photoFromRow(row, deps.storage)) },
      };
    }),
  );

  contractRoute(app, deps, 'updateItemPhoto', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const photos = await lockedItemPhotos(trx, tenant, params.itemId);
      const before = photos.find((photo) => photo.id === params.photoId);
      if (!before) throw notFound('Photo');
      if (before.role === body.role) {
        return { status: 200, body: photoFromRow(before, deps.storage) };
      }
      const updated = await updatePhotoRole(trx, tenant, params.itemId, params.photoId, body.role);
      if (!updated) throw notFound('Photo');
      await writeAudit(trx, tenant, {
        itemId: params.itemId,
        action: 'photo.role_changed',
        changes: { photoId: updated.id, role: { from: before.role, to: updated.role } },
      });
      return { status: 200, body: photoFromRow(updated, deps.storage) };
    }),
  );

  contractRoute(app, deps, 'deleteItemPhoto', async ({ tenant, db, params, request }) => {
    const deleted = await inTransaction(db, async (trx) => {
      await lockedItemPhotos(trx, tenant, params.itemId);
      const row = await deletePhoto(trx, tenant, params.itemId, params.photoId);
      if (!row) throw notFound('Photo');
      await writeAudit(trx, tenant, {
        itemId: params.itemId,
        action: 'photo.removed',
        changes: { photoId: row.id, role: row.role, position: row.position },
      });
      return row;
    });
    await deletePhotoObjects(deps.storage, [deleted], request.log);
    return { status: 204 };
  });
}

/** Locks the item (404 when it is not in this account) and returns its photos in order. */
async function lockedItemPhotos(trx: DbTransaction, tenant: Tenant, itemId: string) {
  if (!(await lockItem(trx, tenant, itemId))) throw notFound('Item');
  return listPhotoRows(trx, tenant, itemId);
}
