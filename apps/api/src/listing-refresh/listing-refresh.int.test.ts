import { createInventoryItem } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'refresh.owner@example.com';
const OTHER = 'refresh.other@example.com';
const HOUR = 60 * 60_000;

describe('listing refresh (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('listing_refresh');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  it('defaults to every 72 hours, and saves a cadence and a quiet window', async () => {
    const before = await api.call('getListingRefreshSettings', { token });
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ cadence: 'every_72_hours' });

    const saved = await api.call('replaceListingRefreshSettings', {
      token,
      body: {
        cadence: 'custom',
        customHours: 36,
        quietWindow: { start: '22:00', end: '07:00' },
        timeZone: 'America/New_York',
      },
    });
    expect(saved.status).toBe(200);
    const expected = {
      cadence: 'custom',
      customHours: 36,
      quietWindow: { start: '22:00', end: '07:00' },
      timeZone: 'America/New_York',
    };
    expect(saved.body).toEqual(expected);
    expect((await api.call('getListingRefreshSettings', { token })).body).toEqual(expected);

    // Back to a named cadence, without a window.
    const plain = await api.call('replaceListingRefreshSettings', {
      token,
      body: { cadence: 'weekly', timeZone: 'America/New_York' },
    });
    expect(plain.body).toEqual({ cadence: 'weekly', timeZone: 'America/New_York' });
  });

  it('refuses custom hours out of range or without custom, an empty window, and an unknown zone', async () => {
    const replace = (body: Record<string, unknown>) =>
      api.call('replaceListingRefreshSettings', {
        token,
        body: { timeZone: 'America/New_York', ...body },
      });
    expect((await replace({ cadence: 'custom' })).status).toBe(422);
    expect((await replace({ cadence: 'custom', customHours: 11 })).status).toBe(422);
    expect((await replace({ cadence: 'daily', customHours: 24 })).status).toBe(422);
    expect(
      (await replace({ cadence: 'daily', quietWindow: { start: '22:00', end: '22:00' } })).status,
    ).toBe(422);
    expect((await replace({ cadence: 'daily', timeZone: 'Mars/Olympus' })).status).toBe(422);
    expect((await replace({ cadence: 'sometimes' })).status).toBe(422);
  });

  it("gives an item its own cadence over the account's, and back", async () => {
    const item = await createInventoryItem(api.db, tenant.accountId, { title: 'Wool coat' });
    const params = { itemId: item.id };
    expect((await api.call('getItemRefresh', { token, params })).body).toEqual({
      accountCadence: 'weekly',
    });
    const off = await api.call('replaceItemRefresh', { token, params, body: { cadence: 'off' } });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ cadence: 'off', accountCadence: 'weekly' });
    expect((await api.call('getItemRefresh', { token, params })).body).toEqual(off.body);
    const custom = await api.call('replaceItemRefresh', {
      token,
      params,
      body: { cadence: 'custom', customHours: 48 },
    });
    expect(custom.body).toEqual({ cadence: 'custom', customHours: 48, accountCadence: 'weekly' });
    const back = await api.call('replaceItemRefresh', { token, params, body: {} });
    expect(back.body).toEqual({ accountCadence: 'weekly' });
    expect(
      (await api.call('replaceItemRefresh', { token, params, body: { cadence: 'custom' } })).status,
    ).toBe(422);
  });

  it("shows each live listing's next and last refresh on the item", async () => {
    await api.call('replaceListingRefreshSettings', {
      token,
      body: { cadence: 'every_72_hours', timeZone: 'America/New_York' },
    });
    const item = await createInventoryItem(api.db, tenant.accountId, {
      title: 'Silk scarf',
      status: 'listed',
    });
    const connection = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'poshmark',
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listedAt = new Date(Date.now() - 24 * HOUR);
    await api.db
      .insertInto('marketplace_listing')
      .values([
        {
          account_id: tenant.accountId,
          item_id: item.id,
          marketplace: 'poshmark',
          status: 'active',
          connection_id: connection.id,
          external_listing_id: 'a'.repeat(24),
          listed_at: listedAt,
        },
        {
          account_id: tenant.accountId,
          item_id: item.id,
          marketplace: 'ebay',
          status: 'active',
          external_listing_id: '1234567890',
          listed_at: listedAt,
        },
      ])
      .execute();

    const response = await api.call('getItem', { token, params: { itemId: item.id } });
    expect(response.status).toBe(200);
    const byMarketplace = Object.fromEntries(
      response.body.listings.map((listing) => [listing.marketplace, listing.refresh]),
    );
    expect(byMarketplace['poshmark']).toEqual({
      state: 'scheduled',
      nextAt: new Date(listedAt.getTime() + 72 * HOUR).toISOString(),
    });
    // eBay has no refresh that keeps watchers.
    expect(byMarketplace['ebay']).toEqual({ state: 'unavailable' });

    await api.call('replaceItemRefresh', {
      token,
      params: { itemId: item.id },
      body: { cadence: 'off' },
    });
    const off = await api.call('getItem', { token, params: { itemId: item.id } });
    expect(
      off.body.listings.find((listing) => listing.marketplace === 'poshmark')?.refresh,
    ).toEqual({
      state: 'off',
    });
  });

  it("never reads or changes another account's item", async () => {
    const item = await createInventoryItem(api.db, tenant.accountId, { title: 'Private' });
    const other = await api.signIn(OTHER);
    const params = { itemId: item.id };
    expect((await api.call('getItemRefresh', { token: other, params })).status).toBe(404);
    expect(
      (await api.call('replaceItemRefresh', { token: other, params, body: { cadence: 'off' } }))
        .status,
    ).toBe(404);
    expect((await api.call('getItemRefresh', { token, params })).body).not.toHaveProperty(
      'cadence',
    );
  });

  it('needs a signed-in user', async () => {
    expect((await api.call('getListingRefreshSettings')).status).toBe(401);
  });
});
