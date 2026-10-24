import type { DbExecutor, PhotoStatus } from '@listora/db';
import { photoSetHash } from '@listora/shared';

export interface ItemPhotoSet {
  /** `photoSetHash` over the photos' sha256s in display order (`ai_analysis.photo_set_hash`). */
  hash: string;
  /** The photos in display order; the first is the cover. */
  photos: { id: string; sha256: string; status: PhotoStatus }[];
}

/**
 * An item's current photo set and its hash, the key analysis is idempotent by: the same photos
 * in the same order give the same hash, so the item is not analyzed (and paid for) twice.
 * The hash covers the uploaded files' sha256s, which never change, not the derived images.
 * Undefined when the item has no photos.
 */
export async function itemPhotoSet(
  db: DbExecutor,
  accountId: string,
  itemId: string,
): Promise<ItemPhotoSet | undefined> {
  const rows = await db
    .selectFrom('photo')
    .select(['id', 'sha256', 'status'])
    .where('account_id', '=', accountId)
    .where('item_id', '=', itemId)
    .orderBy('position')
    .execute();
  if (rows.length === 0) return undefined;
  const photos = rows.map((row) => {
    // The API stores the hash when it attaches a file.
    if (row.sha256 === null) throw new Error(`photo ${row.id} has no sha256`);
    return { id: row.id, sha256: row.sha256, status: row.status };
  });
  return { hash: photoSetHash(photos.map((photo) => photo.sha256)), photos };
}
