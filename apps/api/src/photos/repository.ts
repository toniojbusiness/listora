/**
 * Photo metadata queries, scoped to the request's `Tenant` like every repository. Callers that
 * change an item's photos hold the item's row lock (`lockItem`), so positions stay a gapless
 * 0..n-1 sequence under concurrent requests.
 */
import type { PhotoRole } from '@listora/api-contract';
import { jsonb, type DbExecutor, type DbTransaction, type JsonArray } from '@listora/db';
import { sql } from 'kysely';

import type { Tenant } from '../tenancy.ts';
import type { PhotoRow } from './mapping.ts';

/** An item's photos in display order (the first is the cover). */
export async function listPhotoRows(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
): Promise<PhotoRow[]> {
  return db
    .selectFrom('photo')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .orderBy('position')
    .execute();
}

export interface NewPhoto {
  itemId: string;
  position: number;
  role: PhotoRole;
  storageKey: string;
  width: number;
  height: number;
  sha256: string;
  ocrLines: JsonArray;
  barcodes: JsonArray;
}

/** Inserts a photo at `position`, moving the photos at and after it one place back. */
export async function insertPhoto(
  trx: DbTransaction,
  tenant: Tenant,
  photo: NewPhoto,
): Promise<PhotoRow> {
  // (item_id, position) is unique but deferred, so the shift may pass through duplicates.
  await trx
    .updateTable('photo')
    .set((eb) => ({ position: eb('position', '+', 1) }))
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', photo.itemId)
    .where('position', '>=', photo.position)
    .execute();
  return trx
    .insertInto('photo')
    .values({
      account_id: tenant.accountId,
      item_id: photo.itemId,
      position: photo.position,
      role: photo.role,
      storage_key: photo.storageKey,
      width: photo.width,
      height: photo.height,
      sha256: photo.sha256,
      ocr_lines: jsonb(photo.ocrLines),
      barcodes: jsonb(photo.barcodes),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updatePhotoRole(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  photoId: string,
  role: PhotoRole,
): Promise<PhotoRow | undefined> {
  return db
    .updateTable('photo')
    .set({ role })
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('id', '=', photoId)
    .returningAll()
    .executeTakeFirst();
}

/** Deletes a photo and closes the gap it leaves; undefined when there is no such photo. */
export async function deletePhoto(
  trx: DbTransaction,
  tenant: Tenant,
  itemId: string,
  photoId: string,
): Promise<PhotoRow | undefined> {
  const deleted = await trx
    .deleteFrom('photo')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('id', '=', photoId)
    .returningAll()
    .executeTakeFirst();
  if (!deleted) return undefined;
  await trx
    .updateTable('photo')
    .set((eb) => ({ position: eb('position', '-', 1) }))
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('position', '>', deleted.position)
    .execute();
  return deleted;
}

/** Sets each photo's position to its index in `photoIds`, which lists all of the item's photos. */
export async function reorderPhotos(
  trx: DbTransaction,
  tenant: Tenant,
  itemId: string,
  photoIds: readonly string[],
): Promise<void> {
  await sql`
    update photo set position = ordered.position - 1
    from unnest(${[...photoIds]}::uuid[]) with ordinality as ordered (id, position)
    where photo.account_id = ${tenant.accountId}
      and photo.item_id = ${itemId}
      and photo.id = ordered.id
  `.execute(trx);
}
