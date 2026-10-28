import type { ItemDetails, ItemSort } from '@listora/api-contract';
import { itemSortValues } from '@listora/api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('listItems sorted (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  const ids: Record<string, string> = {};

  // Added in this order, so `added_newest` is the reverse. `twin` ties `tee` on price and is
  // added after it; `tote` ties nothing but is in a haul whose share is its cost.
  const items: { name: string; details: Omit<ItemDetails, 'quantity'> }[] = [
    {
      name: 'tee',
      details: {
        title: 'banana tee',
        listPrice: usd(3000),
        cost: usd(1000),
        purchaseDate: '2026-01-15',
      },
    },
    { name: 'hoodie', details: { title: 'Apple hoodie', listPrice: usd(5000), cost: usd(4500) } },
    { name: 'twin', details: { listPrice: usd(3000) } },
    { name: 'jeans', details: { title: 'cherry jeans', cost: usd(200) } },
    {
      name: 'belt',
      details: {
        title: '  apple belt',
        listPrice: usd(1000),
        cost: usd(1200),
        purchaseDate: '2025-06-01',
      },
    },
    { name: 'tote', details: { title: 'Canvas tote', listPrice: usd(2500) } },
  ];

  beforeAll(async () => {
    api = await createTestApi('items_sort');
    token = await api.signIn('sort.seller@example.com');
    for (const { name, details } of items) {
      const response = await api.call('createItem', { token, body: { details } });
      ids[name] = response.body.id;
    }
    // A $10 haul of 4: the tote's cost is its $2.50 share.
    const haul = await api.call('createHaul', {
      token,
      body: { total: usd(1000), itemCount: 4, itemIds: [ids['tote'] ?? ''] },
    });
    expect(haul.status).toBe(201);

    const tenant = await api.tenantOf('sort.seller@example.com');
    const listing = async (name: string, listedAt: Date | null, status: 'active' | 'ended') => {
      await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: tenant.accountId,
          item_id: ids[name] ?? '',
          marketplace: 'ebay',
          status,
          listed_at: listedAt,
        })
        .execute();
    };
    // The jeans were listed first (and their listing ended); the hoodie twice, first on Oct 3.
    await listing('jeans', new Date('2026-09-01T10:00:00Z'), 'ended');
    await listing('tee', new Date('2026-10-01T10:00:00Z'), 'active');
    await listing('hoodie', new Date('2026-10-03T10:00:00Z'), 'active');
    await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: ids['hoodie'] ?? '',
        marketplace: 'poshmark',
        status: 'active',
        listed_at: new Date('2026-10-20T10:00:00Z'),
      })
      .execute();
    await listing('twin', null, 'active');
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'sold' })
      .where('id', '=', ids['jeans'] ?? '')
      .execute();
  });

  afterAll(async () => {
    await api.close();
  });

  const names = (body: { data: { id: string }[] }) =>
    body.data.map((item) => Object.keys(ids).find((name) => ids[name] === item.id));

  const list = (query: Record<string, string | number | readonly string[]>) =>
    api.call('listItems', { token, query });

  /** Every page of `sort`, two at a time. */
  const allPages = async (sort: ItemSort, filters: Record<string, string> = {}) => {
    const seen: (string | undefined)[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await list({ ...filters, sort, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      seen.push(...names(response.body));
      cursor = response.body.nextCursor;
      if (cursor === undefined) return seen;
    }
    throw new Error('more pages than items');
  };

  const expected: Record<ItemSort, string[]> = {
    added_newest: ['tote', 'belt', 'jeans', 'twin', 'hoodie', 'tee'],
    // First listed: hoodie Oct 3 (not Oct 20), tee Oct 1, jeans Sep 1; never listed: newest first.
    listed_newest: ['hoodie', 'tee', 'jeans', 'tote', 'belt', 'twin'],
    listed_oldest: ['jeans', 'tee', 'hoodie', 'tote', 'belt', 'twin'],
    // The twin ties the tee at $30 and was added after it; no price last.
    price_high: ['hoodie', 'twin', 'tee', 'tote', 'belt', 'jeans'],
    price_low: ['belt', 'tote', 'twin', 'tee', 'hoodie', 'jeans'],
    // Still for sale, oldest first (the belt and tee by purchase date, the rest by when added),
    // then the sold jeans.
    stale_first: ['belt', 'tee', 'hoodie', 'twin', 'tote', 'jeans'],
    // $30 - $10, the tote's $25 - its $2.50 haul share, $50 - $45, $10 - $12; then no price or cost.
    profit_high: ['tote', 'tee', 'hoodie', 'belt', 'jeans', 'twin'],
    // Ignoring case and leading spaces; untitled last.
    name_az: ['belt', 'hoodie', 'tee', 'tote', 'jeans', 'twin'],
  };

  it('defaults to newest added first', async () => {
    expect(names((await list({})).body)).toEqual(expected.added_newest);
  });

  it.each(itemSortValues)('sorts by %s, the same over pages as on one', async (sort) => {
    expect(names((await list({ sort })).body)).toEqual(expected[sort]);
    expect(await allPages(sort)).toEqual(expected[sort]);
  });

  it('sorts only the items the filters and search leave', async () => {
    expect(names((await list({ sort: 'price_low', status: 'draft', q: 'e' })).body)).toEqual([
      'belt',
      'tote',
      'tee',
      'hoodie',
    ]);
    // On eBay and not ended: the jeans' listing ended, and the twin's was never listed.
    expect(await allPages('listed_oldest', { marketplace: 'ebay' })).toEqual([
      'tee',
      'hoodie',
      'twin',
    ]);
  });

  it('keeps ties in one order: equal prices newest added first', async () => {
    const tenant = await api.tenantOf('sort.seller@example.com');
    await api.db
      .updateTable('inventory_item')
      .set({ list_price_cents: 3000 })
      .where('account_id', '=', tenant.accountId)
      .execute();
    try {
      expect(await allPages('price_high')).toEqual(expected.added_newest);
    } finally {
      for (const { name, details } of items) {
        await api.db
          .updateTable('inventory_item')
          .set({ list_price_cents: details.listPrice?.amountCents ?? null })
          .where('id', '=', ids[name] ?? '')
          .execute();
      }
    }
  });

  it('refuses a cursor from another sort, or one it did not issue, with 400', async () => {
    const byPrice = await list({ sort: 'price_high', limit: 2 });
    const cursor = byPrice.body.nextCursor ?? '';
    for (const query of [
      { cursor },
      { sort: 'price_low', cursor },
      { sort: 'price_high', cursor: Buffer.from('s1:price_high:[1]').toString('base64url') },
      { sort: 'price_high', cursor: Buffer.from('s1:price_high:{').toString('base64url') },
    ]) {
      const response = await list(query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(response.error.code).toBe('invalid_request');
    }
    expect((await list({ sort: 'price_high', cursor })).status).toBe(200);
  });

  it('rejects an unknown sort with a 422 field error', async () => {
    const response = await list({ sort: 'cheapest' });
    expect(response.status).toBe(422);
    expect(response.error.fieldErrors?.[0]?.field).toBe('sort');
  });
});
