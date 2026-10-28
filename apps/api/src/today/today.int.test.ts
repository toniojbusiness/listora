import { createInventoryItem, jsonb } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'today.owner@example.com';
const OTHER = 'today.other@example.com';
const DAY = 24 * 60 * 60_000;

describe('today (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('today');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  const accountId = () => tenant.accountId;

  /** A sold item with a ready cover photo, kept in bin B-12, sold on eBay a day ago. */
  async function soldItem(): Promise<{ itemId: string; saleId: string; saleItemId: string }> {
    const location = await api.db
      .insertInto('storage_location')
      .values({ account_id: accountId(), code: 'B-12', label: 'Garage shelf 3' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const item = await createInventoryItem(api.db, accountId(), {
      title: 'Levi trucker jacket',
      status: 'sold',
      storage_location_id: location.id,
    });
    const derivative = (kind: string) => ({
      key: `public/photos/${item.id}/${kind}.jpg`,
      width: 400,
      height: 400,
      byteSize: 1000,
      sha256: 'a'.repeat(64),
    });
    await api.db
      .insertInto('photo')
      .values({
        account_id: accountId(),
        item_id: item.id,
        position: 0,
        role: 'front',
        storage_key: `uploads/${item.id}`,
        width: 1200,
        height: 1200,
        sha256: 'b'.repeat(64),
        phash: '0'.repeat(16),
        status: 'ready',
        processed_at: new Date(api.clock.now),
        derivatives: jsonb({
          original: derivative('original'),
          ai: derivative('ai'),
          thumbnail: derivative('thumbnail'),
          listing: derivative('listing'),
        }),
      })
      .execute();
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: accountId(),
        marketplace: 'ebay',
        external_order_id: `order-${item.id}`,
        sold_at: new Date(api.clock.now - DAY),
        ship_by: new Date(api.clock.now + 2 * DAY),
        detection_source: 'webhook',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const line = await api.db
      .insertInto('sale_item')
      .values({
        account_id: accountId(),
        sale_id: sale.id,
        marketplace: 'ebay',
        item_id: item.id,
        sale_price_cents: 6800,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { itemId: item.id, saleId: sale.id, saleItemId: line.id };
  }

  it("is all caught up for a new account, with this week's and last week's money", async () => {
    const response = await api.call('getToday', {
      token: await api.signIn('today.new@example.com'),
    });
    expect(response.status).toBe(200);
    expect(response.body.cards).toEqual([]);
    expect(response.body.money.thisWeek).toEqual({
      start: expect.any(String) as string,
      end: response.body.generatedAt,
      sales: 0,
      itemsSold: 0,
      salesTotal: { amountCents: 0, currency: 'USD' },
      profit: { amountCents: 0, currency: 'USD' },
      profitPendingSales: 0,
    });
    expect(response.body.money.lastWeek.end).toBe(response.body.money.thisWeek.start);
  });

  it('shows each card with its facts and one action, most urgent first', async () => {
    const sold = await soldItem();
    await createInventoryItem(api.db, accountId(), { title: 'Draft tee', status: 'draft' });
    const connection = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId(),
        marketplace: 'ebay',
        mode: 'api',
        external_user_id: 'today-seller',
        display_name: 'today_seller',
        status: 'reauth_required',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A listing live for weeks is no card: listing refresh keeps it fresh on its own.
    const old = await createInventoryItem(api.db, accountId(), {
      title: 'Old cardigan',
      status: 'listed',
      list_price_cents: 4500,
      floor_price_cents: 3500,
    });
    await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId(),
        item_id: old.id,
        marketplace: 'ebay',
        status: 'active',
        external_listing_id: 'stale-1',
        price_cents: 4500,
        listed_at: new Date(api.clock.now - 40 * DAY),
      })
      .execute();

    const response = await api.call('getToday', { token });
    expect(response.status).toBe(200);
    const { cards } = response.body;
    expect(cards.map((card) => card.kind)).toEqual(['ship', 'reconnect', 'review_drafts']);
    expect(cards[0]).toEqual({
      id: `ship:${sold.saleItemId}`,
      kind: 'ship',
      urgency: 'high',
      title: 'Ship Levi trucker jacket',
      detail: 'Sold on eBay',
      action: {
        label: 'Open sale',
        destination: 'sale',
        itemId: sold.itemId,
        saleId: sold.saleId,
      },
      item: {
        id: sold.itemId,
        sku: expect.stringMatching(/^[A-Z]+-\d{6}$/) as string,
        title: 'Levi trucker jacket',
        thumbnailUrl: expect.stringContaining('/thumbnail.jpg') as string,
      },
      shipment: {
        saleId: sold.saleId,
        marketplace: 'ebay',
        soldAt: expect.any(String) as string,
        shipBy: expect.any(String) as string,
        location: { code: 'B-12', label: 'Garage shelf 3' },
      },
    });
    expect(cards[1]).toMatchObject({
      title: 'Reconnect eBay',
      action: { label: 'Reconnect', destination: 'marketplaces', connectionId: connection.id },
      connection: {
        connectionId: connection.id,
        marketplace: 'ebay',
        displayName: 'today_seller',
        status: 'reauth_required',
      },
    });
    expect(cards[2]).toMatchObject({
      title: '1 draft to review',
      action: { destination: 'drafts' },
      drafts: { count: 1 },
    });
    // Sales this week, without a profit until the sale's fees are recorded.
    expect(response.body.money.thisWeek).toMatchObject({
      sales: 1,
      itemsSold: 1,
      salesTotal: { amountCents: 6800, currency: 'USD' },
      profitPendingSales: 1,
    });
    expect(response.body.money.thisWeek).not.toHaveProperty('profit');

    // Done cards disappear: the item ships and the connection works again.
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'shipped' })
      .where('id', '=', sold.itemId)
      .execute();
    await api.db
      .updateTable('marketplace_connection')
      .set({ status: 'connected' })
      .where('id', '=', connection.id)
      .execute();
    const after = await api.call('getToday', { token });
    expect(after.body.cards.map((card) => card.kind)).toEqual(['review_drafts']);
  });

  it("never shows another account's cards", async () => {
    const other = await api.call('getToday', { token: await api.signIn(OTHER) });
    expect(other.status).toBe(200);
    expect(other.body.cards).toEqual([]);
    expect(other.body.money.thisWeek.sales).toBe(0);
  });

  it('needs a signed-in user', async () => {
    expect((await api.call('getToday', {})).status).toBe(401);
    expect((await api.call('getTodaySettings', {})).status).toBe(401);
  });

  describe('the morning summary setting', () => {
    it('has defaults until saved, then the saved setting', async () => {
      const owner = await api.signIn('today.settings@example.com');
      const initial = await api.call('getTodaySettings', { token: owner });
      expect(initial.status).toBe(200);
      expect(initial.body).toEqual({ enabled: true, time: '08:00' });

      const body = { enabled: false, time: '06:30', timeZone: 'America/Chicago' };
      const saved = await api.call('replaceTodaySettings', { token: owner, body });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual(body);
      expect((await api.call('getTodaySettings', { token: owner })).body).toEqual(body);
      // Another account keeps its own.
      expect((await api.call('getTodaySettings', { token })).body).toEqual({
        enabled: true,
        time: '08:00',
      });
    });

    it('refuses an unknown time zone and a malformed time', async () => {
      const unknown = await api.call('replaceTodaySettings', {
        token,
        body: { enabled: true, time: '08:00', timeZone: 'Atlantis/Capital' },
      });
      expect(unknown.status).toBe(422);
      expect(fieldsOf(unknown)).toEqual(['timeZone']);

      const malformed = await api.call('replaceTodaySettings', {
        token,
        body: { enabled: true, time: '25:00', timeZone: 'UTC' },
      });
      expect(malformed.status).toBe(422);

      const missingZone = await api.call('replaceTodaySettings', {
        token,
        body: { enabled: true, time: '08:00' },
      });
      expect(missingZone.status).toBe(422);
    });
  });
});
