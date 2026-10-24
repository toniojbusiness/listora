/**
 * The photo upload flow end to end, as the app runs it against the local storage driver:
 * upload session → PUT to each upload target → attach → worker job → ready photo with URLs.
 */
import type { UploadSession, UploadTarget } from '@listora/api-contract';
import { sha256Hex } from '@listora/shared';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';
import { UPLOAD_TARGET_TTL_MS } from './uploads.ts';

const ALICE = 'alice.uploads@example.com';
const BOB = 'bob.uploads@example.com';

/** A phone photo: 1800 x 1200 pixels stored sideways (EXIF orientation 6), with GPS. */
async function phonePhoto(seed = 1): Promise<Buffer> {
  const width = 1800;
  const height = 1200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * seed * 31) % 251;
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .withExif({
      IFD0: { Make: 'Apple', Model: 'iPhone 17' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '40/1 44/1 54/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '73/1 59/1 8/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function declared(bytes: Buffer) {
  return {
    contentType: 'image/jpeg' as const,
    byteSize: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

describe('photo uploads (real Postgres, local storage)', () => {
  let api: TestApi;
  let token: string;
  let bobToken: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('uploads');
    tenant = await api.tenantOf(ALICE);
  });

  // Some tests move the clock past a day, which also ends sign-in sessions.
  beforeEach(async () => {
    token = await api.signIn(ALICE);
    bobToken = await api.signIn(BOB);
  });

  afterAll(async () => {
    await api.close();
  });

  /** Sends one file the way the app does: exactly the target's method, URL, and headers. */
  async function upload(target: UploadTarget | undefined, body: Buffer, extraHeaders = {}) {
    if (!target) throw new Error('the file has no upload target');
    const url = new URL(target.url);
    return api.app.inject({
      method: target.method,
      url: `${url.pathname}${url.search}`,
      headers: {
        ...Object.fromEntries(target.headers.map((header) => [header.name, header.value])),
        ...extraHeaders,
      },
      payload: body,
    });
  }

  async function newSession(...files: Buffer[]): Promise<UploadSession> {
    const response = await api.call('createUploadSession', {
      token,
      body: { files: files.map(declared) },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function newItem(): Promise<string> {
    return (await api.call('createItem', { token, body: {} })).body.id;
  }

  it('takes a phone photo from upload to a ready photo with metadata-free public images', async () => {
    const photo = await phonePhoto();
    const second = await phonePhoto(2);
    const session = await newSession(photo, second);
    expect(session.files.map((file) => file.status)).toEqual(['pending', 'pending']);
    const [first, other] = session.files;
    expect(first?.upload).toMatchObject({ method: 'PUT' });
    expect(first?.upload?.url).toMatch(
      new RegExp(`^http://localhost:80/storage/uploads/${tenant.accountId}/${first?.id ?? ''}\\?`),
    );
    // Fifteen minutes, to the second.
    const lifetime = Date.parse(first?.upload?.expiresAt ?? '') - api.clock.now;
    expect(UPLOAD_TARGET_TTL_MS - lifetime).toBeGreaterThanOrEqual(0);
    expect(UPLOAD_TARGET_TTL_MS - lifetime).toBeLessThan(1_000);

    expect((await upload(first?.upload, photo)).statusCode).toBe(200);

    // After a relaunch the app asks where it left off: the first file is in, the second is not.
    const resumed = await api.call('getUploadSession', {
      token,
      params: { sessionId: session.id },
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.files.map((file) => [file.id, file.status])).toEqual([
      [first?.id, 'uploaded'],
      [other?.id, 'pending'],
    ]);
    expect(resumed.body.files[0]).not.toHaveProperty('upload');
    expect(resumed.body.files[1]?.upload?.url).toBeDefined();

    const itemId = await newItem();
    const attached = await api.call('addItemPhoto', {
      token,
      params: { itemId },
      body: { uploadFileId: first?.id ?? '', role: 'front', width: 1800, height: 1200 },
    });
    expect(attached.status).toBe(201);
    expect(attached.body).toMatchObject({ status: 'processing', sha256: sha256Hex(photo) });
    expect(attached.body).not.toHaveProperty('urls');

    // The worker's job: the photo turns ready, upright, with public URLs.
    expect(await api.photoJobs.runAll()).toEqual(['ready']);
    const item = await api.call('getItem', { token, params: { itemId } });
    const ready = item.body.photos[0];
    expect(ready).toMatchObject({
      id: attached.body.id,
      status: 'ready',
      width: 1200,
      height: 1800,
    });
    expect(ready?.urls?.thumbnail).toMatch(
      /^http:\/\/localhost:80\/storage\/public\/[0-9a-f]{32}\/thumbnail\.jpg$/,
    );
    expect(ready?.urls?.listing).toMatch(
      /^http:\/\/localhost:80\/storage\/public\/[0-9a-f]{32}\/listing\.jpg$/,
    );
    const list = await api.call('listItems', { token });
    expect(list.body.data.find((entry) => entry.id === itemId)?.coverPhoto).toEqual(ready);

    // What marketplaces and the app fetch: the right size, and no GPS or other metadata.
    for (const [url, longEdge] of [
      [ready?.urls?.thumbnail, 400],
      [ready?.urls?.listing, 1600],
    ] as const) {
      const response = await api.app.inject({ method: 'GET', url: new URL(url ?? '').pathname });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const metadata = await sharp(response.rawPayload).metadata();
      expect(Math.max(metadata.width, metadata.height)).toBe(longEdge);
      expect(metadata.height).toBeGreaterThan(metadata.width);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    }
    // The source photo did carry GPS.
    const source = await sharp(photo).metadata();
    expect(exifReader(source.exif ?? Buffer.alloc(0)).GPSInfo?.GPSLatitudeRef).toBe('N');

    // The upload itself, which had the GPS position, is gone; private images are never served.
    const uploadPath = new URL(first?.upload?.url ?? '').pathname;
    expect((await api.app.inject({ method: 'GET', url: uploadPath })).statusCode).toBe(404);
    const row = await api.db
      .selectFrom('photo')
      .select(['storage_key', 'derivatives'])
      .where('id', '=', attached.body.id)
      .executeTakeFirstOrThrow();
    expect(await api.storage.head(row.storage_key)).toBeUndefined();
    const original = (row.derivatives['original'] as { key: string }).key;
    expect(await api.storage.head(original)).toBeDefined();
    expect((await api.app.inject({ method: 'GET', url: `/storage/${original}` })).statusCode).toBe(
      404,
    );

    const after = await api.call('getUploadSession', { token, params: { sessionId: session.id } });
    expect(after.body.files[0]?.status).toBe('attached');
  });

  it('is idempotent: a retried request returns the same session', async () => {
    const photo = await phonePhoto();
    const idempotencyKey = crypto.randomUUID();
    const body = { files: [declared(photo)] };
    const first = await api.call('createUploadSession', { token, body, idempotencyKey });
    const again = await api.call('createUploadSession', { token, body, idempotencyKey });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
  });

  it('refuses a body that is not exactly the declared file', async () => {
    const photo = await phonePhoto();
    const session = await newSession(photo);
    const target = session.files[0]?.upload;

    const otherFile = await upload(target, await phonePhoto(3));
    expect(otherFile.statusCode).toBe(403);
    expect(otherFile.json()).toMatchObject({ error: { code: 'forbidden' } });

    const sameSizeOtherBytes = Buffer.from(photo);
    const flipped = sameSizeOtherBytes.length - 3;
    sameSizeOtherBytes[flipped] = (sameSizeOtherBytes[flipped] ?? 0) ^ 0xff;
    const tampered = await upload(target, sameSizeOtherBytes);
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const wrongType = await upload(target, photo, { 'content-type': 'image/png' });
    expect(wrongType.statusCode).toBe(403);

    const resumed = await api.call('getUploadSession', {
      token,
      params: { sessionId: session.id },
    });
    expect(resumed.body.files[0]?.status).toBe('pending');
    const itemId = await newItem();
    const attach = await api.call('addItemPhoto', {
      token,
      params: { itemId },
      body: { uploadFileId: session.files[0]?.id ?? '', role: 'front', width: 1, height: 1 },
    });
    expect(attach.status).toBe(409);
    expect(attach.error.code).toBe('upload_incomplete');
  });

  it('expires upload targets, hands out fresh ones, then expires the session', async () => {
    const photo = await phonePhoto();
    const session = await newSession(photo);
    const stale = session.files[0]?.upload;

    api.clock.now += UPLOAD_TARGET_TTL_MS + 1_000;
    expect((await upload(stale, photo)).statusCode).toBe(403);
    const fresh = (await api.call('getUploadSession', { token, params: { sessionId: session.id } }))
      .body.files[0]?.upload;
    expect(fresh?.url).not.toBe(stale?.url);
    expect((await upload(fresh, photo)).statusCode).toBe(200);

    const itemId = await newItem();
    api.clock.now += 24 * 60 * 60 * 1000;
    token = await api.signIn(ALICE);
    const late = await api.call('addItemPhoto', {
      token,
      params: { itemId },
      body: { uploadFileId: session.files[0]?.id ?? '', role: 'front', width: 1, height: 1 },
    });
    expect(late.status).toBe(409);
    expect(late.error.code).toBe('upload_expired');

    const pendingSession = await newSession(await phonePhoto(4));
    api.clock.now += 24 * 60 * 60 * 1000 + 1;
    token = await api.signIn(ALICE);
    const expired = await api.call('getUploadSession', {
      token,
      params: { sessionId: pendingSession.id },
    });
    expect(expired.body.files[0]?.status).toBe('pending');
    expect(expired.body.files[0]).not.toHaveProperty('upload');
  });

  it('marks a file that is not a usable image as a failed photo with the reason', async () => {
    const notJpeg = await sharp({
      create: { width: 40, height: 40, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const session = await newSession(notJpeg);
    expect((await upload(session.files[0]?.upload, notJpeg)).statusCode).toBe(200);
    const itemId = await newItem();
    const attached = await api.call('addItemPhoto', {
      token,
      params: { itemId },
      body: { uploadFileId: session.files[0]?.id ?? '', role: 'front', width: 40, height: 40 },
    });
    expect(attached.status).toBe(201);
    expect(await api.photoJobs.runAll()).toEqual(['failed']);

    const item = await api.call('getItem', { token, params: { itemId } });
    expect(item.body.photos[0]).toMatchObject({
      status: 'failed',
      failureReason: 'This file is not a JPEG image. Upload a JPEG photo.',
    });
    expect(item.body.photos[0]).not.toHaveProperty('urls');
  });

  it('validates the declared files against the contract limits', async () => {
    const cases = [
      { contentType: 'image/heic', byteSize: 10, sha256: 'a'.repeat(64) },
      { contentType: 'image/jpeg', byteSize: 20 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) },
      { contentType: 'image/jpeg', byteSize: 0, sha256: 'a'.repeat(64) },
      { contentType: 'image/jpeg', byteSize: 10, sha256: 'A'.repeat(64) },
    ];
    for (const file of cases) {
      const response = await api.call('createUploadSession', { token, body: { files: [file] } });
      expect(response.status, JSON.stringify(file)).toBe(422);
      expect(fieldsOf(response)[0]).toMatch(/^files\.0\./);
    }
    const tooMany = Array.from({ length: 25 }, () => cases[0]);
    const response = await api.call('createUploadSession', { token, body: { files: tooMany } });
    expect(response.status).toBe(422);
  });

  it('refuses an upload body over 20 MiB before reading it all', async () => {
    const session = await newSession(await phonePhoto());
    const response = await upload(session.files[0]?.upload, Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(response.statusCode).toBe(413);
  });

  it('keeps sessions and files to their account', async () => {
    const photo = await phonePhoto();
    const session = await newSession(photo);
    expect((await upload(session.files[0]?.upload, photo)).statusCode).toBe(200);

    const peek = await api.call('getUploadSession', {
      token: bobToken,
      params: { sessionId: session.id },
    });
    expect(peek.status).toBe(404);

    const bobItem = (await api.call('createItem', { token: bobToken, body: {} })).body.id;
    const steal = await api.call('addItemPhoto', {
      token: bobToken,
      params: { itemId: bobItem },
      body: { uploadFileId: session.files[0]?.id ?? '', role: 'front', width: 1, height: 1 },
    });
    expect(steal.status).toBe(404);
  });

  it('deletes a photo’s stored images with the photo, and with its item', async () => {
    const photo = await phonePhoto();
    const session = await newSession(photo, photo);
    for (const file of session.files)
      expect((await upload(file.upload, photo)).statusCode).toBe(200);
    const itemId = await newItem();
    const photoIds: string[] = [];
    for (const file of session.files) {
      const attached = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: { uploadFileId: file.id, role: 'front', width: 1, height: 1 },
      });
      photoIds.push(attached.body.id);
    }
    expect(await api.photoJobs.runAll()).toEqual(['ready', 'ready']);
    const keysOf = async (photoId: string) => {
      const row = await api.db
        .selectFrom('photo')
        .select('derivatives')
        .where('id', '=', photoId)
        .executeTakeFirstOrThrow();
      return Object.values(row.derivatives).map((entry) => (entry as { key: string }).key);
    };
    const [firstKeys, secondKeys] = [
      await keysOf(photoIds[0] ?? ''),
      await keysOf(photoIds[1] ?? ''),
    ];
    expect(firstKeys).toHaveLength(4);

    const removed = await api.call('deleteItemPhoto', {
      token,
      params: { itemId, photoId: photoIds[0] ?? '' },
    });
    expect(removed.status).toBe(204);
    for (const key of firstKeys) expect(await api.storage.head(key), key).toBeUndefined();
    for (const key of secondKeys) expect(await api.storage.head(key), key).toBeDefined();

    expect((await api.call('deleteItem', { token, params: { itemId } })).status).toBe(204);
    for (const key of secondKeys) expect(await api.storage.head(key), key).toBeUndefined();
  });
});
