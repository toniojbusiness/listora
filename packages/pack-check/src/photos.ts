/**
 * Package photos (docs/features/pack-check.md#package-photos). A package photo shows the
 * shipping label, so the buyer's name and address: it is a private object (`pack/<random>/`),
 * stored `private, no-store`, which the app reads only through a short-lived signed URL that a
 * signed-in request of its own account gets (`packPhotoUrls`). It is deleted some days after
 * the sale shipped (`expirePackPhotos`), and with the package's record or the account.
 *
 * Package photos taken before were public under unguessable keys (`public/<random>/`), served
 * through the CDN with a year's cache. `movePublicPackPhotos` moves each one to its private key,
 * deletes the public object, and asks the CDN to drop its copies; the hourly job
 * (`PACK_PHOTOS_TASK`) runs it, and the worker queues it at every start, so a deploy moves them
 * at once and a photo an older API process saved meanwhile is moved within the hour.
 */
import { randomBytes } from 'node:crypto';

import { addJob, inTransaction, type Db, type DbExecutor } from '@listora/db';
import type { Logger } from '@listora/shared';
import {
  isPublicKey,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_KEY_PREFIX,
  type ObjectStorage,
} from '@listora/storage';
import { sql } from 'kysely';

/** Every package photo's key starts with this: a private prefix, never served by the CDN. */
export const PACK_PHOTO_PREFIX = 'pack/';

/** How long a package photo's signed URL lasts. */
export const PACK_PHOTO_URL_SECONDS = 60 * 60;

/**
 * Days a package photo is kept after its sale shipped (or, for a sale never marked shipped,
 * after it was packed): past the marketplaces' claim windows after delivery.
 */
export const PACK_PHOTO_RETENTION_DAYS = 60;

/** The job that moves public package photos and deletes expired ones. */
export const PACK_PHOTOS_TASK = 'pack_photos';
/** Minute 41 of every hour, off the hour. */
export const PACK_PHOTOS_CRONTAB = `41 * * * * ${PACK_PHOTOS_TASK} ?max=1`;
const PACK_PHOTOS_JOB_KEY = 'pack-photos';

const DAY_MS = 86_400_000;

/** A new package photo's key: private, under an unguessable name. */
export function packPhotoKey(): string {
  return `${PACK_PHOTO_PREFIX}${randomBytes(16).toString('hex')}/package.jpg`;
}

/** The private key a public package photo moves to: the same random name. */
export function privatePackPhotoKey(publicKey: string): string {
  return `${PACK_PHOTO_PREFIX}${publicKey.slice(PUBLIC_KEY_PREFIX.length)}`;
}

/**
 * Signed read URLs of package photos, by key: what the app shows them from. A photo not moved
 * yet (still public) is read the same way, never through the CDN.
 */
export async function packPhotoUrls(
  storage: ObjectStorage,
  keys: Iterable<string>,
  now: Date,
): Promise<Map<string, string>> {
  const expiresAt = new Date(now.getTime() + PACK_PHOTO_URL_SECONDS * 1000);
  const unique = [...new Set(keys)];
  const urls = await Promise.all(unique.map((key) => storage.signedReadUrl(key, expiresAt)));
  return new Map(unique.map((key, index) => [key, urls[index] ?? '']));
}

/** Queues the job now (the worker does at every start); a job already waiting is kept. */
export async function queuePackPhotos(executor: DbExecutor): Promise<void> {
  await addJob(executor, { task: PACK_PHOTOS_TASK, payload: {}, jobKey: PACK_PHOTOS_JOB_KEY });
}

export interface PackPhotosDependencies {
  db: Db;
  storage: ObjectStorage;
  logger: Logger;
}

export interface PackPhotosOptions {
  /** Photos per batch (default 100). */
  batchSize?: number;
  /** Batches per run (default 50); the rest wait for the next run. */
  maxBatches?: number;
  now?: () => Date;
}

/** One run of the job: moves the public photos, then deletes the expired ones. */
export async function runPackPhotos(
  deps: PackPhotosDependencies,
  options: PackPhotosOptions = {},
): Promise<{ moved: number; expired: number }> {
  const moved = await repeat(options, () => movePublicPackPhotos(deps, options));
  const expired = await repeat(options, () => expirePackPhotos(deps, options));
  if (moved > 0 || expired > 0) {
    deps.logger.info({ task: PACK_PHOTOS_TASK, moved, expired }, 'package photos tidied');
  }
  return { moved, expired };
}

async function repeat(options: PackPhotosOptions, batch: () => Promise<number>): Promise<number> {
  const batchSize = options.batchSize ?? 100;
  let total = 0;
  for (let round = 0; round < (options.maxBatches ?? 50); round += 1) {
    const done = await batch();
    total += done;
    if (done < batchSize) break;
  }
  return total;
}

/**
 * Moves one batch of public package photos to their private keys; the number moved. Each step
 * is safe to repeat, so a failure part way leaves the rest to the next run: the private copy
 * first (`private, no-store`), then the public object is deleted, then the CDN is asked to drop
 * its copies (after the delete, so it cannot fetch the photo again), and only then the record
 * names the private key. A photo whose object is gone from both places is no longer shown.
 */
export async function movePublicPackPhotos(
  deps: PackPhotosDependencies,
  options: Pick<PackPhotosOptions, 'batchSize'> = {},
): Promise<number> {
  const rows = await deps.db
    .selectFrom('sale_pack')
    .select(['account_id', 'sale_id', 'photo_key'])
    .where('photo_key', 'like', `${PUBLIC_KEY_PREFIX}%`)
    .orderBy('photo_added_at')
    .orderBy('sale_id')
    .limit(options.batchSize ?? 100)
    .execute();
  const moves: { accountId: string; saleId: string; from: string; to: string | null }[] = [];
  for (const row of rows) {
    const from = row.photo_key;
    if (from === null || !isPublicKey(from)) continue;
    const to = privatePackPhotoKey(from);
    let present = (await deps.storage.head(to)) !== undefined;
    if (!present) {
      const bytes = await deps.storage.get(from);
      if (bytes !== undefined) {
        await deps.storage.put(to, bytes, {
          contentType: 'image/jpeg',
          cacheControl: PRIVATE_CACHE_CONTROL,
        });
        present = true;
      }
    }
    moves.push({ accountId: row.account_id, saleId: row.sale_id, from, to: present ? to : null });
  }
  if (moves.length === 0) return 0;
  for (const move of moves) await deps.storage.delete(move.from);
  await deps.storage.invalidatePublic(moves.map((move) => move.from));
  await inTransaction(deps.db, async (trx) => {
    for (const move of moves) {
      await trx
        .updateTable('sale_pack')
        .set(move.to === null ? { photo_key: null, photo_added_at: null } : { photo_key: move.to })
        .where('account_id', '=', move.accountId)
        .where('sale_id', '=', move.saleId)
        // Removed or replaced meanwhile: leave it.
        .where('photo_key', '=', move.from)
        .execute();
    }
  });
  const lost = moves.filter((move) => move.to === null).length;
  if (lost > 0) {
    deps.logger.warn(
      { task: PACK_PHOTOS_TASK, lost },
      'public package photos already gone; their records no longer show one',
    );
  }
  return moves.length;
}

/**
 * Deletes one batch of package photos kept past `PACK_PHOTO_RETENTION_DAYS` after their sale
 * shipped (or was packed, when it was never marked shipped); the number deleted. The object
 * goes first, so a failure leaves the record to the next run, never an object no record names.
 */
export async function expirePackPhotos(
  deps: PackPhotosDependencies,
  options: Pick<PackPhotosOptions, 'batchSize' | 'now'> = {},
): Promise<number> {
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - PACK_PHOTO_RETENTION_DAYS * DAY_MS);
  const rows = await deps.db
    .selectFrom('sale_pack as pack')
    .innerJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'pack.account_id').onRef('sale.id', '=', 'pack.sale_id'),
    )
    .select(['pack.account_id', 'pack.sale_id', 'pack.photo_key'])
    .where('pack.photo_key', 'is not', null)
    // A public photo is moved first; it expires as a private one.
    .where('pack.photo_key', 'not like', `${PUBLIC_KEY_PREFIX}%`)
    .where(sql<boolean>`coalesce(sale.shipped_at, pack.packed_at) < ${cutoff}`)
    .orderBy('pack.packed_at')
    .orderBy('pack.sale_id')
    .limit(options.batchSize ?? 100)
    .execute();
  let expired = 0;
  for (const row of rows) {
    if (row.photo_key === null) continue;
    await deps.storage.delete(row.photo_key);
    const updated = await deps.db
      .updateTable('sale_pack')
      .set({ photo_key: null, photo_added_at: null })
      .where('account_id', '=', row.account_id)
      .where('sale_id', '=', row.sale_id)
      .where('photo_key', '=', row.photo_key)
      .executeTakeFirst();
    if (updated.numUpdatedRows > 0n) expired += 1;
  }
  return expired;
}
