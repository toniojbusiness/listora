/**
 * Unlinking a marketplace through the API (docs/features/privacy.md, Unlinking a marketplace), on
 * real Postgres: after `disconnectConnection`, nothing of that marketplace shows on any screen
 * (items only its import brought in, its listings on the items that stay, its sales, its
 * tasks), the operator's timeline keeps what Listora did there, marked as from an unlinked
 * account, and the other marketplace's data is as it was. The deletion itself is tested in
 * packages/connections (marketplace-data.int.test.ts).
 */
import { randomUUID } from 'node:crypto';

import { loadActivity } from '@listora/activity';
import { PHONE_RUNTIME_VERSION } from '@listora/automation';
import { createInventoryItem, jsonb, type Marketplace } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const SELLER = 'unlink-seller@example.com';

describe('unlinking a marketplace in the API (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let accountId: string;
  const installationId = randomUUID();

  const link = (marketplace: Marketplace) =>
    api.call('linkMarketplaceSession', {
      token,
      params: { marketplace },
      body: {
        installationId,
        cookies: [
          {
            name: marketplace === 'depop' ? 'access_token' : 'jwt',
            value: `${marketplace}-session-secret`,
            domain: marketplace === 'depop' ? '.depop.com' : '.poshmark.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
          },
        ],
      },
    });

  const connectionOf = async (marketplace: Marketplace) =>
    (
      await api.db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('account_id', '=', accountId)
        .where('marketplace', '=', marketplace)
        .executeTakeFirstOrThrow()
    ).id;

  async function listed(itemId: string, marketplace: Marketplace): Promise<string> {
    const { id } = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: itemId,
        marketplace,
        connection_id: await connectionOf(marketplace),
        status: 'active',
        external_listing_id: `${marketplace}-${itemId}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'listed' })
      .where('id', '=', itemId)
      .execute();
    return id;
  }

  async function sold(itemId: string, marketplace: Marketplace, listingId: string) {
    const { id } = await api.db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace,
        external_order_id: `order-${itemId}`,
        sold_at: new Date(),
        detection_source: 'history',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: id,
        marketplace,
        item_id: itemId,
        listing_id: listingId,
        sale_price_cents: 3000,
      })
      .execute();
    await api.db
      .updateTable('marketplace_listing')
      .set({ status: 'sold' })
      .where('id', '=', listingId)
      .execute();
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'sold' })
      .where('id', '=', itemId)
      .execute();
  }

  beforeAll(async () => {
    api = await createTestApi('unlink_marketplace_data');
    token = await api.signIn(SELLER);
    accountId = (await api.tenantOf(SELLER)).accountId;
    await api.call('registerDevice', {
      token,
      params: { installationId },
      body: { name: "Sam's iPhone", platform: 'ios', runtimeVersion: PHONE_RUNTIME_VERSION },
    });
    expect((await link('depop')).status).toBe(201);
    expect((await link('poshmark')).status).toBe(201);
  });

  afterAll(async () => {
    await api.close();
  });

  it("removes everything of the unlinked marketplace from every screen, and leaves the other's", async () => {
    // Brought in by Depop's import, listed nowhere else; and one Depop sold from its history.
    const imported = await createInventoryItem(api.db, accountId, { title: 'Imported dress' });
    const soldHistory = await createInventoryItem(api.db, accountId, { title: 'Sold jacket' });
    for (const item of [imported, soldHistory]) {
      await api.db
        .insertInto('audit_log')
        .values({
          account_id: accountId,
          item_id: item.id,
          actor_kind: 'marketplace',
          action: 'item.imported',
          changes: jsonb({ marketplace: 'depop' }),
        })
        .execute();
    }
    await listed(imported.id, 'depop');
    await sold(soldHistory.id, 'depop', await listed(soldHistory.id, 'depop'));
    // Made in Listora, on both; and one sold on Poshmark.
    const own = await createInventoryItem(api.db, accountId, { title: 'Own sweater' });
    const ownDepop = await listed(own.id, 'depop');
    await listed(own.id, 'poshmark');
    // A price change Listora made on Depop: its history stays, for the owner only.
    const { id: priced } = await api.db
      .insertInto('marketplace_operation')
      .values({
        account_id: accountId,
        listing_id: ownDepop,
        kind: 'price',
        idempotency_key: `price-${own.id}`,
        desired: jsonb({ priceCents: 2500 }),
        status: 'succeeded',
        success_evidence: 'read_back',
        origin: 'user',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('operation_event')
      .values({ account_id: accountId, operation_id: priced, to_status: 'succeeded' })
      .execute();
    const poshmarkSold = await createInventoryItem(api.db, accountId, { title: 'Poshmark bag' });
    await sold(poshmarkSold.id, 'poshmark', await listed(poshmarkSold.id, 'poshmark'));

    const unlinked = await api.call('disconnectConnection', {
      token,
      params: { marketplace: 'depop' },
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ marketplace: 'depop', status: 'not_connected' });

    const items = await api.call('listItems', { token, query: {} });
    expect(items.status).toBe(200);
    expect(items.body.data.map((item) => item.title).sort()).toEqual([
      'Own sweater',
      'Poshmark bag',
    ]);
    for (const item of items.body.data) {
      expect(item.listings.map((listing) => listing.marketplace)).toEqual(['poshmark']);
    }
    expect((await api.call('getItem', { token, params: { itemId: imported.id } })).status).toBe(
      404,
    );
    const ownItem = await api.call('getItem', { token, params: { itemId: own.id } });
    expect(ownItem.body.listings.map((listing) => listing.marketplace)).toEqual(['poshmark']);

    const sales = await api.call('listSales', { token, query: {} });
    expect(sales.body.data.map((sale) => sale.marketplace)).toEqual(['poshmark']);
    const tasks = await api.call('listTasks', { token, query: {} });
    expect(JSON.stringify(tasks.body)).not.toContain('depop');

    // The item's timeline has nothing of Depop; the operator's keeps what Listora did there,
    // marked as from an unlinked account, and the item that went with it.
    const timeline = await api.call('listItemActivity', {
      token,
      params: { itemId: own.id },
      query: {},
    });
    expect(timeline.status).toBe(200);
    expect(JSON.stringify(timeline.body)).not.toContain('Depop');
    const operator = await loadActivity(api.db, { accountId, itemId: own.id, limit: 50 });
    expect(operator).toContainEqual(
      expect.objectContaining({
        kind: 'operation',
        operationId: priced,
        title: 'Change the price on Depop (unlinked account)',
      }),
    );
    expect(await loadActivity(api.db, { accountId, itemId: imported.id, limit: 50 })).toEqual([
      expect.objectContaining({ title: 'Item removed with an unlinked account' }),
    ]);

    const sessions = await api.call('listMarketplaceSessions', { token });
    const status = Object.fromEntries(
      sessions.body.data.map((session) => [session.marketplace, session.status]),
    );
    expect(status['depop']).toBe('not_linked');
    expect(status['poshmark']).not.toBe('not_linked');
  });
});
