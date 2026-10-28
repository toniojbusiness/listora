/**
 * The package photo job on real Postgres and the local storage driver: the public photos taken
 * before move to private keys (the public object deleted, the CDN asked to drop it, the record
 * moved), every step safe to repeat; and photos expire their days after shipping.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';
import { LocalDiskStorage, type ObjectStorage } from '@listora/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  expirePackPhotos,
  movePublicPackPhotos,
  PACK_PHOTO_RETENTION_DAYS,
  packPhotoKey,
  runPackPhotos,
} from './photos.ts';

const DAY_MS = 86_400_000;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const logger = createLogger({ service: 'test', level: 'silent' });

describe('package photos (real Postgres)', () => {
  let database: MigratedDatabase;
  let rootDir: string;
  let local: LocalDiskStorage;
  let accountId: string;
  /** The public keys the CDN was asked to drop. */
  let invalidated: string[];
  let storage: ObjectStorage;

  beforeAll(async () => {
    database = await createMigratedDatabase('pack_photos');
    rootDir = await mkdtemp(join(tmpdir(), 'listora-pack-photos-'));
    local = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'pack-photos-test-secret-0123456789abcdef',
    });
    accountId = await insertAccount(database.db, 'PP');
  });

  afterAll(async () => {
    await database.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    invalidated = [];
    storage = withInvalidations(local, (keys) => {
      invalidated.push(...keys);
      return Promise.resolve();
    });
    await database.db.deleteFrom('sale_pack').execute();
  });

  const deps = () => ({ db: database.db, storage, logger });

  /** A packed sale with its package photo under `key`, shipped `shippedDaysAgo` days ago. */
  async function packed(key: string | null, shippedDaysAgo: number | null = null) {
    const now = Date.now();
    const sale = await database.db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace: 'depop',
        external_order_id: randomUUID(),
        sold_at: new Date(now - 90 * DAY_MS),
        detection_source: 'manual',
        ...(shippedDaysAgo === null
          ? {}
          : { status: 'shipped', shipped_at: new Date(now - shippedDaysAgo * DAY_MS) }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('sale_pack')
      .values({
        account_id: accountId,
        sale_id: sale.id,
        tracking_number: `9400${String(Math.floor(Math.random() * 1e15)).padStart(18, '0')}`,
        matched_by: 'label',
        packed_at: new Date(now - (shippedDaysAgo ?? 1) * DAY_MS),
        photo_key: key,
        photo_added_at: key === null ? null : new Date(now - (shippedDaysAgo ?? 1) * DAY_MS),
      })
      .execute();
    if (key !== null) await local.put(key, JPEG, { contentType: 'image/jpeg' });
    return sale.id;
  }

  const photoKey = async (saleId: string) =>
    (
      await database.db
        .selectFrom('sale_pack')
        .select('photo_key')
        .where('sale_id', '=', saleId)
        .executeTakeFirstOrThrow()
    ).photo_key;

  it('moves a public photo to its private key, deletes it, and has the CDN drop it', async () => {
    const legacy = `public/${'a'.repeat(32)}/package.jpg`;
    const saleId = await packed(legacy);
    const fresh = await packed(packPhotoKey());

    expect(await movePublicPackPhotos(deps())).toBe(1);
    const moved = `pack/${'a'.repeat(32)}/package.jpg`;
    expect(await photoKey(saleId)).toBe(moved);
    expect(await local.get(moved)).toEqual(JPEG);
    expect(await local.get(legacy)).toBeUndefined();
    expect(invalidated).toEqual([legacy]);
    // A private photo stays where it is, and a second run has nothing to move.
    expect(await photoKey(fresh)).toMatch(/^pack\//);
    expect(await movePublicPackPhotos(deps())).toBe(0);
  });

  it('keeps a photo public until the CDN accepted, and finishes on the next run', async () => {
    const legacy = `public/${'b'.repeat(32)}/package.jpg`;
    const saleId = await packed(legacy);
    storage = withInvalidations(local, () => Promise.reject(new Error('Throttling')));
    await expect(movePublicPackPhotos(deps())).rejects.toThrow('Throttling');
    // The record still names the public key, so the next run asks again.
    expect(await photoKey(saleId)).toBe(legacy);

    storage = withInvalidations(local, (keys) => {
      invalidated.push(...keys);
      return Promise.resolve();
    });
    expect(await movePublicPackPhotos(deps())).toBe(1);
    expect(await photoKey(saleId)).toBe(`pack/${'b'.repeat(32)}/package.jpg`);
    expect(await local.get(`pack/${'b'.repeat(32)}/package.jpg`)).toEqual(JPEG);
    expect(invalidated).toEqual([legacy]);
  });

  it('stops showing a public photo whose object is already gone', async () => {
    const legacy = `public/${'c'.repeat(32)}/package.jpg`;
    const saleId = await packed(legacy);
    await local.delete(legacy);
    expect(await movePublicPackPhotos(deps())).toBe(1);
    expect(await photoKey(saleId)).toBeNull();
    expect(invalidated).toEqual([legacy]);
  });

  it('deletes a photo its days after the sale shipped, and keeps a newer one', async () => {
    const old = packPhotoKey();
    const recent = packPhotoKey();
    const oldSale = await packed(old, PACK_PHOTO_RETENTION_DAYS + 1);
    const recentSale = await packed(recent, PACK_PHOTO_RETENTION_DAYS - 1);
    // Never marked shipped: counted from when it was packed.
    const unshipped = packPhotoKey();
    const unshippedSale = await packed(unshipped);

    expect(await expirePackPhotos(deps())).toBe(1);
    expect(await photoKey(oldSale)).toBeNull();
    expect(await local.get(old)).toBeUndefined();
    expect(await photoKey(recentSale)).toBe(recent);
    expect(await local.get(recent)).toEqual(JPEG);
    expect(await photoKey(unshippedSale)).toBe(unshipped);

    const later = () => new Date(Date.now() + PACK_PHOTO_RETENTION_DAYS * DAY_MS);
    expect(await expirePackPhotos(deps(), { now: later })).toBe(2);
    expect(await photoKey(unshippedSale)).toBeNull();
  });

  it('runs both in one job: a public photo past its days is moved, then deleted', async () => {
    const legacy = `public/${'d'.repeat(32)}/package.jpg`;
    const saleId = await packed(legacy, PACK_PHOTO_RETENTION_DAYS + 5);
    expect(await runPackPhotos(deps())).toEqual({ moved: 1, expired: 1 });
    expect(await photoKey(saleId)).toBeNull();
    expect(await local.get(`pack/${'d'.repeat(32)}/package.jpg`)).toBeUndefined();
    expect(await local.get(legacy)).toBeUndefined();
    expect(invalidated).toEqual([legacy]);
  });
});

/** `storage` with its CDN replaced by `invalidate`. */
function withInvalidations(
  storage: ObjectStorage,
  invalidate: (keys: readonly string[]) => Promise<void>,
): ObjectStorage {
  return {
    driver: storage.driver,
    createUploadTarget: (request) => storage.createUploadTarget(request),
    head: (key) => storage.head(key),
    get: (key) => storage.get(key),
    put: (key, body, options) => storage.put(key, body, options),
    delete: (key) => storage.delete(key),
    list: (prefix, limit) => storage.list(prefix, limit),
    publicUrl: (key) => storage.publicUrl(key),
    signedReadUrl: (key, expiresAt) => storage.signedReadUrl(key, expiresAt),
    invalidatePublic: invalidate,
  };
}
