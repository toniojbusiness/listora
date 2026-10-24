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
});
