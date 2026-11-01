import { createInventoryItem } from '@listora/db';
import { useMarketplaceFeatures } from '@listora/marketplaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'drops.owner@example.com';
const OTHER = 'drops.other@example.com';
const DAY = 24 * 60 * 60_000;
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('price drops (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('price_drops');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  async function liveListing(
    brand: string,
    options: { daysAgo?: number; readOnly?: boolean; floorCents?: number } = {},
  ) {
    // A read-only Depop shop would make every later Depop connection read only (read-only.md).
    const marketplace = options.readOnly === true ? 'mercari' : 'depop';
    const item = await createInventoryItem(api.db, tenant.accountId, {
      title: `${brand} fleece`,
      brand,
      status: 'listed',
      floor_price_cents: options.floorCents ?? null,
    });
    const connection = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace,
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        read_only: options.readOnly ?? false,
        external_user_id: `shop-${item.id}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: item.id,
        marketplace,
        status: 'active',
        connection_id: connection.id,
        external_listing_id: `dp-${item.id}`,
        listed_at: new Date(Date.now() - (options.daysAgo ?? 30) * DAY),
        price_cents: 4000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { item, listingId: listing.id };
  }

  it('makes a brand rule and plans each listing’s drop a day ahead, changing no price', async () => {
    const live = await liveListing('Patagonia');
    const created = await api.call('createPriceDropRule', {
      token,
      body: { brand: '  Patagonia ', percent: 10, afterDays: 21, floor: usd(2500) },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      scope: 'brand',
      brand: 'Patagonia',
      percent: 10,
      afterDays: 21,
      floor: usd(2500),
      enabled: true,
      liveListings: 0,
    });
    const armedAt = new Date(created.body.armedAt);

    const listed = await api.call('listPriceDrops', { token });
    expect(listed.status).toBe(200);
    expect(listed.body.rules).toEqual([{ ...created.body, liveListings: 1 }]);
    expect(listed.body.planned).toEqual([
      {
        listingId: live.listingId,
        itemId: live.item.id,
        sku: live.item.sku,
        title: 'Patagonia fleece',
        marketplace: 'depop',
        ruleId: created.body.id,
        price: usd(4000),
        state: 'scheduled',
        at: new Date(armedAt.getTime() + DAY).toISOString(),
        nextPrice: usd(3600),
      },
    ]);
    // Nothing was sent: the schedule runs each drop when it is due.
    const operations = await api.db
      .selectFrom('marketplace_operation')
      .select('id')
      .where('listing_id', '=', live.listingId)
      .execute();
    expect(operations).toEqual([]);
  });

  it("gives an item its own rule over its brand's, and shows only that item's on request", async () => {
    const live = await liveListing('Patagonia', { floorCents: 3800 });
    const defaults = await api.call('getPriceDropDefaults', {
      token,
      query: { itemId: live.item.id },
    });
    expect(defaults.body).toEqual({ percent: 10, afterDays: 21, floor: usd(3800) });

    const own = await api.call('createPriceDropRule', {
      token,
      body: { itemId: live.item.id, percent: 20, afterDays: 14, floor: usd(3000) },
    });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ scope: 'item', itemId: live.item.id, sku: live.item.sku });

    const mine = await api.call('listPriceDrops', { token, query: { itemId: live.item.id } });
    expect(mine.body.rules.map((rule) => rule.id)).toEqual([own.body.id]);
    // 20% off $40 is $32, but the item's own lowest price is $38.
    expect(mine.body.planned).toMatchObject([
      { listingId: live.listingId, ruleId: own.body.id, nextPrice: usd(3800) },
    ]);

    const second = await api.call('createPriceDropRule', {
      token,
      body: { itemId: live.item.id, percent: 10, afterDays: 21, floor: usd(3000) },
    });
    expect(second.status).toBe(409);
  });

  it('turns a rule off and on, re-arming it, and deletes it', async () => {
    const created = await api.call('createPriceDropRule', {
      token,
      body: { brand: 'Carhartt', percent: 15, afterDays: 30, floor: usd(2000) },
    });
    const params = { ruleId: created.body.id };
    await api.db
      .updateTable('price_drop_rule')
      .set({ armed_at: new Date(Date.now() - 10 * DAY) })
      .where('id', '=', created.body.id)
      .execute();
    const off = await api.call('replacePriceDropRule', {
      token,
      params,
      body: { percent: 15, afterDays: 30, floor: usd(2000), enabled: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    // Off leaves its time alone; back on starts the day of notice again.
    expect(Date.now() - new Date(off.body.armedAt).getTime()).toBeGreaterThan(9 * DAY);
    const on = await api.call('replacePriceDropRule', {
      token,
      params,
      body: { percent: 15, afterDays: 30, floor: usd(2000), enabled: true },
    });
    expect(Date.now() - new Date(on.body.armedAt).getTime()).toBeLessThan(60_000);

    expect((await api.call('deletePriceDropRule', { token, params })).status).toBe(204);
    expect((await api.call('deletePriceDropRule', { token, params })).status).toBe(404);
  });

  it('shows a read-only shop’s listing as unavailable, never planned to drop', async () => {
    const live = await liveListing('Levi’s', { readOnly: true });
    await api.call('createPriceDropRule', {
      token,
      body: { brand: 'Levis', percent: 10, afterDays: 21, floor: usd(2000) },
    });
    const listed = await api.call('listPriceDrops', { token, query: { itemId: live.item.id } });
    expect(listed.body.planned).toMatchObject([
      { listingId: live.listingId, state: 'unavailable' },
    ]);
    expect(listed.body.planned[0]).not.toHaveProperty('nextPrice');
  });

  it('refuses terms out of range, no target or two, and an unknown brand', async () => {
    const create = (body: Record<string, unknown>) =>
      api.call('createPriceDropRule', {
        token,
        body: { percent: 10, afterDays: 21, floor: usd(2000), ...body },
      });
    expect((await create({ brand: 'Nike', percent: 60 })).status).toBe(422);
    expect((await create({ brand: 'Nike', afterDays: 0 })).status).toBe(422);
    expect((await create({ brand: 'Nike', floor: usd(50) })).status).toBe(422);
    expect((await create({})).status).toBe(422);
    expect((await create({ brand: '&&', itemId: tenant.accountId })).status).toBe(422);
    expect((await create({ brand: '&' })).status).toBe(422);
    expect((await create({ itemId: '0199f0b4-0000-7000-8000-000000000999' })).status).toBe(404);
  });

  it("never reads or changes another account's rules", async () => {
    const created = await api.call('createPriceDropRule', {
      token,
      body: { brand: 'Arc’teryx', percent: 10, afterDays: 21, floor: usd(5000) },
    });
    const other = await api.signIn(OTHER);
    expect((await api.call('listPriceDrops', { token: other })).body).toEqual({
      rules: [],
      planned: [],
    });
    const params = { ruleId: created.body.id };
    expect(
      (
        await api.call('replacePriceDropRule', {
          token: other,
          params,
          body: { percent: 50, afterDays: 1, floor: usd(100), enabled: true },
        })
      ).status,
    ).toBe(404);
    expect((await api.call('deletePriceDropRule', { token: other, params })).status).toBe(404);
  });

  it('is hidden (404) until it passes live, except in Test mode', async () => {
    useMarketplaceFeatures('verified');
    try {
      expect((await api.call('listPriceDrops', { token })).status).toBe(404);
      expect((await api.call('getPriceDropDefaults', { token })).status).toBe(404);
      expect(
        (
          await api.call('createPriceDropRule', {
            token,
            body: { brand: 'Nike', percent: 10, afterDays: 21, floor: usd(2000) },
          })
        ).status,
      ).toBe(404);
      await api.db
        .updateTable('account')
        .set({ test_mode: true })
        .where('id', '=', tenant.accountId)
        .execute();
      expect((await api.call('listPriceDrops', { token })).status).toBe(200);
    } finally {
      useMarketplaceFeatures('all');
      await api.db
        .updateTable('account')
        .set({ test_mode: false })
        .where('id', '=', tenant.accountId)
        .execute();
    }
  });

  it('needs a signed-in user', async () => {
    expect((await api.call('listPriceDrops')).status).toBe(401);
  });
});
