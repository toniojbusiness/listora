/**
 * Hauls against a real Postgres (docs/features/hauls.md): a haul's total split over its count,
 * each item's cost its share with the leftover cents on the first items, items joining and
 * leaving, the count fixed, a whole batch marked as one haul, and the per-item cost in profit.
 */
import { createInventoryItem } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'haul.owner@example.com';
const STRANGER = 'haul.stranger@example.com';
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('hauls (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let strangerToken: string;

  beforeAll(async () => {
    api = await createTestApi('hauls');
    token = await api.signIn(OWNER);
    strangerToken = await api.signIn(STRANGER);
  });

  afterAll(async () => {
    await api.close();
  });

  async function newItem(details: Record<string, unknown> = {}): Promise<string> {
    const created = await api.call('createItem', {
      token,
      body: { details: { title: 'Thrifted tee', ...details } },
    });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  async function items(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) ids.push(await newItem());
    return ids;
  }

  async function item(itemId: string) {
    const response = await api.call('getItem', { token, params: { itemId } });
    expect(response.status).toBe(200);
    return response.body;
  }

  async function costs(itemIds: readonly string[]): Promise<(number | undefined)[]> {
    const read = await Promise.all(itemIds.map(item));
    return read.map((row) => row.details.cost?.amountCents);
  }

  const sum = (values: readonly (number | undefined)[]) =>
    values.reduce<number>((total, value) => total + (value ?? 0), 0);

  it('splits $50 over 30 items: $1.67 each, the shares add back up to $50', async () => {
    const ids = await items(30);
    const created = await api.call('createHaul', {
      token,
      body: {
        total: usd(5_000),
        itemCount: 30,
        purchaseDate: '2026-10-26',
        purchaseSource: 'Goodwill Bins',
        itemIds: ids,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      total: usd(5_000),
      itemCount: 30,
      itemsAdded: 30,
      eachCost: usd(167),
      purchaseDate: '2026-10-26',
      purchaseSource: 'Goodwill Bins',
    });
    const shares = await costs(ids);
    // 5000 = 30 x 166 + 20: the first 20 to join carry the leftover cents.
    expect(shares).toEqual([...Array<number>(20).fill(167), ...Array<number>(10).fill(166)]);
    expect(sum(shares)).toBe(5_000);

    const first = await item(ids[0] ?? '');
    expect(first.haul).toMatchObject({ id: created.body.id, itemsAdded: 30 });
    expect(first.details).toMatchObject({
      purchaseDate: '2026-10-26',
      purchaseSource: 'Goodwill Bins',
    });
    expect(first.fieldProvenance?.['cost']).toBe('user');
  });

  it('prices items added later at the haul count, and grows the count past it', async () => {
    const created = await api.call('createHaul', {
      token,
      body: { total: usd(1_000), itemCount: 3 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ itemCount: 3, itemsAdded: 0, eachCost: usd(333) });
    const haulId = created.body.id;

    // The first item from the trip: its share is of the three the haul had.
    const [a, b, c, d] = await items(4);
    const one = await api.call('addHaulItems', {
      token,
      params: { haulId },
      body: { itemIds: [a] },
    });
    expect(one.body).toMatchObject({ itemCount: 3, itemsAdded: 1 });
    expect(await costs([a ?? ''])).toEqual([334]);

    const three = await api.call('addHaulItems', {
      token,
      params: { haulId },
      body: { itemIds: [b, c] },
    });
    expect(three.body).toMatchObject({ itemCount: 3, itemsAdded: 3 });
    expect(await costs([a, b, c].map(String))).toEqual([334, 333, 333]);

    // A fourth item: the haul had more than the seller counted, so every share drops.
    const four = await api.call('addHaulItems', {
      token,
      params: { haulId },
      body: { itemIds: [d, a] },
    });
    expect(four.body).toMatchObject({ itemCount: 4, itemsAdded: 4, eachCost: usd(250) });
    const shares = await costs([a, b, c, d].map(String));
    expect(shares).toEqual([250, 250, 250, 250]);
    expect(sum(shares)).toBe(1_000);
  });

  it('fixes the count and the total, and every item gets its new share', async () => {
    const ids = await items(3);
    const created = await api.call('createHaul', {
      token,
      body: { total: usd(1_200), itemCount: 3, purchaseSource: 'Estate sale', itemIds: ids },
    });
    const haulId = created.body.id;
    expect(await costs(ids)).toEqual([400, 400, 400]);
    const versionBefore = (await item(ids[0] ?? '')).version;

    const fixed = await api.call('replaceHaul', {
      token,
      params: { haulId },
      body: { total: usd(1_000), itemCount: 7, purchaseSource: 'Estate sale' },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ itemCount: 7, itemsAdded: 3, eachCost: usd(143) });
    // 1000 = 7 x 142 + 6: the three items here are among the first six.
    expect(await costs(ids)).toEqual([143, 143, 143]);
    const after = await item(ids[0] ?? '');
    expect(after.version).toBeGreaterThan(versionBefore);

    const history = await api.db
      .selectFrom('audit_log')
      .select('changes')
      .where('item_id', '=', ids[0] ?? '')
      .where('action', '=', 'item.updated')
      .orderBy('created_at')
      .execute();
    expect(history.at(-1)?.changes).toMatchObject({
      cost: { from: usd(400), to: usd(143) },
    });

    // Fewer than the items already in it is refused, and nothing changes.
    const tooFew = await api.call('replaceHaul', {
      token,
      params: { haulId },
      body: { total: usd(1_000), itemCount: 2 },
    });
    expect(tooFew.status).toBe(422);
    expect(fieldsOf(tooFew)).toEqual(['itemCount']);
    expect(await costs(ids)).toEqual([143, 143, 143]);
  });

  it("refuses a replaceItem that changes a haul item's cost, and keeps its other edits", async () => {
    const [id] = await items(1);
    const itemId = id ?? '';
    await api.call('createHaul', {
      token,
      body: { total: usd(500), itemCount: 2, itemIds: [itemId] },
    });
    const current = await item(itemId);
    expect(current.details.cost).toEqual(usd(250));

    const changed = await api.call('replaceItem', {
      token,
      params: { itemId },
      body: {
        expectedVersion: current.version,
        details: { ...current.details, cost: usd(900) },
      },
    });
    expect(changed.status).toBe(422);
    expect(fieldsOf(changed)).toEqual(['details.cost']);

    const cleared = await api.call('replaceItem', {
      token,
      params: { itemId },
      body: { expectedVersion: current.version, details: { title: 'No cost' } },
    });
    expect(cleared.status).toBe(422);

    const kept = await api.call('replaceItem', {
      token,
      params: { itemId },
      body: {
        expectedVersion: current.version,
        details: { ...current.details, title: 'Band tee' },
      },
    });
    expect(kept.status).toBe(200);
    expect(kept.body.details).toMatchObject({ title: 'Band tee', cost: usd(250) });
  });

  it('takes an item out: it keeps its last share, the rest move up a place', async () => {
    const ids = await items(3);
    const created = await api.call('createHaul', {
      token,
      body: { total: usd(1_000), itemCount: 3, itemIds: ids },
    });
    const haulId = created.body.id;
    expect(await costs(ids)).toEqual([334, 333, 333]);

    const removed = await api.call('removeHaulItem', {
      token,
      params: { haulId, itemId: ids[0] ?? '' },
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ itemCount: 3, itemsAdded: 2 });
    const left = await item(ids[0] ?? '');
    expect(left.haul).toBeUndefined();
    expect(left.details.cost).toEqual(usd(334));
    // The second item is now the first to have joined, so it carries the leftover cent.
    expect(await costs(ids.slice(1))).toEqual([334, 333]);

    // Out of the haul, the seller sets the item's own cost again.
    const own = await api.call('replaceItem', {
      token,
      params: { itemId: left.id },
      body: { expectedVersion: left.version, details: { ...left.details, cost: usd(800) } },
    });
    expect(own.status).toBe(200);

    const again = await api.call('removeHaulItem', {
      token,
      params: { haulId, itemId: ids[0] ?? '' },
    });
    expect(again.status).toBe(404);
  });

  it('moves an item from one haul to another, settling both', async () => {
    const [a, b, c] = await items(3);
    const first = await api.call('createHaul', {
      token,
      body: { total: usd(300), itemCount: 2, itemIds: [a, b] },
    });
    const second = await api.call('createHaul', {
      token,
      body: { total: usd(1_000), itemCount: 2, itemIds: [c] },
    });
    expect(await costs([a, b, c].map(String))).toEqual([150, 150, 500]);

    const moved = await api.call('addHaulItems', {
      token,
      params: { haulId: second.body.id },
      body: { itemIds: [a] },
    });
    expect(moved.body).toMatchObject({ itemsAdded: 2 });
    expect(await costs([c, a].map(String))).toEqual([500, 500]);
    // The first haul has one item left; it still costs its share of a haul of two.
    const firstNow = await api.call('getHaul', { token, params: { haulId: first.body.id } });
    expect(firstNow.body).toMatchObject({ itemsAdded: 1, itemCount: 2 });
    expect(await costs([b ?? ''])).toEqual([150]);
  });

  it('settles the haul when one of its items is deleted', async () => {
    const ids = await items(3);
    await api.call('createHaul', {
      token,
      body: { total: usd(1_000), itemCount: 3, itemIds: ids },
    });
    const deleted = await api.call('deleteItem', { token, params: { itemId: ids[0] ?? '' } });
    expect(deleted.status).toBe(204);
    expect(await costs(ids.slice(1))).toEqual([334, 333]);
  });

  it('marks a whole batch as one haul in one step', async () => {
    const batch = await api.call('createItemBatch', { token });
    const batchItems: string[] = [];
    for (const position of [0, 1, 2]) {
      const added = await api.call('addItemBatchItem', {
        token,
        params: { batchId: batch.body.id },
        body: { position },
      });
      batchItems.push(added.body.item.id);
    }
    const haul = await api.call('createHaul', {
      token,
      body: { total: usd(1_000), itemCount: 3, itemIds: batchItems },
    });
    expect(haul.body).toMatchObject({ itemsAdded: 3, eachCost: usd(333) });
    expect(await costs(batchItems)).toEqual([334, 333, 333]);
  });

  it("refuses another account's items and hauls", async () => {
    const [mine] = await items(1);
    const theirs = await api.call('createItem', { token: strangerToken, body: { details: {} } });
    const refused = await api.call('createHaul', {
      token,
      body: { total: usd(100), itemCount: 2, itemIds: [mine, theirs.body.id] },
    });
    expect(refused.status).toBe(422);
    expect(fieldsOf(refused)).toEqual(['itemIds[1]']);
    // Nothing was written: the item is in no haul.
    expect((await item(mine ?? '')).haul).toBeUndefined();

    const strangers = await api.call('createHaul', {
      token: strangerToken,
      body: { total: usd(100), itemCount: 1 },
    });
    const peek = await api.call('getHaul', { token, params: { haulId: strangers.body.id } });
    expect(peek.status).toBe(404);
    const join = await api.call('addHaulItems', {
      token,
      params: { haulId: strangers.body.id },
      body: { itemIds: [mine] },
    });
    expect(join.status).toBe(404);
  });

  it('lists hauls newest first, a page at a time', async () => {
    const listed = await api.call('listHauls', { token, query: { limit: 2 } });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(2);
    const [newer, older] = listed.body.data;
    expect((newer?.id ?? '') > (older?.id ?? '')).toBe(true);
    expect(listed.body.nextCursor).toBeDefined();
    const next = await api.call('listHauls', {
      token,
      query: { limit: 2, cursor: listed.body.nextCursor ?? '' },
    });
    expect(next.body.data[0]?.id).not.toBe(newer?.id);
    const strangers = await api.call('listHauls', { token: strangerToken });
    expect(strangers.body.data).toHaveLength(1);
  });

  it('counts the per-item share as the cost of goods in profit', async () => {
    const tenant = await api.tenantOf(OWNER);
    const sold = await createInventoryItem(api.db, tenant.accountId, {
      title: 'Sold from the bins',
      status: 'sold',
    });
    await api.call('createHaul', {
      token,
      body: { total: usd(5_000), itemCount: 30, itemIds: [sold.id] },
    });
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: tenant.accountId,
        marketplace: 'poshmark',
        external_order_id: 'haul-order-1',
        sold_at: new Date('2026-09-15T15:00:00Z'),
        shipping_charged_cents: 0,
        detection_source: 'manual',
        status: 'confirmed',
        confirmed_at: new Date('2026-09-15T15:00:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: tenant.accountId,
        sale_id: sale.id,
        marketplace: 'poshmark',
        item_id: sold.id,
        sale_price_cents: 2_000,
      })
      .execute();
    const report = await api.call('getProfit', {
      token,
      query: { from: '2026-09-01', to: '2026-09-30', timeZone: 'America/New_York' },
    });
    expect(report.status).toBe(200);
    expect(report.body.summary).toMatchObject({
      costOfGoods: usd(167),
      missingCostCount: 0,
      netProfit: usd(2_000 - 167),
    });
  });
});
