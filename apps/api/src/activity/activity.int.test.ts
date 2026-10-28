import { randomUUID } from 'node:crypto';

import { createInventoryItem, jsonb } from '@listora/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'activity.owner@example.com';
const OTHER = 'activity.other@example.com';
const MINUTE = 60_000;

describe('activity (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('activity');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  const accountId = () => tenant.accountId;
  const ago = (minutes: number) => new Date(api.clock.now - minutes * MINUTE);

  /** A Mercari connection that runs on the phone, with its sale-check schedule. */
  async function mercari(health: 'healthy' | 'failing' = 'healthy') {
    const connection =
      (await api.db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('account_id', '=', accountId())
        .where('marketplace', '=', 'mercari')
        .executeTakeFirst()) ??
      (await api.db
        .insertInto('marketplace_connection')
        .values({
          account_id: accountId(),
          marketplace: 'mercari',
          mode: 'automation',
          status: 'connected',
          token_ciphertext: Buffer.from('sealed'),
          runs_on: 'phone',
        })
        .returning('id')
        .executeTakeFirstOrThrow());
    await sql`delete from sale_check_schedule where connection_id = ${connection.id}`.execute(
      api.db,
    );
    await api.db
      .insertInto('sale_check_schedule')
      .values({
        account_id: accountId(),
        connection_id: connection.id,
        marketplace: 'mercari',
        next_check_at: ago(-60),
        next_reason: 'retry',
        last_started_at: ago(5),
        last_finished_at: ago(5),
        last_outcome: health === 'healthy' ? 'succeeded' : 'failed',
        last_succeeded_at: ago(health === 'healthy' ? 5 : 600),
        failures_in_a_row: health === 'healthy' ? 0 : 3,
        last_error_code: health === 'healthy' ? null : 'element_missing',
        last_error_message:
          health === 'healthy'
            ? null
            : "Mercari's sold items page has changed, so Listora couldn't read it.",
        health,
        unhealthy_since: health === 'healthy' ? null : ago(240),
      })
      .execute();
    return connection.id;
  }

  /** A listed item with a delist operation that ran on the phone, and a sale a check saw. */
  async function soldItem() {
    const connectionId = await mercari();
    const item = await createInventoryItem(api.db, accountId(), { title: 'Trucker jacket' });
    const listing = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId(),
        item_id: item.id,
        marketplace: 'mercari',
        connection_id: connectionId,
        external_listing_id: `m-${item.id}`,
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const check = await api.db
      .insertInto('sale_check_run')
      .values({
        account_id: accountId(),
        connection_id: connectionId,
        marketplace: 'mercari',
        kind: 'scheduled',
        reason: 'scheduled',
        host: 'phone',
        started_at: ago(30),
        finished_at: ago(29),
        outcome: 'succeeded',
        orders_seen: 2,
        items_seen: 2,
        new_orders: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: accountId(),
        marketplace: 'mercari',
        external_order_id: `order-${item.id}`,
        sold_at: ago(40),
        detection_source: 'poll',
        sale_check_run_id: check.id,
        created_at: ago(28),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: accountId(),
        sale_id: sale.id,
        marketplace: 'mercari',
        item_id: item.id,
        listing_id: listing.id,
        sale_price_cents: 4500,
      })
      .execute();
    const { rows } = await sql<{ id: string }>`
      insert into marketplace_operation
        (account_id, listing_id, kind, idempotency_key, desired, status, origin, created_at,
         updated_at)
      values (${accountId()}, ${listing.id}, 'price', ${randomUUID()}, '{"priceCents":4000}',
        'queued', 'user', ${ago(50)}, ${ago(50)})
      returning id
    `.execute(api.db);
    const operationId = rows[0]?.id ?? '';
    await api.db
      .insertInto('operation_event')
      .values({
        account_id: accountId(),
        operation_id: operationId,
        to_status: 'queued',
        detail: jsonb({}),
        created_at: ago(50),
      })
      .execute();
    await api.db
      .insertInto('automation_run')
      .values({
        account_id: accountId(),
        connection_id: connectionId,
        marketplace: 'mercari',
        purpose: 'operation',
        script: 'price',
        operation_id: operationId,
        host: 'phone',
        started_at: ago(49),
        finished_at: new Date(ago(49).getTime() + 4_200),
        outcome: 'succeeded',
        steps: jsonb([
          { name: 'open the editor', ms: 2_100 },
          { name: 'save the price', ms: 2_100 },
        ]),
      })
      .execute();
    return { itemId: item.id, saleId: sale.id, operationId, checkId: check.id };
  }

  it("serves an item's activity newest first, page by page, and only the owner's", async () => {
    const { itemId } = await soldItem();
    const first = await api.call('listItemActivity', {
      token,
      params: { itemId },
      query: { limit: 2 },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.map((entry) => entry.kind)).toEqual(['sale', 'sale_check']);
    expect(first.body.data[0]).toMatchObject({
      source: 'marketplace',
      outcome: 'info',
      title: 'Sold on Mercari for $45.00 (order order-' + itemId + ')',
      detail: 'Found by a sale check of Mercari on your iPhone.',
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api.call('listItemActivity', {
      token,
      params: { itemId },
      query: { limit: 25, cursor: first.body.nextCursor ?? '' },
    });
    expect(second.body.data.map((entry) => entry.kind)).toEqual(['browser_session', 'operation']);
    expect(second.body.data[0]).toMatchObject({
      source: 'iphone',
      outcome: 'succeeded',
      title: 'Your iPhone changed the price on Mercari',
      durationMs: 4_200,
      steps: [
        { name: 'open the editor', durationMs: 2_100 },
        { name: 'save the price', durationMs: 2_100 },
      ],
    });
    expect(second.body.nextCursor).toBeUndefined();

    const other = await api.call('listItemActivity', {
      token: await api.signIn(OTHER),
      params: { itemId },
    });
    expect(other.status).toBe(404);
    const badCursor = await api.call('listItemActivity', {
      token,
      params: { itemId },
      query: { cursor: 'nope' },
    });
    expect(badCursor.status).toBe(400);
  });

  it("serves one marketplace action's activity", async () => {
    const { operationId } = await soldItem();
    const response = await api.call('listOperationActivity', {
      token,
      params: { operationId },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.map((entry) => [entry.kind, entry.title])).toEqual([
      ['browser_session', 'Your iPhone changed the price on Mercari'],
      ['operation', 'Change the price on Mercari'],
    ]);
    const missing = await api.call('listOperationActivity', {
      token,
      params: { operationId: randomUUID() },
    });
    expect(missing.status).toBe(404);
  });

  it('explains how a sale was found', async () => {
    const { saleId, checkId } = await soldItem();
    const response = await api.call('getSaleExplanation', { token, params: { saleId } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      saleId,
      marketplace: 'mercari',
      detectionSource: 'poll',
      detection: 'Found by a sale check of Mercari on your iPhone.',
      check: { id: checkId, kind: 'scheduled', host: 'phone', ordersSeen: 2, newOrders: 1 },
      delists: [],
    });
    expect(response.body.entries.map((entry) => entry.kind)).toEqual(['sale', 'sale_check']);
    const other = await api.call('getSaleExplanation', {
      token: await api.signIn(OTHER),
      params: { saleId },
    });
    expect(other.status).toBe(404);
  });

  it('keeps failing sale checks off Today, on the connection for support', async () => {
    await mercari('failing');
    const today = await api.call('getToday', { token });
    expect(today.body.cards.map((card) => card.kind)).not.toContain('sale_checks');
    const connections = await api.call('listConnections', { token });
    expect(
      connections.body.data.find((connection) => connection.marketplace === 'mercari')?.saleChecks,
    ).toMatchObject({
      health: 'failing',
      lastError: {
        code: 'element_missing',
        message: "Mercari's sold items page has changed, so Listora couldn't read it.",
      },
    });
  });
});
