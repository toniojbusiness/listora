import type { ErrorResponse } from '@listora/api-contract';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, TEST_AUTH_SECRET, type TestApi } from './test-support.ts';
import type { Tenant } from './tenancy.ts';

const ALICE = 'alice.adams@example.com';
const BOB = 'bob.brown@example.com';

describe('authentication and tenancy (real Postgres)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi('tenancy');
  });

  afterAll(async () => {
    await api.close();
  });

  describe('authentication', () => {
    it('requires a valid bearer token on every /v1 route', async () => {
      const cases: { headers: Record<string, string>; why: string }[] = [
        { headers: {}, why: 'no header' },
        { headers: { authorization: 'Basic dXNlcjpwYXNz' }, why: 'not bearer' },
        { headers: { authorization: 'Bearer not-a-jwt' }, why: 'not a JWT' },
        {
          headers: { authorization: `Bearer ${await signed({ secret: 'x'.repeat(40) })}` },
          why: 'another key',
        },
        {
          headers: { authorization: `Bearer ${await signed({ audience: 'someone-else' })}` },
          why: 'another audience',
        },
        { headers: { authorization: `Bearer ${unsignedToken()}` }, why: 'alg none' },
      ];
      for (const { headers, why } of cases) {
        const response = await api.app.inject({ method: 'GET', url: '/v1/items', headers });
        expect(response.statusCode, why).toBe(401);
        expect(response.headers['www-authenticate'], why).toBe('Bearer');
        const { error } = response.json<ErrorResponse>();
        expect(error, why).toMatchObject({ code: 'unauthenticated', retryable: false });
        expect(error.requestId, why).toBe(response.headers['x-request-id']);
      }
    });

    it('authenticates before reading the body or checking the Idempotency-Key', async () => {
      const response = await api.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: { 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an expired session', async () => {
      const token = await api.signIn('expiring@example.com');
      expect((await api.call('listItems', { token })).status).toBe(200);
      api.clock.now += 24 * 60 * 60 * 1000 + 1000;
      try {
        expect((await api.call('listItems', { token })).status).toBe(401);
      } finally {
        api.clock.now = Date.now();
      }
    });

    it('accepts a dev sign-in code once', async () => {
      const email = 'once@example.com';
      await api.app.inject({ method: 'POST', url: '/dev/auth/codes', payload: { email } });
      const token = await api.signIn(email);
      expect((await api.call('listItems', { token })).status).toBe(200);
    });
  });

  describe('provisioning', () => {
    it('creates the user, an account with initials as SKU prefix, and the owner membership once', async () => {
      const email = 'grace.hopper@example.com';
      const token = await api.signIn(email);
      // Several first requests at once still create one account.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => api.call('createItem', { token, body: {} })),
      );
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(responses.map((response) => response.body.sku.slice(0, 3)))).toEqual(
        new Set(['GH-']),
      );

      const users = await api.db
        .selectFrom('app_user')
        .innerJoin('membership', 'membership.user_id', 'app_user.id')
        .innerJoin('account', 'account.id', 'membership.account_id')
        .select(['app_user.auth_provider', 'membership.role', 'account.sku_prefix', 'account.name'])
        .where('app_user.email', '=', email)
        .execute();
      expect(users).toEqual([
        { auth_provider: 'dev', role: 'owner', sku_prefix: 'GH', name: email },
      ]);

      const again = await api.signIn(email);
      const tenant = await api.tenantOf(email);
      const created = await api.call('createItem', { token: again, body: {} });
      const row = await api.db
        .selectFrom('inventory_item')
        .select('account_id')
        .where('id', '=', created.body.id)
        .executeTakeFirstOrThrow();
      expect(row.account_id).toBe(tenant.accountId);
    });

    it('fails closed with 403 for a user who belongs to no account', async () => {
      const email = 'removed.member@example.com';
      const token = await api.signIn(email);
      const tenant = await api.tenantOf(email);
      await api.db.deleteFrom('membership').where('user_id', '=', tenant.userId).execute();
      const response = await api.call('listItems', { token });
      expect(response.status).toBe(403);
      expect(response.error.code).toBe('forbidden');
    });

    it('fails closed with 403 for a user in several accounts (not supported yet)', async () => {
      const email = 'two.accounts@example.com';
      const token = await api.signIn(email);
      const tenant = await api.tenantOf(email);
      const other = await api.db
        .insertInto('account')
        .values({ name: 'Second', sku_prefix: 'SC' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await api.db
        .insertInto('membership')
        .values({ account_id: other.id, user_id: tenant.userId, role: 'member' })
        .execute();
      expect((await api.call('listItems', { token })).status).toBe(403);
    });
  });

  describe('cross-tenant access fails closed', () => {
    let aliceToken: string;
    let bobToken: string;
    let alice: Tenant;
    let item: { id: string; sku: string; version: number };
    let photoId: string;
    let locationId: string;

    beforeAll(async () => {
      aliceToken = await api.signIn(ALICE);
      bobToken = await api.signIn(BOB);
      alice = await api.tenantOf(ALICE);
      item = (
        await api.call('createItem', {
          token: aliceToken,
          body: { details: { title: 'Alice only' } },
        })
      ).body;
      photoId = (
        await api.call('addItemPhoto', {
          token: aliceToken,
          params: { itemId: item.id },
          body: { uploadFileId: api.uploads.add(alice, { width: 10, height: 10 }), role: 'front' },
        })
      ).body.id;
      locationId = (
        await api.db
          .insertInto('storage_location')
          .values({ account_id: alice.accountId, code: 'A-1' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });

    async function aliceItemIsUntouched(): Promise<void> {
      const response = await api.call('getItem', {
        token: aliceToken,
        params: { itemId: item.id },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ version: 1, details: { title: 'Alice only' } });
      expect(
        response.body.photos.map((photo: { id: string; role: string }) => [photo.id, photo.role]),
      ).toEqual([[photoId, 'front']]);
    }

    it('hides another account’s items from reads as if they did not exist', async () => {
      const byId = await api.call('getItem', { token: bobToken, params: { itemId: item.id } });
      expect(byId.status).toBe(404);
      expect(byId.error.code).toBe('not_found');
      const bySku = await api.call('getItemBySku', { token: bobToken, params: { sku: item.sku } });
      expect(bySku.status).toBe(404);
      const list = await api.call('listItems', { token: bobToken, query: { q: 'Alice' } });
      expect(list.body.data).toEqual([]);
      const all = await api.call('listItems', { token: bobToken });
      expect(all.body.data.map((entry: { id: string }) => entry.id)).not.toContain(item.id);
    });

    it('rejects writes to another account’s item and its photos, changing nothing', async () => {
      const itemId = item.id;
      const attempts = [
        api.call('replaceItem', {
          token: bobToken,
          params: { itemId },
          body: { expectedVersion: 1, details: { title: 'Bob was here' } },
        }),
        api.call('deleteItem', { token: bobToken, params: { itemId } }),
        api.call('addItemPhoto', {
          token: bobToken,
          params: { itemId },
          body: { uploadFileId: api.uploads.add(alice, { width: 1, height: 1 }), role: 'front' },
        }),
        api.call('reorderItemPhotos', {
          token: bobToken,
          params: { itemId },
          body: { photoIds: [photoId] },
        }),
        api.call('updateItemPhoto', {
          token: bobToken,
          params: { itemId, photoId },
          body: { role: 'flaw' },
        }),
        api.call('deleteItemPhoto', { token: bobToken, params: { itemId, photoId } }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(404);
        expect(response.error.code).toBe('not_found');
      }
      await aliceItemIsUntouched();
      const audit = await api.db
        .selectFrom('audit_log')
        .select('action')
        .where('item_id', '=', itemId)
        .execute();
      expect(audit.map((entry) => entry.action).sort()).toEqual(['item.created', 'photo.added']);
    });

    it('rejects references to another account’s storage location and uploads', async () => {
      const response = await api.call('createItem', {
        token: bobToken,
        body: { details: { storageLocationId: locationId } },
      });
      expect(response.status).toBe(422);
      expect(fieldsOf(response)[0]).toBe('details.storageLocationId');

      const bobItem = (await api.call('createItem', { token: bobToken, body: {} })).body;
      const upload = await api.call('addItemPhoto', {
        token: bobToken,
        params: { itemId: bobItem.id },
        body: { uploadFileId: api.uploads.add(alice, { width: 1, height: 1 }), role: 'front' },
      });
      expect(upload.status).toBe(404);
    });

    it('keeps Idempotency-Keys separate per account', async () => {
      const idempotencyKey = crypto.randomUUID();
      const body = { details: { title: 'Same key' } };
      const forAlice = await api.call('createItem', { token: aliceToken, body, idempotencyKey });
      const forBob = await api.call('createItem', { token: bobToken, body, idempotencyKey });
      expect([forAlice.status, forBob.status]).toEqual([201, 201]);
      expect(forBob.body.id).not.toBe(forAlice.body.id);
      expect(forBob.body.sku.startsWith('BB-')).toBe(true);
    });
  });
});

async function signed(options: { secret?: string; audience?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: 'forged@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('listora-dev-auth')
    .setAudience(options.audience ?? 'listora-api')
    .setSubject('forged@example.com')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(options.secret ?? TEST_AUTH_SECRET));
}

function unsignedToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    iss: 'listora-dev-auth',
    aud: 'listora-api',
    sub: 'forged@example.com',
    exp: now + 3600,
  })}.`;
}
