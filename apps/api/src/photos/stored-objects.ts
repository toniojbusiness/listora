import { DERIVATIVE_KINDS, parsePhotoDerivatives } from '@listora/photos';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyBaseLogger } from 'fastify';

import type { PhotoRow } from './mapping.ts';

/** Every stored object of a photo: its upload (until processed) and its derived images. */
export function photoObjectKeys(row: PhotoRow): string[] {
  const derivatives = parsePhotoDerivatives(row.derivatives);
  return [
    row.storage_key,
    ...(derivatives ? DERIVATIVE_KINDS.map((kind) => derivatives[kind].key) : []),
  ];
}

/**
 * Deletes the stored objects of photos whose rows are already deleted (call it after the
 * transaction commits). A failure is logged, not returned: the photos are gone for the user
 * either way, and leftover objects are unreferenced.
 */
export async function deletePhotoObjects(
  storage: ObjectStorage,
  rows: readonly PhotoRow[],
  log: FastifyBaseLogger,
): Promise<void> {
  const keys = rows.flatMap(photoObjectKeys);
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    log.warn(
      { err: failures[0]?.reason, failed: failures.length, photoIds: rows.map((row) => row.id) },
      'could not delete some stored objects of deleted photos',
    );
  }
}
