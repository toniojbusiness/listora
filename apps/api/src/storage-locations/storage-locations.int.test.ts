/**
 * Storage bins against a real Postgres (docs/features/storage-bins.md): making bins with the
 * next code offered, codes kept one way and never twice, items put in a bin (one, or a run's
 * kept items together) and taken out, each move in the item's history, renaming and deleting,
 * "Find it: bin B-12" on the sale and in Pack check, and another account's bins out of reach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'bins.owner@example.com';
const STRANGER = 'bins.stranger@example.com';
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('storage bins (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let strangerToken: string;

  beforeAll(async () => {
    api = await createTestApi('storage_locations');
    token = await api.signIn(OWNER);
    strangerToken = await api.signIn(STRANGER);
  });

  afterAll(async () => {
    await api.close();
  });

  async function newItem(title = 'Thrifted tee'): Promise<string> {
    const created = await api.call('createItem', { token, body: { details: { title } } });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  async function newBin(code: string, label?: string): Promise<string> {
    const created = await api.call('createStorageLocation', {
      token,
      body: { code, ...(label === undefined ? {} : { label }) },
    });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  async function item(itemId: string) {
    const response = await api.call('getItem', { token, params: { itemId } });
    expect(response.status).toBe(200);
    return response.body;
  }

  it('offers B-1 first, then the next number of the newest series, listed in number order', async () => {
    const empty = await api.call('listStorageLocations', { token });
    expect(empty.body).toEqual({ data: [], nextCode: 'B-1' });

    const created = await api.call('createStorageLocation', {
      token,
      body: { code: '  b-2 ', label: ' Garage  shelf 1 ' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'B-2', label: 'Garage shelf 1', itemCount: 0 });
    await newBin('B-12');
    await newBin('B-3');

    const listed = await api.call('listStorageLocations', { token });
    expect(listed.body.data.map((bin) => bin.code)).toEqual(['B-2', 'B-3', 'B-12']);
    expect(listed.body.nextCode).toBe('B-13');
  });

  it('refuses a code the account has, whatever its case, and one with odd characters', async () => {
    const taken = await api.call('createStorageLocation', { token, body: { code: 'b-12' } });
    expect(taken.status).toBe(409);
    expect(taken.error.code).toBe('already_exists');
    expect(taken.error.message).toBe('You already have a bin B-12. Pick another code.');

    const odd = await api.call('createStorageLocation', { token, body: { code: 'B#7' } });
    expect(odd.status).toBe(422);
    expect(fieldsOf(odd)).toEqual(['code']);

    const blank = await api.call('createStorageLocation', { token, body: { code: '   ' } });
    expect(blank.status).toBe(422);
  });

  it('puts an item in a bin, moves it to another, and takes it out, each in its history', async () => {
    const shelf = await newBin('S-1', 'Closet');
    const box = await newBin('S-2');
    const itemId = await newItem();
    const before = await item(itemId);

    const put = await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: shelf },
      body: { itemIds: [itemId] },
    });
    expect(put.status).toBe(200);
    expect(put.body.location).toMatchObject({ code: 'S-1', itemCount: 1 });
    expect(put.body.items).toEqual([
      { itemId, sku: before.sku, title: 'Thrifted tee', status: 'draft' },
    ]);
    const inShelf = await item(itemId);
    expect(inShelf.storageLocation).toEqual({ id: shelf, code: 'S-1', label: 'Closet' });
    expect(inShelf.details.storageLocationId).toBe(shelf);
    expect(inShelf.version).toBeGreaterThan(before.version);

    // Putting it in the bin it is in changes nothing.
    await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: shelf },
      body: { itemIds: [itemId] },
    });
    expect((await item(itemId)).version).toBe(inShelf.version);

    const moved = await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: box },
      body: { itemIds: [itemId] },
    });
    expect(moved.body.location.itemCount).toBe(1);
    const left = await api.call('getStorageLocation', {
      token,
      params: { storageLocationId: shelf },
    });
    expect(left.body).toMatchObject({ location: { itemCount: 0 }, items: [] });

    const notThere = await api.call('removeStorageLocationItem', {
      token,
      params: { storageLocationId: shelf, itemId },
    });
    expect(notThere.status).toBe(404);
    const out = await api.call('removeStorageLocationItem', {
      token,
      params: { storageLocationId: box, itemId },
    });
    expect(out.status).toBe(200);
    expect(out.body.items).toEqual([]);
    expect((await item(itemId)).storageLocation).toBeUndefined();

    const history = await api.db
      .selectFrom('audit_log')
      .select(['action', 'changes'])
      .where('item_id', '=', itemId)
      .where('action', '=', 'item.storage_changed')
      .orderBy('id')
      .execute();
    expect(history.map((entry) => entry.changes)).toEqual([
      { storageLocation: { from: null, to: 'S-1' } },
      { storageLocation: { from: 'S-1', to: 'S-2' } },
      { storageLocation: { from: 'S-2', to: null } },
    ]);
  });

  it("puts a run's kept items in one bin together, refusing ids that aren't the account's", async () => {
    const bin = await newBin('RUN-1');
    const ids = [await newItem('Wool coat'), await newItem('Denim jacket'), await newItem()];
    const together = await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: bin },
      body: { itemIds: ids },
    });
    expect(together.body.location.itemCount).toBe(3);
    expect(together.body.items.map((each) => each.itemId).sort()).toEqual([...ids].sort());

    const strangerItem = await api.call('createItem', {
      token: strangerToken,
      body: { details: { title: 'Not yours' } },
    });
    const refused = await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: bin },
      body: { itemIds: [ids[0], strangerItem.body.id] },
    });
    expect(refused.status).toBe(422);
    expect(fieldsOf(refused)).toEqual(['itemIds[1]']);
  });

  it('renames a bin with its items in it, and refuses a code another bin has', async () => {
    const bin = await newBin('R-1');
    const itemId = await newItem();
    await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: bin },
      body: { itemIds: [itemId] },
    });
    const renamed = await api.call('replaceStorageLocation', {
      token,
      params: { storageLocationId: bin },
      body: { code: 'r-1a', label: 'Under the bed' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ code: 'R-1A', label: 'Under the bed', itemCount: 1 });
    expect((await item(itemId)).storageLocation?.code).toBe('R-1A');

    // Its own code is fine; a label left out is cleared.
    const same = await api.call('replaceStorageLocation', {
      token,
      params: { storageLocationId: bin },
      body: { code: 'R-1A' },
    });
    expect(same.status).toBe(200);
    expect(same.body.label).toBeUndefined();

    const taken = await api.call('replaceStorageLocation', {
      token,
      params: { storageLocationId: bin },
      body: { code: 'B-12' },
    });
    expect(taken.status).toBe(409);
  });

  it('deletes a bin; its items stay in inventory, in no bin', async () => {
    const bin = await newBin('D-1');
    const itemId = await newItem();
    await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: bin },
      body: { itemIds: [itemId] },
    });
    const deleted = await api.call('deleteStorageLocation', {
      token,
      params: { storageLocationId: bin },
    });
    expect(deleted.status).toBe(204);
    expect((await item(itemId)).storageLocation).toBeUndefined();
    const gone = await api.call('getStorageLocation', {
      token,
      params: { storageLocationId: bin },
    });
    expect(gone.status).toBe(404);
  });

  it('shows the bin on the sale and in Pack check, and counts a sold item out of the bin', async () => {
    const bin = await newBin('F-1', 'Garage shelf 3');
    const itemId = await newItem('Band tee');
    await api.call('addStorageLocationItems', {
      token,
      params: { storageLocationId: bin },
      body: { itemIds: [itemId] },
    });
    const sold = await api.call('createSale', {
      token,
      body: {
        marketplace: 'depop',
        items: [{ itemId, salePrice: usd(2500) }],
        shippingCharged: usd(0),
        soldAt: '2026-10-30T09:00:00.000Z',
      },
    });
    expect(sold.status).toBe(201);
    expect(sold.body.items[0]?.storageLocation).toEqual({
      id: bin,
      code: 'F-1',
      label: 'Garage shelf 3',
    });
    const sale = await api.call('getSale', { token, params: { saleId: sold.body.id } });
    expect(sale.body.items[0]?.storageLocation?.code).toBe('F-1');

    const order = await api.call('getPackOrder', { token, params: { saleId: sold.body.id } });
    expect(order.status).toBe(200);
    expect(order.body.items[0]?.location).toEqual({ code: 'F-1', label: 'Garage shelf 3' });

    const after = await api.call('getStorageLocation', {
      token,
      params: { storageLocationId: bin },
    });
    expect(after.body).toMatchObject({ location: { itemCount: 0 }, items: [] });
  });

  it("keeps another account's bins out of reach", async () => {
    const bin = await newBin('P-1');
    const itemId = await newItem();
    const theirs = await api.call('listStorageLocations', { token: strangerToken });
    expect(theirs.body.data).toEqual([]);
    for (const call of [
      api.call('getStorageLocation', { token: strangerToken, params: { storageLocationId: bin } }),
      api.call('replaceStorageLocation', {
        token: strangerToken,
        params: { storageLocationId: bin },
        body: { code: 'X-1' },
      }),
      api.call('deleteStorageLocation', {
        token: strangerToken,
        params: { storageLocationId: bin },
      }),
      api.call('addStorageLocationItems', {
        token: strangerToken,
        params: { storageLocationId: bin },
        body: { itemIds: [itemId] },
      }),
    ]) {
      expect((await call).status).toBe(404);
    }
    // The same code is free in another account.
    const own = await api.call('createStorageLocation', {
      token: strangerToken,
      body: { code: 'P-1' },
    });
    expect(own.status).toBe(201);
  });
});
