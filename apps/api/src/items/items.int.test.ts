import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jsonb } from '@listora/db';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'antonio.jenkins@example.com';

describe('items (real Postgres)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    api = await createTestApi('items');
    token = await api.signIn(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  const create = (details: Record<string, unknown> = {}) =>
    api.call('createItem', { token, body: { details } });

  async function auditEntries(itemId: string | null, action: string) {
    let query = api.db.selectFrom('audit_log').selectAll().where('action', '=', action);
    query =
      itemId === null ? query.where('item_id', 'is', null) : query.where('item_id', '=', itemId);
    return query.orderBy('created_at').execute();
  }

  describe('createItem', () => {
    it('creates a draft with the next gapless SKU and marks what the user wrote', async () => {
      const response = await create({
        title: 'Vintage denim jacket',
        brand: "Levi's",
        condition: 'pre_owned_good',
        colors: ['blue'],
        listPrice: { amountCents: 6500, currency: 'USD' },
        floorPrice: { amountCents: 4000, currency: 'USD' },
        measurements: [
          { name: 'pit_to_pit', value: 22.5, unit: 'in' },
          { name: 'length', value: 26, unit: 'in' },
        ],
      });

      expect(response.status).toBe(201);
      const item = response.body;
      expect(item.sku).toMatch(/^AJ-\d{6}$/);
      expect(item).toMatchObject({ status: 'draft', version: 1, photos: [], listings: [] });
      expect(item.details).toEqual({
        title: 'Vintage denim jacket',
        brand: "Levi's",
        condition: 'pre_owned_good',
        colors: ['blue'],
        listPrice: { amountCents: 6500, currency: 'USD' },
        floorPrice: { amountCents: 4000, currency: 'USD' },
        // Measurements come back in name order.
        measurements: [
          { name: 'length', value: 26, unit: 'in' },
          { name: 'pit_to_pit', value: 22.5, unit: 'in' },
        ],
        quantity: 1,
      });
      // Server-owned: every detail written through the API is the user's. The default quantity
      // was not written by anyone.
      expect(item.fieldProvenance).toEqual({
        title: 'user',
        brand: 'user',
        condition: 'user',
        colors: 'user',
        listPrice: 'user',
        floorPrice: 'user',
        measurements: 'user',
      });

      const next = await create();
      const number = (sku: string) => Number(sku.split('-')[1]);
      expect(number(next.body.sku)).toBe(number(item.sku) + 1);

      const [audit] = await auditEntries(item.id, 'item.created');
      const tenant = await api.tenantOf(OWNER);
      expect(audit).toMatchObject({ actor_kind: 'user', actor_user_id: tenant.userId });
      expect(audit?.changes).toMatchObject({
        sku: item.sku,
        title: { to: 'Vintage denim jacket' },
      });
    });

    it('creates an empty draft and omits every detail without a value', async () => {
      const response = await api.call('createItem', { token, body: {} });
      expect(response.status).toBe(201);
      expect(response.body.details).toEqual({ quantity: 1 });
      expect(response.body).not.toHaveProperty('fieldProvenance');
      expect(response.body).not.toHaveProperty('storageLocation');
    });

    it('treats empty strings and lists as no value', async () => {
      const response = await create({ title: '', colors: [], keywords: ['', 'denim'] });
      expect(response.status).toBe(201);
      expect(response.body.details).toEqual({ keywords: ['denim'], quantity: 1 });
      expect(response.body.fieldProvenance).toEqual({ keywords: 'user' });
      const row = await api.db
        .selectFrom('inventory_item')
        .select(['title', 'colors'])
        .where('id', '=', response.body.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ title: null, colors: [] });
    });

    it('rejects invalid details with one field error each and uses up no SKU', async () => {
      const before = await create();
      const response = await create({
        title: 'x'.repeat(201),
        condition: 'mint',
        upc: '012345678906',
        cost: { amountCents: -1, currency: 'USD' },
        measurements: [{ name: 'length', value: 1, unit: 'yd' }],
        quantity: 0,
        purchaseDate: '2026-02-30',
      });
      expect(response.status).toBe(422);
      expect(response.error).toMatchObject({ code: 'validation_failed', retryable: false });
      expect(fieldsOf(response).sort()).toEqual([
        'details.condition',
        'details.measurements.0.unit',
        'details.purchaseDate',
        'details.quantity',
        'details.title',
      ]);

      const after = await create();
      expect(Number(after.body.sku.split('-')[1])).toBe(Number(before.body.sku.split('-')[1]) + 1);
    });

    it('applies the rules JSON Schema cannot express', async () => {
      const response = await create({
        upc: '012345678906',
        listPrice: { amountCents: 1000, currency: 'USD' },
        floorPrice: { amountCents: 1500, currency: 'USD' },
        cost: { amountCents: -5, currency: 'USD' },
        measurements: [
          { name: 'length', value: 1, unit: 'in' },
          { name: 'length', value: 2, unit: 'in' },
        ],
      });
      expect(response.status).toBe(422);
      expect(fieldsOf(response)).toEqual([
        'details.upc',
        'details.cost.amountCents',
        'details.floorPrice',
        'details.measurements.1.name',
      ]);
      expect(response.error.fieldErrors).toContainEqual({
        field: 'details.floorPrice',
        message: 'must not be above the list price',
      });
      expect((await create({ upc: '012345678905' })).status).toBe(201);
    });

    it('accepts a storage location of the account and shows its summary', async () => {
      const tenant = await api.tenantOf(OWNER);
      const location = await api.db
        .insertInto('storage_location')
        .values({ account_id: tenant.accountId, code: 'B-12', label: 'Garage shelf 3, bin 12' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const response = await create({ storageLocationId: location.id });
      expect(response.status).toBe(201);
      expect(response.body.storageLocation).toEqual({
        id: location.id,
        code: 'B-12',
        label: 'Garage shelf 3, bin 12',
      });

      const unknown = await create({ storageLocationId: '0190a2b8-0000-7000-8000-000000000000' });
      expect(unknown.status).toBe(422);
      expect(unknown.error.fieldErrors).toEqual([
        {
          field: 'details.storageLocationId',
          message: 'is not a storage location in this account',
        },
      ]);
    });

    it('rejects an accepted analysis that is not one of the item’s', async () => {
      const response = await create({ acceptedAnalysisId: '0190a2b8-0000-7000-8000-000000000000' });
      expect(response.status).toBe(422);
      expect(response.error.fieldErrors).toEqual([
        { field: 'details.acceptedAnalysisId', message: 'is not an analysis of this item' },
      ]);
    });

    it('answers malformed requests with 400 invalid_request', async () => {
      const noBody = await api.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      });
      expect(noBody.statusCode).toBe(400);
      expect(noBody.json()).toMatchObject({ error: { code: 'invalid_request' } });

      const badJson = await api.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': crypto.randomUUID(),
          'content-type': 'application/json',
        },
        payload: '{"details": ',
      });
      expect(badJson.statusCode).toBe(400);
      expect(badJson.json()).toMatchObject({ error: { code: 'invalid_request' } });

      const notJson = await api.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': crypto.randomUUID(),
          'content-type': 'text/plain',
        },
        payload: 'hello',
      });
      expect(notJson.statusCode).toBe(400);

      const notObject = await api.call('createItem', { token, body: [1, 2] });
      expect(notObject.status).toBe(422);
    });
  });

  describe('getItem and getItemBySku', () => {
    it('finds an item by id and by SKU', async () => {
      const created = (await create({ title: 'Wool scarf' })).body;
      const byId = await api.call('getItem', { token, params: { itemId: created.id } });
      expect(byId.status).toBe(200);
      expect(byId.body).toEqual(created);
      const bySku = await api.call('getItemBySku', { token, params: { sku: created.sku } });
      expect(bySku.body).toEqual(created);
    });

    it('answers 404 for an unknown or malformed id or SKU', async () => {
      for (const itemId of ['0190a2b8-0000-7000-8000-000000000000', 'not-a-uuid', '1']) {
        const response = await api.call('getItem', { token, params: { itemId } });
        expect(response.status, itemId).toBe(404);
        expect(response.error.code).toBe('not_found');
      }
      for (const sku of ['AJ-999999', 'aj-000001', 'AJ-1']) {
        expect((await api.call('getItemBySku', { token, params: { sku } })).status, sku).toBe(404);
      }
    });
  });

  describe('replaceItem', () => {
    it('replaces every detail, clearing the ones left out, and bumps the version', async () => {
      const created = (
        await create({ title: 'Silk blouse', brand: 'Equipment', colors: ['ivory'] })
      ).body;
      const response = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: { expectedVersion: 1, details: { title: 'Silk blouse, size S', colors: ['ivory'] } },
      });
      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
      expect(response.body.details).toEqual({
        title: 'Silk blouse, size S',
        colors: ['ivory'],
        quantity: 1,
      });
      expect(response.body.fieldProvenance).toEqual({ title: 'user', colors: 'user' });

      const [audit] = await auditEntries(created.id, 'item.updated');
      expect(audit?.changes).toEqual({
        fromVersion: 1,
        toVersion: 2,
        title: { from: 'Silk blouse', to: 'Silk blouse, size S' },
        brand: { from: 'Equipment' },
      });
    });

    it('keeps the source of details the request leaves unchanged', async () => {
      const created = (await create({ brand: 'Patagonia', title: 'Fleece' })).body;
      // As if an accepted analysis had read the brand from the tag.
      await api.db
        .updateTable('inventory_item')
        .set({ field_provenance: jsonb({ brand: 'ocr', title: 'ai' }) })
        .where('id', '=', created.id)
        .execute();

      const response = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: {
          expectedVersion: 2,
          details: { brand: 'Patagonia', title: 'Synchilla fleece', sizeLabel: 'M' },
        },
      });
      expect(response.status).toBe(200);
      expect(response.body.fieldProvenance).toEqual({
        brand: 'ocr',
        title: 'user',
        sizeLabel: 'user',
      });
    });

    it('changes nothing, not even the version, when the request changes nothing', async () => {
      const created = (
        await create({
          title: 'Loafers',
          measurements: [
            { name: 'b', value: 1, unit: 'cm' },
            { name: 'a', value: 2, unit: 'cm' },
          ],
        })
      ).body;
      const response = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: {
          expectedVersion: 1,
          details: {
            ...created.details,
            measurements: [...(created.details.measurements ?? [])].reverse(),
          },
        },
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(created);
      expect(await auditEntries(created.id, 'item.updated')).toEqual([]);
    });

    it('answers 409 version_conflict for a stale version and leaves the item as it was', async () => {
      const created = (await create({ title: 'Original' })).body;
      const first = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: { expectedVersion: 1, details: { title: 'First edit' } },
      });
      expect(first.status).toBe(200);

      const stale = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: { expectedVersion: 1, details: { title: 'Lost update' } },
      });
      expect(stale.status).toBe(409);
      expect(stale.error).toMatchObject({ code: 'version_conflict', retryable: false });
      const current = await api.call('getItem', { token, params: { itemId: created.id } });
      expect(current.body).toMatchObject({ version: 2, details: { title: 'First edit' } });
    });

    it('lets exactly one of two concurrent writers of the same version win', async () => {
      const created = (await create({ title: 'Race' })).body;
      const results = await Promise.all(
        ['Writer A', 'Writer B'].map((title) =>
          api.call('replaceItem', {
            token,
            params: { itemId: created.id },
            body: { expectedVersion: 1, details: { title } },
          }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const current = await api.call('getItem', { token, params: { itemId: created.id } });
      expect(current.body.version).toBe(2);
    });

    it('rejects a status the user cannot set with 422', async () => {
      const created = (await create()).body;
      const response = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: { expectedVersion: 1, status: 'listed', details: {} },
      });
      expect(response.status).toBe(422);
      expect(response.error.fieldErrors).toEqual([
        { field: 'status', message: 'must be one of draft, ready, archived' },
      ]);
    });

    it('moves between draft, ready, and archived, but not out of a server-owned status', async () => {
      const created = (await create()).body;
      let version = 1;
      for (const status of ['ready', 'archived', 'draft']) {
        const response = await api.call('replaceItem', {
          token,
          params: { itemId: created.id },
          body: { expectedVersion: version, status, details: {} },
        });
        expect(response.status, status).toBe(200);
        expect(response.body.status).toBe(status);
        version = response.body.version;
      }

      await api.db
        .updateTable('inventory_item')
        .set({ status: 'listed' })
        .where('id', '=', created.id)
        .execute();
      const response = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: { expectedVersion: version + 1, status: 'draft', details: {} },
      });
      expect(response.status).toBe(409);
      expect(response.error.code).toBe('invalid_state_transition');
    });

    it('refuses to archive an item that is live on a marketplace', async () => {
      const created = (await create()).body;
      const tenant = await api.tenantOf(OWNER);
      await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: tenant.accountId,
          item_id: created.id,
          marketplace: 'ebay',
          status: 'active',
        })
        .execute();
      const response = await api.call('replaceItem', {
        token,
        params: { itemId: created.id },
        body: { expectedVersion: 1, status: 'archived', details: {} },
      });
      expect(response.status).toBe(409);
      expect(response.error.code).toBe('invalid_state_transition');
    });

    it('answers 404 for an unknown item', async () => {
      const response = await api.call('replaceItem', {
        token,
        params: { itemId: '0190a2b8-0000-7000-8000-000000000000' },
        body: { expectedVersion: 1, details: {} },
      });
      expect(response.status).toBe(404);
    });
  });

  describe('deleteItem', () => {
    it('deletes the item and its draft listings, keeps a history entry, and never reuses the SKU', async () => {
      const created = (await create({ title: 'To delete' })).body;
      const tenant = await api.tenantOf(OWNER);
      await api.db
        .insertInto('marketplace_listing')
        .values({ account_id: tenant.accountId, item_id: created.id, marketplace: 'depop' })
        .execute();

      const response = await api.call('deleteItem', { token, params: { itemId: created.id } });
      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect((await api.call('getItem', { token, params: { itemId: created.id } })).status).toBe(
        404,
      );

      const entries = await auditEntries(null, 'item.deleted');
      expect(entries.map((entry) => entry.changes)).toContainEqual({
        itemId: created.id,
        sku: created.sku,
      });

      const next = (await create()).body;
      expect(next.sku > created.sku).toBe(true);
      expect((await api.call('deleteItem', { token, params: { itemId: created.id } })).status).toBe(
        404,
      );
    });

    it('refuses while a listing is live', async () => {
      const created = (await create()).body;
      const tenant = await api.tenantOf(OWNER);
      await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: tenant.accountId,
          item_id: created.id,
          marketplace: 'ebay',
          status: 'ending',
        })
        .execute();
      const response = await api.call('deleteItem', { token, params: { itemId: created.id } });
      expect(response.status).toBe(409);
      expect(response.error.code).toBe('invalid_state_transition');
      expect((await api.call('getItem', { token, params: { itemId: created.id } })).status).toBe(
        200,
      );
    });

    it('refuses when marketplace history must be kept', async () => {
      const created = (await create()).body;
      const tenant = await api.tenantOf(OWNER);
      const listing = await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: tenant.accountId,
          item_id: created.id,
          marketplace: 'ebay',
          status: 'ended',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await sql`
        insert into marketplace_operation (account_id, listing_id, kind, idempotency_key, desired, origin)
        values (${tenant.accountId}, ${listing.id}, 'end', ${crypto.randomUUID()}, '{}', 'user')
      `.execute(api.db);
      const response = await api.call('deleteItem', { token, params: { itemId: created.id } });
      expect(response.status).toBe(409);
      expect(response.error.message).toContain('Archive it instead');
      expect((await api.call('getItem', { token, params: { itemId: created.id } })).status).toBe(
        200,
      );
    });
  });
});
