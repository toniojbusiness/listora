import { jsonb, type OperationStatus } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

describe('listItems (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    api = await createTestApi('items_list');
    token = await api.signIn('maria.lopez@example.com');
    const items = [
      { name: 'jacket', details: { title: 'Denim jacket', brand: "Levi's", sizeLabel: 'M' } },
      { name: 'scarf', details: { title: 'Wool scarf', keywords: ['winter', 'cozy'] } },
      { name: 'boots', details: { title: '100% leather boots', brand: 'Frye' } },
      {
        name: 'dress',
        details: { title: 'Linen dress', listPrice: { amountCents: 4500, currency: 'USD' } },
      },
    ];
    for (const { name, details } of items) {
      const response = await api.call('createItem', { token, body: { details } });
      ids[name] = response.body.id;
    }
    await api.call('replaceItem', {
      token,
      params: { itemId: ids['scarf'] ?? '' },
      body: { expectedVersion: 1, status: 'ready', details: items[1]?.details },
    });
  });

  afterAll(async () => {
    await api.close();
  });

  const list = (query: Record<string, string | number | readonly string[]> = {}) =>
    api.call('listItems', { token, query });
  const titles = (body: { data: { title?: string }[] }) => body.data.map((item) => item.title);

  it('lists newest first with summary fields, omitting empty ones', async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(titles(response.body)).toEqual([
      'Linen dress',
      '100% leather boots',
      'Wool scarf',
      'Denim jacket',
    ]);
    expect(response.body).not.toHaveProperty('nextCursor');
    const [dress, , , jacket] = response.body.data;
    expect(dress).toMatchObject({
      listPrice: { amountCents: 4500, currency: 'USD' },
      listings: [],
    });
    expect(dress).not.toHaveProperty('brand');
    expect(dress).not.toHaveProperty('coverPhoto');
    expect(jacket).toMatchObject({ brand: "Levi's", sizeLabel: 'M', status: 'draft' });
  });

  it('pages with an opaque cursor until the last page, which has none', async () => {
    const first = await list({ limit: 3 });
    expect(titles(first.body)).toEqual(['Linen dress', '100% leather boots', 'Wool scarf']);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await list({ limit: 3, cursor: first.body.nextCursor ?? '' });
    expect(titles(second.body)).toEqual(['Denim jacket']);
    expect(second.body).not.toHaveProperty('nextCursor');

    // A page exactly as long as the rest: still no cursor.
    const exact = await list({ limit: 4 });
    expect(exact.body.data).toHaveLength(4);
    expect(exact.body).not.toHaveProperty('nextCursor');
  });

  it('filters by status, given once or several times', async () => {
    expect(titles((await list({ status: 'ready' })).body)).toEqual(['Wool scarf']);
    expect((await list({ status: ['ready', 'draft'] })).body.data).toHaveLength(4);
    expect((await list({ status: 'archived' })).body.data).toEqual([]);
  });

  it('searches SKU, title, brand, and keywords, case-insensitively and literally', async () => {
    expect(titles((await list({ q: 'DENIM' })).body)).toEqual(['Denim jacket']);
    expect(titles((await list({ q: 'frye' })).body)).toEqual(['100% leather boots']);
    expect(titles((await list({ q: 'cozy' })).body)).toEqual(['Wool scarf']);
    // `%` and `_` are matched as themselves, not as wildcards.
    expect(titles((await list({ q: '100%' })).body)).toEqual(['100% leather boots']);
    expect((await list({ q: '%' })).body.data).toHaveLength(1);
    expect((await list({ q: '_' })).body.data).toEqual([]);

    const jacket = await api.call('getItem', { token, params: { itemId: ids['jacket'] ?? '' } });
    expect(titles((await list({ q: jacket.body.sku.toLowerCase() })).body)).toEqual([
      'Denim jacket',
    ]);
  });

  it('rejects an unknown status and an out-of-range limit with 422 field errors', async () => {
    const response = await list({ status: ['ready', 'sold_out'], limit: 101 });
    expect(response.status).toBe(422);
    expect(fieldsOf(response)).toEqual(['status.1', 'limit']);
    expect(response.error.fieldErrors?.[0]?.message).toMatch(/^must be one of draft, ready/);
    expect(response.error.fieldErrors?.[1]?.message).toBe('must be <= 100');
    expect((await list({ limit: 0 })).status).toBe(422);
    expect((await list({ limit: 'ten' as unknown as number })).status).toBe(422);
  });

  it('rejects a cursor it did not issue with 400 invalid_request', async () => {
    for (const cursor of ['nope', Buffer.from('v1:not-a-uuid').toString('base64url'), '']) {
      const response = await list({ cursor });
      expect(response.status, cursor).toBe(400);
      expect(response.error.code).toBe('invalid_request');
    }
  });

  it('filters to the items that need the seller: a newest change that failed or waits for them', async () => {
    const tenant = await api.tenantOf('maria.lopez@example.com');
    const listingOn = async (name: string, marketplace: 'ebay' | 'poshmark') => {
      const row = await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: tenant.accountId,
          item_id: ids[name] ?? '',
          marketplace,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    };
    let minute = 0;
    const operation = async (listingId: string, status: OperationStatus) => {
      minute += 1;
      await api.db
        .insertInto('marketplace_operation')
        .values({
          account_id: tenant.accountId,
          listing_id: listingId,
          kind: 'price',
          idempotency_key: `attention-${listingId}-${String(minute)}`,
          desired: jsonb({ price: { amountCents: 1000, currency: 'USD' } }),
          status,
          attempts: 1,
          origin: 'user',
          created_at: new Date(Date.UTC(2026, 9, 1, 12, minute)),
          ...(status === 'succeeded' ? { success_evidence: 'read_back' as const } : {}),
          ...(status === 'failed' ? { error_code: 'marketplace_error', error_message: 'No.' } : {}),
        })
        .execute();
    };
    // The jacket's newest change failed; a canceled one after it does not count.
    const jacket = await listingOn('jacket', 'ebay');
    await operation(jacket, 'succeeded');
    await operation(jacket, 'failed');
    await operation(jacket, 'canceled');
    // The boots' failure was put right by a later change.
    const boots = await listingOn('boots', 'ebay');
    await operation(boots, 'failed');
    await operation(boots, 'succeeded');
    // The dress waits for the seller on Poshmark, and is fine on eBay.
    await operation(await listingOn('dress', 'poshmark'), 'needs_user_action');
    await operation(await listingOn('dress', 'ebay'), 'succeeded');

    expect(titles((await list({ attention: 'true' })).body)).toEqual([
      'Linen dress',
      'Denim jacket',
    ]);
    expect(titles((await list({ attention: 'true', q: 'denim' })).body)).toEqual(['Denim jacket']);
    expect((await list({ attention: 'false' })).body.data).toHaveLength(4);
  });
});
