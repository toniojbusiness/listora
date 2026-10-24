import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase, createInventoryItem, SchemaMigrator, type Db } from '@listora/db';
import { createLogger, photoSetHash, sha256Hex } from '@listora/shared';
import { LocalDiskStorage, type ObjectStorage } from '@listora/storage';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DERIVATIVE_KINDS, parsePhotoDerivatives, storageKeys } from './derivatives.ts';
import { processPhoto, type PhotoProcessingDependencies } from './job.ts';
import { itemPhotoSet } from './photo-set.ts';
import { fixtureJpeg, listKeys, readMetadata } from './test-support.ts';

const logger = createLogger({ service: 'photos-test', level: 'silent' });

describe('processPhoto (real Postgres and local storage)', () => {
  let scratch: ScratchDatabase;
  let db: Db;
  let rootDir: string;
  let storage: LocalDiskStorage;
  let accountId: string;
  let gpsPhoto: Uint8Array;

  beforeAll(async () => {
    scratch = await createScratchDatabase('photos');
    db = createDatabase({ connectionString: scratch.url, max: 5 });
    await new SchemaMigrator(db).migrateToLatest();
    ({ id: accountId } = await db
      .insertInto('account')
      .values({ name: 'Photos', sku_prefix: 'PH' })
      .returning('id')
      .executeTakeFirstOrThrow());
    gpsPhoto = await fixtureJpeg({ width: 2048, height: 1536, gps: true, orientation: 6 });
  });

  afterAll(async () => {
    await db.destroy();
    await scratch.drop();
  });

  beforeEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    rootDir = await mkdtemp(join(tmpdir(), 'listora-photos-'));
    storage = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'photos-test-secret-0123456789abcdefghij',
    });
  });

  function deps(overrides: Partial<PhotoProcessingDependencies> = {}): PhotoProcessingDependencies {
    return { db, storage, logger, ...overrides };
  }

  /** An attached upload: the bytes in storage and a `processing` photo that points at them. */
  async function attachedPhoto(
    bytes: Uint8Array,
    options: { sha256?: string; itemId?: string } = {},
  ) {
    const itemId = options.itemId ?? (await createInventoryItem(db, accountId)).id;
    const storageKey = storageKeys.upload(accountId, crypto.randomUUID());
    await storage.put(storageKey, bytes, { contentType: 'image/jpeg' });
    const count = await db
      .selectFrom('photo')
      .where('item_id', '=', itemId)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    const photo = await db
      .insertInto('photo')
      .values({
        account_id: accountId,
        item_id: itemId,
        position: Number(count.count),
        role: 'front',
        storage_key: storageKey,
        width: 1,
        height: 1,
        sha256: options.sha256 ?? sha256Hex(bytes),
      })
      .returning(['id', 'item_id', 'storage_key'])
      .executeTakeFirstOrThrow();
    return { photoId: photo.id, itemId: photo.item_id, storageKey: photo.storage_key };
  }

  async function photoRow(photoId: string) {
    return db.selectFrom('photo').selectAll().where('id', '=', photoId).executeTakeFirstOrThrow();
  }

  it('makes a ready photo with every derivative, upright and without any metadata', async () => {
    const { photoId, storageKey } = await attachedPhoto(gpsPhoto);
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('ready');

    const row = await photoRow(photoId);
    expect(row).toMatchObject({ status: 'ready', failure_reason: null, width: 1536, height: 2048 });
    expect(row.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.processed_at).toBeInstanceOf(Date);
    const derivatives = parsePhotoDerivatives(row.derivatives);
    if (!derivatives) throw new Error('derivatives missing');
    expect(
      Object.fromEntries(
        DERIVATIVE_KINDS.map((kind) => [kind, [derivatives[kind].width, derivatives[kind].height]]),
      ),
    ).toEqual({
      original: [1536, 2048],
      ai: [768, 1024],
      thumbnail: [300, 400],
      listing: [1200, 1600],
    });
    expect(derivatives.thumbnail.key).toMatch(/^public\/[0-9a-f]{32}\/thumbnail\.jpg$/);
    expect(derivatives.listing.key).toMatch(/^public\/[0-9a-f]{32}\/listing\.jpg$/);
    expect(derivatives.original.key).toMatch(
      new RegExp(`^photos/${accountId}/${photoId}/[0-9a-f]{32}/original\\.jpg$`),
    );

    // The upload, which carried the GPS position, is gone. Every object left in storage is a
    // derivative, matches its recorded size and hash, and carries no metadata at all.
    expect(await storage.head(storageKey)).toBeUndefined();
    const stored = await listKeys(rootDir);
    expect(stored).toEqual(DERIVATIVE_KINDS.map((kind) => derivatives[kind].key).sort());
    for (const kind of DERIVATIVE_KINDS) {
      const bytes = await storage.get(derivatives[kind].key);
      if (!bytes) throw new Error(`${kind} missing`);
      expect(bytes.byteLength).toBe(derivatives[kind].byteSize);
      expect(sha256Hex(bytes)).toBe(derivatives[kind].sha256);
      expect(await readMetadata(bytes), kind).toMatchObject({
        hasExif: false,
        hasGps: false,
        hasXmp: false,
        hasIptc: false,
        hasIcc: false,
      });
    }
  });

  it('does nothing when it runs again for a processed photo', async () => {
    const { photoId } = await attachedPhoto(gpsPhoto);
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('ready');
    const before = await photoRow(photoId);
    const keys = await listKeys(rootDir);

    expect(await processPhoto(deps(), { accountId, photoId })).toBe('skipped');
    expect(await photoRow(photoId)).toEqual(before);
    expect(await listKeys(rootDir)).toEqual(keys);
  });

  it('deletes a leftover upload when an earlier run committed but stopped before deleting it', async () => {
    const { photoId, storageKey } = await attachedPhoto(gpsPhoto);
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('ready');
    await storage.put(storageKey, gpsPhoto, { contentType: 'image/jpeg' });

    expect(await processPhoto(deps(), { accountId, photoId })).toBe('skipped');
    expect(await storage.head(storageKey)).toBeUndefined();
  });

  it('fails a photo whose file is not a JPEG, with a reason, and deletes the upload', async () => {
    const png = new TextEncoder().encode('\x89PNG\r\n\x1a\nnot really');
    const { photoId, storageKey } = await attachedPhoto(png);
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('failed');
    expect(await photoRow(photoId)).toMatchObject({
      status: 'failed',
      failure_reason: 'This file could not be read as an image. Take or choose the photo again.',
      phash: null,
      derivatives: {},
    });
    expect(await storage.head(storageKey)).toBeUndefined();
    expect(await listKeys(rootDir)).toEqual([]);
  });

  it('fails a photo whose stored bytes do not match the attached sha256', async () => {
    const { photoId } = await attachedPhoto(gpsPhoto, { sha256: 'd'.repeat(64) });
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('failed');
    expect((await photoRow(photoId)).failure_reason).toBe(
      'The uploaded file does not match the photo that was sent. Upload it again.',
    );
    expect(await listKeys(rootDir)).toEqual([]);
  });

  it('fails a photo whose upload is missing', async () => {
    const { photoId, storageKey } = await attachedPhoto(gpsPhoto);
    await storage.delete(storageKey);
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('failed');
    expect((await photoRow(photoId)).failure_reason).toBe(
      'The uploaded file is missing. Upload the photo again.',
    );
  });

  it('skips a photo deleted before it runs, and discards its images if deleted mid-run', async () => {
    expect(await processPhoto(deps(), { accountId, photoId: crypto.randomUUID() })).toBe('skipped');

    const { photoId } = await attachedPhoto(gpsPhoto);
    let deleted = false;
    const deletingStorage: ObjectStorage = {
      ...storageMethods(storage),
      put: async (key, body, options) => {
        if (!deleted) {
          deleted = true;
          await db.deleteFrom('photo').where('id', '=', photoId).execute();
        }
        await storage.put(key, body, options);
      },
    };
    expect(await processPhoto(deps({ storage: deletingStorage }), { accountId, photoId })).toBe(
      'skipped',
    );
    // Only the upload is left, for the API's photo deletion to remove.
    expect((await listKeys(rootDir)).every((key) => key.startsWith('uploads/'))).toBe(true);
  });

  it('throws on a storage failure, leaving the photo processing and no stray images', async () => {
    const { photoId, storageKey } = await attachedPhoto(gpsPhoto);
    let puts = 0;
    const flakyStorage: ObjectStorage = {
      ...storageMethods(storage),
      put: async (key, body, options) => {
        puts += 1;
        if (puts === 3) throw new Error('storage unavailable');
        await storage.put(key, body, options);
      },
    };
    await expect(
      processPhoto(deps({ storage: flakyStorage }), { accountId, photoId }),
    ).rejects.toThrow('storage unavailable');
    expect((await photoRow(photoId)).status).toBe('processing');
    expect(await listKeys(rootDir)).toEqual([storageKey]);

    // The queue runs the job again, and this time it succeeds.
    expect(await processPhoto(deps(), { accountId, photoId })).toBe('ready');
  });

  it('only processes photos of the job’s account', async () => {
    const { photoId } = await attachedPhoto(gpsPhoto);
    const other = await db
      .insertInto('account')
      .values({ name: 'Other', sku_prefix: 'OT' })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(await processPhoto(deps(), { accountId: other.id, photoId })).toBe('skipped');
    expect((await photoRow(photoId)).status).toBe('processing');
  });

  describe('itemPhotoSet', () => {
    it('hashes the item’s photo sha256s in display order and changes when they move', async () => {
      const first = await attachedPhoto(await fixtureJpeg({ width: 64, height: 64, seed: 2 }));
      const second = await attachedPhoto(await fixtureJpeg({ width: 64, height: 64, seed: 3 }), {
        itemId: first.itemId,
      });
      const set = await itemPhotoSet(db, accountId, first.itemId);
      const hashes = await db
        .selectFrom('photo')
        .select('sha256')
        .where('item_id', '=', first.itemId)
        .orderBy('position')
        .execute();
      expect(set?.photos.map((photo) => photo.id)).toEqual([first.photoId, second.photoId]);
      expect(set?.hash).toBe(photoSetHash(hashes.map((row) => row.sha256 ?? '')));

      // Processing changes the derived images, not the set's hash.
      await processPhoto(deps(), { accountId, photoId: first.photoId });
      const processed = await itemPhotoSet(db, accountId, first.itemId);
      expect(processed?.hash).toBe(set?.hash);
      expect(processed?.photos.map((photo) => photo.status)).toEqual(['ready', 'processing']);

      // Swap the two photos (the position constraint is checked at commit).
      await db
        .updateTable('photo')
        .set({ position: sql<number>`1 - position` })
        .where('item_id', '=', first.itemId)
        .execute();
      const reordered = await itemPhotoSet(db, accountId, first.itemId);
      expect(reordered?.photos.map((photo) => photo.id)).toEqual([second.photoId, first.photoId]);
      expect(reordered?.hash).not.toBe(set?.hash);
    });

    it('is undefined for an item without photos or in another account', async () => {
      const item = await createInventoryItem(db, accountId);
      expect(await itemPhotoSet(db, accountId, item.id)).toBeUndefined();
      const { itemId } = await attachedPhoto(gpsPhoto);
      expect(await itemPhotoSet(db, crypto.randomUUID(), itemId)).toBeUndefined();
    });
  });
});

/** The driver's methods as a plain object, so a test can replace one of them. */
function storageMethods(storage: ObjectStorage): ObjectStorage {
  return {
    driver: storage.driver,
    createUploadTarget: (request) => storage.createUploadTarget(request),
    head: (key) => storage.head(key),
    get: (key) => storage.get(key),
    put: (key, body, options) => storage.put(key, body, options),
    delete: (key) => storage.delete(key),
    publicUrl: (key) => storage.publicUrl(key),
  };
}
