/**
 * The photo processing job: one run turns an attached upload into a `ready` photo (or a
 * `failed` one with a reason the user can read). The API adds the job in the same transaction
 * that creates the photo, so a photo is never left without one, and returns at once.
 *
 * Every step is safe to repeat. A crash or a storage error throws, and the queue runs the job
 * again: objects written by the failed attempt are deleted (or, at worst, left unreferenced),
 * never while the photo row may point at them; the row changes only in one conditional update,
 * and the upload is deleted only after that update commits.
 */
import { jsonb, type Db, type DbExecutor, type JsonObject } from '@listora/db';
import type { Logger } from '@listora/shared';
import { sha256Hex } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

import {
  DERIVATIVE_KINDS,
  DERIVATIVES,
  parsePhotoDerivatives,
  PUBLIC_CACHE_CONTROL,
  storageKeys,
  type PhotoDerivatives,
} from './derivatives.ts';
import { processImage, UnusableImageError } from './image.ts';

/** The job queue task name the worker registers `processPhoto` under. */
export const PHOTO_PROCESSING_TASK = 'photo_processing';

export interface PhotoJobPayload {
  accountId: string;
  photoId: string;
}

export function isPhotoJobPayload(value: unknown): value is PhotoJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, photoId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof photoId === 'string';
}

/** One job per photo, so adding the job twice never processes a photo twice at once. */
export function photoJobKey(photoId: string): string {
  return `photo:${photoId}`;
}

/**
 * Adds a photo's processing job on the caller's connection, so the job commits or rolls back
 * with the photo. The Graphile Worker queue (plan task T-06) implements it.
 */
export interface PhotoJobQueue {
  enqueue(executor: DbExecutor, job: PhotoJobPayload): Promise<void>;
}

export interface PhotoProcessingDependencies {
  db: Db;
  storage: ObjectStorage;
  logger: Logger;
}

/**
 * - `ready`: the derivatives are stored and the photo is ready.
 * - `failed`: the upload is not a usable image (or is gone); the photo shows the reason.
 * - `skipped`: nothing to do (already processed, or the photo was deleted).
 */
export type PhotoProcessingOutcome = 'ready' | 'failed' | 'skipped';

export async function processPhoto(
  deps: PhotoProcessingDependencies,
  job: PhotoJobPayload,
): Promise<PhotoProcessingOutcome> {
  const log = deps.logger.child({ photoId: job.photoId, accountId: job.accountId });
  const photo = await deps.db
    .selectFrom('photo')
    .select(['id', 'status', 'storage_key', 'sha256'])
    .where('account_id', '=', job.accountId)
    .where('id', '=', job.photoId)
    .executeTakeFirst();
  if (!photo) {
    log.info('photo was deleted before processing; nothing to do');
    return 'skipped';
  }
  if (photo.status !== 'processing') {
    // An earlier run committed but may have stopped before deleting the upload.
    await deps.storage.delete(photo.storage_key);
    return 'skipped';
  }

  const upload = await deps.storage.get(photo.storage_key);
  if (upload === undefined) {
    return fail(
      deps,
      job,
      photo.storage_key,
      'The uploaded file is missing. Upload the photo again.',
      log,
    );
  }
  if (photo.sha256 === null || sha256Hex(upload) !== photo.sha256) {
    return fail(
      deps,
      job,
      photo.storage_key,
      'The uploaded file does not match the photo that was sent. Upload it again.',
      log,
    );
  }

  let image;
  try {
    image = await processImage(upload);
  } catch (error) {
    if (error instanceof UnusableImageError) {
      log.info({ code: error.code }, 'upload is not a usable image');
      return fail(deps, job, photo.storage_key, error.message, log);
    }
    throw error;
  }

  const token = storageKeys.newPublicToken();
  const derivatives = Object.fromEntries(
    DERIVATIVE_KINDS.map((kind) => {
      const derived = image.derivatives[kind];
      return [
        kind,
        {
          key: storageKeys.derivative(job.accountId, job.photoId, token, kind),
          width: derived.width,
          height: derived.height,
          byteSize: derived.bytes.byteLength,
          sha256: derived.sha256,
        },
      ];
    }),
  ) as PhotoDerivatives;
  const keys = DERIVATIVE_KINDS.map((kind) => derivatives[kind].key);

  // Settled, not Promise.all: cleanup must not run while another write is still landing.
  const writes = await Promise.allSettled(
    DERIVATIVE_KINDS.map((kind) =>
      deps.storage.put(derivatives[kind].key, image.derivatives[kind].bytes, {
        contentType: 'image/jpeg',
        ...(DERIVATIVES[kind].public ? { cacheControl: PUBLIC_CACHE_CONTROL } : {}),
      }),
    ),
  );
  const failedWrite = writes.find((write) => write.status === 'rejected');
  if (failedWrite) {
    await discardImages(deps.storage, keys, log);
    throw failedWrite.reason;
  }

  let updated;
  try {
    updated = await deps.db
      .updateTable('photo')
      .set({
        status: 'ready',
        width: image.width,
        height: image.height,
        phash: image.phash,
        derivatives: jsonb(derivatives as unknown as JsonObject),
        processed_at: new Date(),
      })
      .where('account_id', '=', job.accountId)
      .where('id', '=', job.photoId)
      .where('status', '=', 'processing')
      .where('storage_key', '=', photo.storage_key)
      .executeTakeFirst();
  } catch (error) {
    // The update can commit even though its reply never arrives (a dropped connection), and a
    // ready photo must not point at deleted images, so look before cleaning up.
    if (!(await committedWith(deps, job, derivatives, log))) {
      await discardImages(deps.storage, keys, log);
    }
    throw error;
  }
  if (updated.numUpdatedRows === 0n) {
    log.info('photo was deleted or processed while this run worked; discarding its images');
    await deleteAll(deps.storage, keys);
    return 'skipped';
  }

  await deps.storage.delete(photo.storage_key);
  log.info({ width: image.width, height: image.height }, 'photo processed');
  return 'ready';
}

async function fail(
  deps: PhotoProcessingDependencies,
  job: PhotoJobPayload,
  uploadKey: string,
  reason: string,
  log: Logger,
): Promise<PhotoProcessingOutcome> {
  const updated = await deps.db
    .updateTable('photo')
    .set({ status: 'failed', failure_reason: reason, processed_at: new Date() })
    .where('account_id', '=', job.accountId)
    .where('id', '=', job.photoId)
    .where('status', '=', 'processing')
    .executeTakeFirst();
  // The upload may still carry GPS and other metadata, so it is not kept either way.
  await deps.storage.delete(uploadKey);
  if (updated.numUpdatedRows === 0n) return 'skipped';
  log.info({ reason }, 'photo processing failed');
  return 'failed';
}

/**
 * Whether the photo is `ready` with these derivatives, so a failed-looking update did commit.
 * True when that cannot be checked either: unreferenced objects are the safe mistake.
 */
async function committedWith(
  deps: PhotoProcessingDependencies,
  job: PhotoJobPayload,
  derivatives: PhotoDerivatives,
  log: Logger,
): Promise<boolean> {
  try {
    const row = await deps.db
      .selectFrom('photo')
      .select(['status', 'derivatives'])
      .where('account_id', '=', job.accountId)
      .where('id', '=', job.photoId)
      .executeTakeFirst();
    if (row?.status !== 'ready') return false;
    const stored = parsePhotoDerivatives(row.derivatives);
    return DERIVATIVE_KINDS.some((kind) => stored?.[kind].key === derivatives[kind].key);
  } catch (error) {
    log.warn(
      { err: error },
      'could not check whether the photo update committed; keeping its images',
    );
    return true;
  }
}

async function discardImages(
  storage: ObjectStorage,
  keys: readonly string[],
  log: Logger,
): Promise<void> {
  await deleteAll(storage, keys).catch((cleanupError: unknown) => {
    log.warn({ err: cleanupError }, 'could not delete the images of a failed processing run');
  });
}

async function deleteAll(storage: ObjectStorage, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => storage.delete(key)));
}
