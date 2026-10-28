/**
 * Thumbnail refresh: when the thumbnail size grows (400 px to 640 px on 2026-10-28, so a grid
 * cell no longer needs the listing image), photos processed before keep their smaller
 * thumbnail until this job makes the new one from their stored `original`. The worker queues it
 * at every start; one run refreshes a batch of photos in id order and queues the next batch, so
 * a pass over every photo ends on its own and an up-to-date platform costs one query a start.
 *
 * A refreshed thumbnail gets a new public key (public URLs are immutable, and the old one may be
 * cached for a year), the photo row switches to it in one conditional update, and only then is
 * the old object deleted. Every step is safe to repeat.
 */
import {
  addJob,
  jsonb,
  type Db,
  type DbExecutor,
  type JsonObject,
  type JsonValue,
} from '@listora/db';
import type { Logger } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';
import { sql } from 'kysely';

import {
  DERIVATIVES,
  parsePhotoDerivatives,
  PUBLIC_CACHE_CONTROL,
  storageKeys,
  type StoredDerivative,
} from './derivatives.ts';
import { deriveFromOriginal } from './image.ts';

/** The job queue task name the worker registers `refreshThumbnails` under. */
export const THUMBNAIL_REFRESH_TASK = 'photo_thumbnail_refresh';

/** Photos per run: about 2 s of work on the personal environment's 0.25 vCPU. */
export const THUMBNAIL_REFRESH_BATCH = 25;

/** One pass at a time: queueing the job again replaces the pending one. */
const THUMBNAIL_REFRESH_JOB_KEY = 'photo-thumbnail-refresh';

export interface ThumbnailRefreshPayload {
  /** The last photo id the pass has looked at; empty to start from the first photo. */
  after: string;
}

export function isThumbnailRefreshPayload(value: unknown): value is ThumbnailRefreshPayload {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['after'] === 'string';
}

/** Queues a pass (from the first photo, or the next batch of one). */
export async function queueThumbnailRefresh(executor: DbExecutor, after = ''): Promise<void> {
  await addJob(executor, {
    task: THUMBNAIL_REFRESH_TASK,
    payload: { after },
    jobKey: THUMBNAIL_REFRESH_JOB_KEY,
  });
}

export interface ThumbnailRefreshDependencies {
  db: Db;
  storage: ObjectStorage;
  logger: Logger;
}

export interface ThumbnailRefreshResult {
  /** Photos whose thumbnail was made again. */
  refreshed: number;
  /** The next batch starts after this photo id; undefined when the pass is done. */
  next: string | undefined;
}

/**
 * Refreshes the next batch of photos whose thumbnail is smaller than `DERIVATIVES.thumbnail`
 * makes now (a photo smaller than that keeps its full size), then queues the batch after it.
 */
export async function refreshThumbnails(
  deps: ThumbnailRefreshDependencies,
  payload: ThumbnailRefreshPayload,
  batch: number = THUMBNAIL_REFRESH_BATCH,
): Promise<ThumbnailRefreshResult> {
  const maxEdge = DERIVATIVES.thumbnail.maxEdge;
  const photos = await deps.db
    .selectFrom('photo')
    .select(['id', 'account_id', 'derivatives'])
    .where('status', '=', 'ready')
    .$if(payload.after !== '', (query) => query.where('id', '>', payload.after))
    .where(
      sql<boolean>`greatest((derivatives->'thumbnail'->>'width')::int, (derivatives->'thumbnail'->>'height')::int)
        < least(${maxEdge}, greatest(width, height))`,
    )
    .orderBy('id')
    .limit(batch)
    .execute();

  let refreshed = 0;
  for (const photo of photos) {
    if (await refreshThumbnail(deps, photo.account_id, photo.id, photo.derivatives)) {
      refreshed += 1;
    }
  }
  const next = photos.length === batch ? photos.at(-1)?.id : undefined;
  if (next !== undefined) await queueThumbnailRefresh(deps.db, next);
  if (photos.length > 0) {
    deps.logger.info(
      { refreshed, looked: photos.length, done: next === undefined },
      'thumbnails refreshed',
    );
  }
  return { refreshed, next };
}

/** Makes one photo's thumbnail again; false when it was left as it is. */
async function refreshThumbnail(
  deps: ThumbnailRefreshDependencies,
  accountId: string,
  photoId: string,
  stored: JsonObject,
): Promise<boolean> {
  const log = deps.logger.child({ photoId, accountId });
  const derivatives = parsePhotoDerivatives(stored);
  if (!derivatives) return false;
  const original = await deps.storage.get(derivatives.original.key);
  if (original === undefined) {
    log.warn('photo original is missing; keeping its thumbnail');
    return false;
  }
  let image;
  try {
    image = await deriveFromOriginal(original, 'thumbnail');
  } catch (error) {
    // The old thumbnail still shows; a retry would fail the same way.
    log.warn({ err: error }, 'could not make the thumbnail again; keeping the old one');
    return false;
  }

  const previous = derivatives.thumbnail;
  const thumbnail: StoredDerivative = {
    key: storageKeys.derivative(accountId, photoId, storageKeys.newPublicToken(), 'thumbnail'),
    width: image.width,
    height: image.height,
    byteSize: image.bytes.byteLength,
    sha256: image.sha256,
  };
  await deps.storage.put(thumbnail.key, image.bytes, {
    contentType: 'image/jpeg',
    cacheControl: PUBLIC_CACHE_CONTROL,
  });

  let updated;
  try {
    updated = await deps.db
      .updateTable('photo')
      .set({
        derivatives: sql<JsonObject>`jsonb_set(derivatives, '{thumbnail}', ${jsonb(thumbnail as unknown as JsonValue)})`,
      })
      .where('account_id', '=', accountId)
      .where('id', '=', photoId)
      .where('status', '=', 'ready')
      .where(sql<boolean>`derivatives->'thumbnail'->>'key' = ${previous.key}`)
      .executeTakeFirst();
  } catch (error) {
    // The update may have committed with its reply lost: delete the new image only if the row
    // does not point at it (when that cannot be read either, an unreferenced object is the safe
    // mistake).
    const row = await deps.db
      .selectFrom('photo')
      .select(sql<string>`derivatives->'thumbnail'->>'key'`.as('key'))
      .where('id', '=', photoId)
      .executeTakeFirst()
      .catch(() => ({ key: thumbnail.key }));
    if (row?.key !== thumbnail.key) await deps.storage.delete(thumbnail.key).catch(() => undefined);
    throw error;
  }
  if (updated.numUpdatedRows === 0n) {
    // Deleted, reprocessed, or refreshed by another run meanwhile.
    await deps.storage.delete(thumbnail.key);
    return false;
  }
  try {
    await deps.storage.delete(previous.key);
  } catch (error) {
    log.warn({ err: error, key: previous.key }, 'could not delete the old thumbnail');
  }
  return true;
}
