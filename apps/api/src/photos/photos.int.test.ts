import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';
import { MAX_PHOTOS_PER_ITEM } from './routes.ts';

const EMAIL = 'photo.owner@example.com';

describe('photos (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('photos');
    token = await api.signIn(EMAIL);
    tenant = await api.tenantOf(EMAIL);
  });

  afterAll(async () => {
    await api.close();
  });

  async function newItem(): Promise<string> {
    return (await api.call('createItem', { token, body: {} })).body.id;
  }

  async function addPhoto(itemId: string, body: Record<string, unknown> = {}) {
    const uploadFileId = api.uploads.add(tenant, { width: 1536, height: 2048 });
    return api.call('addItemPhoto', {
      token,
      params: { itemId },
      body: { uploadFileId, role: 'front', ...body },
    });
  }

  async function photoIds(itemId: string): Promise<string[]> {
    const item = await api.call('getItem', { token, params: { itemId } });
    return item.body.photos.map((photo: { id: string }) => photo.id);
  }

  async function positions(itemId: string): Promise<number[]> {
    const item = await api.call('getItem', { token, params: { itemId } });
    return item.body.photos.map((photo: { position: number }) => photo.position);
  }

  describe('addItemPhoto', () => {
    it('attaches an uploaded file as a processing photo with the on-device text and barcodes', async () => {
      const itemId = await newItem();
      const uploadFileId = api.uploads.add(tenant, {
        width: 1536,
        height: 2048,
        sha256: 'b'.repeat(64),
      });
      const response = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: {
          uploadFileId,
          role: 'tag',
          ocrLines: [{ text: 'RN 12345', confidence: 0.92 }],
          barcodes: [{ symbology: 'ean13', payload: '4006381333931' }],
        },
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        itemId,
        position: 0,
        role: 'tag',
        status: 'processing',
        width: 1536,
        height: 2048,
        sha256: 'b'.repeat(64),
        ocrLines: [{ text: 'RN 12345', confidence: 0.92 }],
        barcodes: [{ symbology: 'ean13', payload: '4006381333931' }],
      });
      // No derived images yet (plan task T-07), so no URLs.
      expect(response.body).not.toHaveProperty('urls');

      const item = await api.call('getItem', { token, params: { itemId } });
      expect(item.body.photos).toEqual([response.body]);
    });

    it('appends by default, inserts at a position, and the first photo is the cover', async () => {
      const itemId = await newItem();
      const first = (await addPhoto(itemId)).body.id;
      const second = (await addPhoto(itemId)).body.id;
      const front = (await addPhoto(itemId, { position: 0 })).body.id;
      const end = (await addPhoto(itemId, { position: 99 })).body.id;
      expect(await photoIds(itemId)).toEqual([front, first, second, end]);
      expect(await positions(itemId)).toEqual([0, 1, 2, 3]);

      const list = await api.call('listItems', { token });
      const summary = list.body.data.find((entry: { id: string }) => entry.id === itemId);
      expect(summary?.coverPhoto?.id).toBe(front);
    });

    it('takes the size from the request when the server has not read it from the file', async () => {
      const itemId = await newItem();
      const sized = api.uploads.add(tenant);
      const response = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: { uploadFileId: sized, role: 'back', width: 800, height: 600 },
      });
      expect(response.body).toMatchObject({ width: 800, height: 600 });

      const unsized = api.uploads.add(tenant);
      const missing = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: { uploadFileId: unsized, role: 'back' },
      });
      expect(missing.status).toBe(422);
      expect(missing.error.fieldErrors).toEqual([
        { field: 'width', message: 'is required for this file' },
        { field: 'height', message: 'is required for this file' },
      ]);
    });

    it('reports upload problems with the contract codes', async () => {
      const itemId = await newItem();
      const cases = [
        { status: 'incomplete', http: 409, code: 'upload_incomplete', retryable: false },
        { status: 'expired', http: 409, code: 'upload_expired', retryable: false },
      ] as const;
      for (const { status, http, code, retryable } of cases) {
        const uploadFileId = api.uploads.add(tenant, {}, status);
        const response = await api.call('addItemPhoto', {
          token,
          params: { itemId },
          body: { uploadFileId, role: 'front' },
        });
        expect(response.status, status).toBe(http);
        expect(response.error).toMatchObject({ code, retryable });
      }
      const unknown = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: { uploadFileId: crypto.randomUUID(), role: 'front' },
      });
      expect(unknown.status).toBe(404);
      expect(await photoIds(itemId)).toEqual([]);
    });

    it('refuses to attach the same uploaded file twice', async () => {
      const itemId = await newItem();
      const uploadFileId = api.uploads.add(tenant, { width: 10, height: 10 });
      const body = { uploadFileId, role: 'front' };
      expect((await api.call('addItemPhoto', { token, params: { itemId }, body })).status).toBe(
        201,
      );
      const again = await api.call('addItemPhoto', { token, params: { itemId }, body });
      expect(again.status).toBe(409);
      expect(again.error.code).toBe('already_exists');
    });

    it(`stops at ${String(MAX_PHOTOS_PER_ITEM)} photos`, async () => {
      const itemId = await newItem();
      for (let index = 0; index < MAX_PHOTOS_PER_ITEM; index += 1) {
        expect((await addPhoto(itemId)).status).toBe(201);
      }
      const response = await addPhoto(itemId);
      expect(response.status).toBe(422);
      expect(response.error.code).toBe('validation_failed');
    });

    it('rejects an invalid body with field errors and an unknown item with 404', async () => {
      const itemId = await newItem();
      const invalid = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: { uploadFileId: 'nope', role: 'selfie', ocrLines: [{ text: 'x', confidence: 2 }] },
      });
      expect(invalid.status).toBe(422);
      expect(fieldsOf(invalid)).toEqual(['uploadFileId', 'role', 'ocrLines.0.confidence']);

      const missingItem = await addPhoto(crypto.randomUUID());
      expect(missingItem.status).toBe(404);
    });
  });

  describe('reorderItemPhotos', () => {
    it('puts the photos in the given order', async () => {
      const itemId = await newItem();
      const [a, b, c] = [
        (await addPhoto(itemId)).body.id,
        (await addPhoto(itemId)).body.id,
        (await addPhoto(itemId)).body.id,
      ];
      const response = await api.call('reorderItemPhotos', {
        token,
        params: { itemId },
        body: { photoIds: [c, a, b] },
      });
      expect(response.status).toBe(200);
      expect(
        response.body.data.map((photo: { id: string; position: number }) => [
          photo.id,
          photo.position,
        ]),
      ).toEqual([
        [c, 0],
        [a, 1],
        [b, 2],
      ]);
      expect(await photoIds(itemId)).toEqual([c, a, b]);
    });

    it('requires every photo exactly once', async () => {
      const itemId = await newItem();
      const a = (await addPhoto(itemId)).body.id;
      const b = (await addPhoto(itemId)).body.id;
      for (const photoIds of [[a], [a, a], [a, b, crypto.randomUUID()], [a, crypto.randomUUID()]]) {
        const response = await api.call('reorderItemPhotos', {
          token,
          params: { itemId },
          body: { photoIds },
        });
        expect(response.status).toBe(422);
        expect(fieldsOf(response)[0]).toBe('photoIds');
      }
      expect(await photoIds(itemId)).toEqual([a, b]);
    });
  });

  describe('updateItemPhoto and deleteItemPhoto', () => {
    it('changes a photo’s role and records it in the item history', async () => {
      const itemId = await newItem();
      const photo = (await addPhoto(itemId)).body;
      const response = await api.call('updateItemPhoto', {
        token,
        params: { itemId, photoId: photo.id },
        body: { role: 'flaw' },
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ...photo, role: 'flaw' });
      const audit = await api.db
        .selectFrom('audit_log')
        .select('changes')
        .where('item_id', '=', itemId)
        .where('action', '=', 'photo.role_changed')
        .executeTakeFirstOrThrow();
      expect(audit.changes).toEqual({ photoId: photo.id, role: { from: 'front', to: 'flaw' } });

      const unknown = await api.call('updateItemPhoto', {
        token,
        params: { itemId, photoId: crypto.randomUUID() },
        body: { role: 'flaw' },
      });
      expect(unknown.status).toBe(404);
    });

    it('removes a photo and closes the gap in positions', async () => {
      const itemId = await newItem();
      const [a, b, c] = [
        (await addPhoto(itemId)).body.id,
        (await addPhoto(itemId)).body.id,
        (await addPhoto(itemId)).body.id,
      ];
      const response = await api.call('deleteItemPhoto', { token, params: { itemId, photoId: b } });
      expect(response.status).toBe(204);
      expect(await photoIds(itemId)).toEqual([a, c]);
      expect(await positions(itemId)).toEqual([0, 1]);
      const again = await api.call('deleteItemPhoto', { token, params: { itemId, photoId: b } });
      expect(again.status).toBe(404);
    });

    it('removes the photos with their item', async () => {
      const itemId = await newItem();
      await addPhoto(itemId);
      expect((await api.call('deleteItem', { token, params: { itemId } })).status).toBe(204);
      const left = await api.db
        .selectFrom('photo')
        .select('id')
        .where('item_id', '=', itemId)
        .execute();
      expect(left).toEqual([]);
    });
  });
});
