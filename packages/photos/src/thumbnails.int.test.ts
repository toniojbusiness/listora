import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInventoryItem, jsonb, type JsonObject } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger, sha256Hex } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parsePhotoDerivatives, storageKeys, type PhotoDerivatives } from './derivatives.ts';
import { processPhoto } from './job.ts';
import { fixtureJpeg, readMetadata } from './test-support.ts';
import {
  queueThumbnailRefresh,
  refreshThumbnails,
  THUMBNAIL_REFRESH_TASK,
  type ThumbnailRefreshDependencies,
} from './thumbnails.ts';

const logger = createLogger({ service: 'photos-test', level: 'silent' });

describe('refreshThumbnails (real Postgres and local storage)', () => {
  let database: MigratedDatabase;
  let rootDir: string;
  let storage: LocalDiskStorage;
  let accountId: string;

  beforeAll(async () => {
    database = await createMigratedDatabase('thumbnails', { jobQueue: true });
    accountId = await insertAccount(database.db, 'TH');
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await sql`delete from photo`.execute(database.db);
    await sql`delete from graphile_worker._private_jobs`.execute(database.db);
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    rootDir = await mkdtemp(join(tmpdir(), 'listora-thumbnails-'));
    storage = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'photos-test-secret-0123456789abcdefghij',
    });
  });

  const deps = (): ThumbnailRefreshDependencies => ({ db: database.db, storage, logger });

  /** A ready photo, processed as today, then given the 400 px thumbnail of before. */
  async function photoFromBefore(width = 2048, height = 1536): Promise<string> {
    const photoId = await readyPhoto(width, height);
    const derivatives = await derivativesOf(photoId);
    const original = await storage.get(derivatives.original.key);
    if (original === undefined) throw new Error('original missing');
    const small = new Uint8Array(
      await sharp(original).resize({ width: 400, height: 400, fit: 'inside' }).jpeg().toBuffer(),
    );
    const { width: smallWidth, height: smallHeight } = await readMetadata(small);
    const key = storageKeys.derivative(
      accountId,
      photoId,
      storageKeys.newPublicToken(),
      'thumbnail',
    );
    await storage.put(key, small, { contentType: 'image/jpeg' });
    await storage.delete(derivatives.thumbnail.key);
    const before = {
      key,
      width: smallWidth ?? 0,
      height: smallHeight ?? 0,
      byteSize: small.byteLength,
      sha256: sha256Hex(small),
    };
    await database.db
      .updateTable('photo')
      .set({ derivatives: jsonb({ ...derivatives, thumbnail: before } as unknown as JsonObject) })
      .where('id', '=', photoId)
      .execute();
    return photoId;
  }

  async function readyPhoto(width: number, height: number): Promise<string> {
    const bytes = await fixtureJpeg({ width, height });
    const { id: itemId } = await createInventoryItem(database.db, accountId);
    const storageKey = storageKeys.upload(accountId, crypto.randomUUID());
    await storage.put(storageKey, bytes, { contentType: 'image/jpeg' });
    const { id } = await database.db
      .insertInto('photo')
      .values({
        account_id: accountId,
        item_id: itemId,
        position: 0,
        role: 'front',
        storage_key: storageKey,
        width: 1,
        height: 1,
        sha256: sha256Hex(bytes),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(
      await processPhoto({ db: database.db, storage, logger }, { accountId, photoId: id }),
    ).toBe('ready');
    return id;
  }

  async function derivativesOf(photoId: string): Promise<PhotoDerivatives> {
    const row = await database.db
      .selectFrom('photo')
      .select('derivatives')
      .where('id', '=', photoId)
      .executeTakeFirstOrThrow();
    const derivatives = parsePhotoDerivatives(row.derivatives);
    if (!derivatives) throw new Error('derivatives missing');
    return derivatives;
  }

  async function queuedPasses() {
    const { rows } = await sql<{ payload: Record<string, unknown> }>`
      select job.payload
      from graphile_worker._private_jobs as job
      join graphile_worker._private_tasks as t on t.id = job.task_id
      where t.identifier = ${THUMBNAIL_REFRESH_TASK}
      order by job.id
    `.execute(database.db);
    return rows.map(({ payload }) => payload);
  }

  it('makes an old thumbnail again at the new size, under a new key, and deletes the old one', async () => {
    const photoId = await photoFromBefore();
    const before = await derivativesOf(photoId);
    expect(before.thumbnail.width).toBe(400);

    expect(await refreshThumbnails(deps(), { after: '' })).toEqual({
      refreshed: 1,
      next: undefined,
    });

    const after = await derivativesOf(photoId);
    expect([after.thumbnail.width, after.thumbnail.height]).toEqual([640, 480]);
    expect(after.thumbnail.key).not.toBe(before.thumbnail.key);
    expect(after.thumbnail.key).toMatch(/^public\/[0-9a-f]{32}\/thumbnail\.jpg$/);
    // The other images are untouched.
    expect({ ...after, thumbnail: undefined }).toEqual({ ...before, thumbnail: undefined });
    const stored = await storage.get(after.thumbnail.key);
    if (stored === undefined) throw new Error('new thumbnail missing');
    expect(sha256Hex(stored)).toBe(after.thumbnail.sha256);
    expect(stored.byteLength).toBe(after.thumbnail.byteSize);
    const metadata = await readMetadata(stored);
    expect([metadata.width, metadata.height, metadata.hasExif]).toEqual([640, 480, false]);
    expect(await storage.head(before.thumbnail.key)).toBeUndefined();

    // Done: a second pass finds nothing to refresh.
    expect(await refreshThumbnails(deps(), { after: '' })).toEqual({
      refreshed: 0,
      next: undefined,
    });
    expect(await queuedPasses()).toEqual([]);
  });

  it('leaves current thumbnails and photos smaller than the new size alone', async () => {
    const current = await readyPhoto(2048, 1536);
    const small = await readyPhoto(500, 375);
    const keys = [(await derivativesOf(current)).thumbnail, (await derivativesOf(small)).thumbnail];
    expect(keys[1]?.width).toBe(500);

    expect(await refreshThumbnails(deps(), { after: '' })).toEqual({
      refreshed: 0,
      next: undefined,
    });
    expect([
      (await derivativesOf(current)).thumbnail,
      (await derivativesOf(small)).thumbnail,
    ]).toEqual(keys);
  });

  it('works in batches, queueing the next one after the last photo it looked at', async () => {
    const first = await photoFromBefore();
    const second = await photoFromBefore();
    const [low, high] = [first, second].sort();

    expect(await refreshThumbnails(deps(), { after: '' }, 1)).toEqual({ refreshed: 1, next: low });
    expect(await queuedPasses()).toEqual([{ after: low }]);
    expect(await refreshThumbnails(deps(), { after: low ?? '' }, 1)).toEqual({
      refreshed: 1,
      next: high,
    });
    expect(await refreshThumbnails(deps(), { after: high ?? '' }, 1)).toEqual({
      refreshed: 0,
      next: undefined,
    });
    for (const photoId of [first, second]) {
      expect((await derivativesOf(photoId)).thumbnail.width).toBe(640);
    }
  });

  it('keeps the old thumbnail when the original is gone, and the pass still ends', async () => {
    const photoId = await photoFromBefore();
    const before = await derivativesOf(photoId);
    await storage.delete(before.original.key);

    expect(await refreshThumbnails(deps(), { after: '' })).toEqual({
      refreshed: 0,
      next: undefined,
    });
    expect(await derivativesOf(photoId)).toEqual(before);
    expect(await storage.head(before.thumbnail.key)).toBeDefined();
  });

  it('queues one pass at a time', async () => {
    await queueThumbnailRefresh(database.db);
    await queueThumbnailRefresh(database.db);
    expect(await queuedPasses()).toEqual([{ after: '' }]);
  });
});
