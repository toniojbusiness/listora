import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDEMPOTENCY_SWEEP_BATCH } from './idempotency.ts';
import { createTestApi, type TestApi } from './test-support.ts';
import type { Tenant } from './tenancy.ts';

const EMAIL = 'retry.often@example.com';

describe('Idempotency-Key (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('idempotency');
    token = await api.signIn(EMAIL);
    tenant = await api.tenantOf(EMAIL);
  });

  afterAll(async () => {
    await api.close();
  });

  async function itemCount(): Promise<number> {
    const { count } = await api.db
      .selectFrom('inventory_item')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('account_id', '=', tenant.accountId)
      .executeTakeFirstOrThrow();
    return count;
  }

  const createItem = (idempotencyKey: string | null, details: Record<string, unknown> = {}) =>
    api.call('createItem', { token, idempotencyKey, body: { details } });

  it('replays the first response to a retry instead of creating a second item', async () => {
    const key = crypto.randomUUID();
    const before = await itemCount();
    const first = await createItem(key, { title: 'Once' });
    const retry = await createItem(key, { title: 'Once' });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await itemCount()).toBe(before + 1);
  });

  it('treats the same body with keys in another order as the same request', async () => {
    const key = crypto.randomUUID();
    const first = await api.call('createItem', {
      token,
      idempotencyKey: key,
      body: { details: { title: 'Ordered', brand: 'Acme' } },
    });
    const retry = await api.call('createItem', {
      token,
      idempotencyKey: key,
      body: { details: { brand: 'Acme', title: 'Ordered' } },
    });
    expect(retry.body.id).toBe(first.body.id);
  });

  it('rejects a key reused for a different body or operation with 422', async () => {
    const key = crypto.randomUUID();
    const item = (await createItem(key, { title: 'First' })).body;

    const otherBody = await createItem(key, { title: 'Second' });
    expect(otherBody.status).toBe(422);
    expect(otherBody.error).toMatchObject({
      code: 'idempotency_key_reused',
      retryable: false,
    });

    const otherOperation = await api.call('addItemPhoto', {
      token,
      idempotencyKey: key,
      params: { itemId: item.id },
      body: { uploadFileId: await api.uploads.add(tenant), role: 'front', width: 1, height: 1 },
    });
    expect(otherOperation.status).toBe(422);
    expect(otherOperation.error.code).toBe('idempotency_key_reused');
  });

  it('stores nothing for a failed request, so a corrected retry with the same key runs', async () => {
    const key = crypto.randomUUID();
    const before = await itemCount();
    const failed = await createItem(key, { condition: 'mint' });
    expect(failed.status).toBe(422);
    const corrected = await createItem(key, { condition: 'pre_owned_good' });
    expect(corrected.status).toBe(201);
    expect(await itemCount()).toBe(before + 1);
    // From now on the key replays the success.
    expect((await createItem(key, { condition: 'pre_owned_good' })).body.id).toBe(
      corrected.body.id,
    );
  });

  it('answers 409 idempotency_key_in_progress while the same key is running', async () => {
    const key = crypto.randomUUID();
    // Hold the request's lock from another session, as a still-running first attempt would.
    const holder = new pg.Client({ connectionString: api.databaseUrl });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock(hashtextextended($1, 0))', [
        `idempotency:${tenant.accountId}:${key}`,
      ]);
      const busy = await createItem(key, { title: 'Busy' });
      expect(busy.status).toBe(409);
      expect(busy.error).toMatchObject({
        code: 'idempotency_key_in_progress',
        retryable: true,
        retryAfterSeconds: 1,
      });
      expect(busy.headers['retry-after']).toBe('1');
    } finally {
      await holder.end();
    }
    expect((await createItem(key, { title: 'Busy' })).status).toBe(201);
  });

  it('runs concurrent retries of one key exactly once', async () => {
    const key = crypto.randomUUID();
    const before = await itemCount();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => createItem(key, { title: 'Concurrent' })),
    );
    for (const response of responses) expect([201, 409]).toContain(response.status);
    const created = new Set(
      responses.filter((response) => response.status === 201).map((response) => response.body.id),
    );
    expect(created.size).toBe(1);
    expect(await itemCount()).toBe(before + 1);
  });

  it('runs the request again once the stored response has expired', async () => {
    const key = crypto.randomUUID();
    const first = await createItem(key, { title: 'Expires' });
    await sql`
      update idempotency_record
      set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
      where account_id = ${tenant.accountId} and key = ${key}
    `.execute(api.db);
    const later = await createItem(key, { title: 'Expires' });
    expect(later.status).toBe(201);
    expect(later.body.id).not.toBe(first.body.id);
  });

  it('deletes expired records of every account in bounded batches', async () => {
    const other = await api.tenantOf('someone.else@example.com');
    const expired = (account: string, count: number) =>
      sql`
        insert into idempotency_record
          (account_id, key, operation_id, request_hash, response_status, created_at, expires_at)
        select ${account}, 'expired-' || n, 'createItem', repeat('0', 64), 201,
          now() - interval '25 hours', now() - interval '1 hour'
        from generate_series(1, ${count}) as n
      `.execute(api.db);
    const remaining = async (account: string) => {
      const { count } = await api.db
        .selectFrom('idempotency_record')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('account_id', '=', account)
        .where('expires_at', '<=', sql<Date>`now()`)
        .executeTakeFirstOrThrow();
      return count;
    };
    const live = crypto.randomUUID();
    const first = await createItem(live, { title: 'Live' });
    await expired(other.accountId, IDEMPOTENCY_SWEEP_BATCH + 5);

    await createItem(crypto.randomUUID(), { title: 'Sweeps' });
    expect(await remaining(other.accountId)).toBe(5);
    await createItem(crypto.randomUUID(), { title: 'Sweeps again' });
    expect(await remaining(other.accountId)).toBe(0);
    // A record that has not expired is kept and still replays.
    expect((await createItem(live, { title: 'Live' })).body.id).toBe(first.body.id);
  });

  it('keeps the stored response for at least 24 hours', async () => {
    const key = crypto.randomUUID();
    await createItem(key);
    const row = await api.db
      .selectFrom('idempotency_record')
      .select(sql<string>`extract(epoch from expires_at - created_at)`.as('seconds'))
      .where('account_id', '=', tenant.accountId)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    expect(Number(row.seconds)).toBeGreaterThanOrEqual(24 * 60 * 60);
  });

  it('requires the header on POST and caps its length', async () => {
    const missing = await createItem(null);
    expect(missing.status).toBe(400);
    expect(missing.error).toMatchObject({ code: 'invalid_request' });
    expect(missing.error.message).toContain('Idempotency-Key');

    expect((await createItem('k'.repeat(256))).status).toBe(400);
    expect((await createItem('k'.repeat(255))).status).toBe(201);
  });
});
