/**
 * eBay order sync against the fake eBay and a real Postgres: a confirmation notification and
 * the order poll both record a sale once, start its auto-delist, and schedule the listing's
 * read-back; duplicates change nothing; and an eBay account deletion purges the user's data.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccessTokenResult } from '@listora/connections';
import { createInventoryItem, jsonb, type Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  createEbayAdapter,
  desiredStateForContent,
  EbayOAuthClient,
  FakeEbay,
  loadEbayConfig,
  type AdapterLookup,
  type MarketplaceAdapter,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';
import { createLogger } from '@listora/shared';

import { checkSaleFees, SALE_FEES_TASK } from '../fees.ts';
import { recordInboundEvent } from '../inbound.ts';
import { pollEbayConnectionOrders, scheduleEbayOrderPolls } from './poll.ts';
import { processEbayNotification, type SellerTokens } from './process.ts';
import { purgeEbayUser } from './purge.ts';

const logger = createLogger({ service: 'sales-test', level: 'silent' });
const signal = (): AbortSignal => AbortSignal.timeout(10_000);
const FAKE_SELLER = 'fakeUser1';

describe('eBay order sync', () => {
  let database: MigratedDatabase;
  let db: Db;
  let fake: FakeEbay;
  let adapter: MarketplaceAdapter;
  let accountId: string;
  let connectionId: string;
  let tokenResult: () => Promise<AccessTokenResult>;
  let sequence = 0;

  const tokens: SellerTokens = {
    accessToken: () => tokenResult(),
    invalidate: () => Promise.resolve(),
  };
  const adapters: AdapterLookup = (marketplace) => (marketplace === 'ebay' ? adapter : undefined);
  const deps = () => ({
    db,
    adapters,
    endpoints: { api: fake.url },
    tokens,
    logger,
    timeoutMs: 5_000,
  });

  beforeAll(async () => {
    database = await createMigratedDatabase('sales_ebay', { jobQueue: true });
    db = database.db;
    fake = await FakeEbay.start();
    accountId = await insertAccount(db, 'EB');
    const connection = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'ebay',
        mode: 'api',
        external_user_id: FAKE_SELLER,
        display_name: 'listora_dev_seller',
        token_ciphertext: Buffer.from('sealed'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    connectionId = connection.id;
    const config = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: fake.url,
      EBAY_USER_CONNECTION_ID: connectionId,
    });
    if (config === undefined) throw new Error('no eBay config');
    adapter = createEbayAdapter(config, { requestTimeoutMs: 5_000 });
    const oauth = new EbayOAuthClient({
      tokenUrl: config.endpoints.oauthToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    tokenResult = async () => ({
      type: 'ok',
      accessToken: (await oauth.refreshUserToken(config.seller?.refreshToken ?? '', [], signal()))
        .token,
    });
  });

  afterAll(async () => {
    await fake.close();
    await database.close();
  });

  /** A Listora item listed on the fake eBay; returns its listing row and eBay item id. */
  async function listedItem(): Promise<{ listingId: string; itemId: string; ebayId: string }> {
    sequence += 1;
    const sku = `EB-${String(sequence).padStart(6, '0')}`;
    const content = sampleListingContent();
    const outcome = await adapter.execute(
      {
        operationId: `op-${sku}`,
        kind: 'create',
        idempotencyKey: `key-${sku}`,
        attempt: 1,
        desired: desiredStateForContent('create', content),
        listing: { listingId: sku, externalListingId: null, externalSku: sku, externalUrl: null },
        payload: adapter.buildPayload(content.item, content.variant, {
          id: connectionId,
          mode: 'api',
          status: 'connected',
        }),
      },
      { signal: signal(), connection: { id: connectionId, mode: 'api', status: 'connected' } },
    );
    if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
      throw new Error(JSON.stringify(outcome));
    }
    const item = await createInventoryItem(db, accountId, { title: `Item ${sku}` });
    const listing = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'ebay',
        connection_id: connectionId,
        status: 'active',
        external_listing_id: outcome.externalListingId,
        external_sku: sku,
        remote_snapshot: jsonb({ status: 'active' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { listingId: listing.id, itemId: item.id, ebayId: outcome.externalListingId };
  }

  /** Stores an ORDER_CONFIRMATION as the webhook would, returning its inbound event. */
  async function storeConfirmation(orderId: string, ebayId: string, notificationId?: string) {
    const notification = fake.notification('ORDER_CONFIRMATION', {
      user: { userId: FAKE_SELLER, username: 'listora_dev_seller' },
      order: {
        orderId,
        orderLineItems: [{ orderLineItemId: `${orderId}-1`, listingId: ebayId, quantity: 1 }],
      },
    });
    const payload = JSON.parse(notification.body) as { notification: { notificationId: string } };
    if (notificationId !== undefined) payload.notification.notificationId = notificationId;
    return recordInboundEvent(db, {
      accountId,
      source: 'ebay_webhook',
      marketplace: 'ebay',
      providerEventId: payload.notification.notificationId,
      signatureOk: true,
      payload,
      externalUserId: FAKE_SELLER,
    });
  }

  const jobs = async (task: string) =>
    (
      await sql<{ key: string | null; payload: unknown; queue_name: string | null }>`
        select job.key, job.payload, queue.queue_name
        from graphile_worker._private_jobs as job
        join graphile_worker._private_tasks as t on t.id = job.task_id
        left join graphile_worker._private_job_queues as queue on queue.id = job.job_queue_id
        where t.identifier = ${task}
      `.execute(db)
    ).rows;
  const sales = (orderId: string) =>
    db.selectFrom('sale').selectAll().where('external_order_id', '=', orderId).execute();
  const event = (id: string) =>
    db.selectFrom('inbound_event').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('records a confirmed order once, starts its auto-delist, and reads the listing back', async () => {
    const { listingId, itemId, ebayId } = await listedItem();
    const order = fake.sell(ebayId, { shipping: '4.99' });
    const stored = await storeConfirmation(order.orderId, ebayId);
    expect(stored.duplicate).toBe(false);

    expect(
      await processEbayNotification(deps(), { accountId, inboundEventId: stored.id }, signal()),
    ).toBe('sale_recorded');
    const [sale] = await sales(order.orderId);
    expect(sale).toMatchObject({
      account_id: accountId,
      marketplace: 'ebay',
      detection_source: 'webhook',
      inbound_event_id: stored.id,
      shipping_charged_cents: 499,
      currency: 'USD',
    });
    expect(sale?.ship_by).toBeInstanceOf(Date);
    const items = await db
      .selectFrom('sale_item')
      .selectAll()
      .where('sale_id', '=', sale?.id ?? '')
      .execute();
    expect(items).toMatchObject([
      { item_id: itemId, listing_id: listingId, sale_price_cents: 4500 },
    ]);
    // The same transaction started its auto-delist: nothing else lists the item, so its run is
    // complete at once and the item is sold.
    expect(
      await db
        .selectFrom('delist_run')
        .select(['item_id', 'status'])
        .where('sale_id', '=', sale?.id ?? '')
        .execute(),
    ).toEqual([{ item_id: itemId, status: 'completed' }]);
    expect(
      await db
        .selectFrom('inventory_item')
        .select('status')
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'sold' });
    expect(await jobs('listing_resync')).toContainEqual(
      expect.objectContaining({ queue_name: `listing:${listingId}` }),
    );
    expect(await event(stored.id)).toMatchObject({ result: 'processed' });

    // eBay delivers the same notification again: stored once, nothing new.
    expect(
      (await storeConfirmation(order.orderId, ebayId, (await event(stored.id)).provider_event_id))
        .duplicate,
    ).toBe(true);
    // A second confirmation for the order (payment failed, then cleared) is a duplicate sale.
    const second = await storeConfirmation(order.orderId, ebayId);
    expect(
      await processEbayNotification(deps(), { accountId, inboundEventId: second.id }, signal()),
    ).toBe('sale_duplicate');
    expect(await sales(order.orderId)).toHaveLength(1);
    expect(await event(second.id)).toMatchObject({ result: 'ignored' });
    // Processing a finished event again changes nothing.
    expect(
      await processEbayNotification(deps(), { accountId, inboundEventId: second.id }, signal()),
    ).toBe('already_processed');

    // The poll then sees the order too, and records nothing new.
    const polled = await pollEbayConnectionOrders(deps(), { connectionId }, signal());
    expect(polled.status).toBe('polled');
    expect(await sales(order.orderId)).toHaveLength(1);
    const pollEvent = await db
      .selectFrom('inbound_event')
      .selectAll()
      .where('provider_event_id', '=', `order:${order.orderId}`)
      .executeTakeFirstOrThrow();
    expect(pollEvent).toMatchObject({ source: 'poll', result: 'ignored', signature_ok: null });
    expect(JSON.stringify(pollEvent.payload)).not.toContain('fake_buyer');
  });

  it('the poll records a sale whose notification never came, once', async () => {
    const { ebayId } = await listedItem();
    const order = fake.sell(ebayId);
    const first = await pollEbayConnectionOrders(deps(), { connectionId }, signal());
    expect(first.recorded).toBe(1);
    expect(await sales(order.orderId)).toMatchObject([{ detection_source: 'poll' }]);
    const second = await pollEbayConnectionOrders(deps(), { connectionId }, signal());
    expect(second.recorded).toBe(0);
    expect(await sales(order.orderId)).toHaveLength(1);
    const connection = await db
      .selectFrom('marketplace_connection')
      .select('orders_polled_through')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(connection.orders_polled_through).toBeInstanceOf(Date);

    // A poll that fails part-way keeps its mark and throws, so the queue runs it again.
    fake.inject({ action: 'orders', fault: { type: 'server_error' } });
    await expect(pollEbayConnectionOrders(deps(), { connectionId }, signal())).rejects.toThrow(
      /could not be read/,
    );
    const after = await db
      .selectFrom('marketplace_connection')
      .select('orders_polled_through')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(after.orders_polled_through).toEqual(connection.orders_polled_through);

    expect(await scheduleEbayOrderPolls(db)).toBe(1);
    expect(await jobs('ebay_connection_order_poll')).toEqual([
      expect.objectContaining({ key: `ebay-order-poll:${connectionId}` }),
    ]);
  });

  it("estimates a sale's fees at once, then replaces them with eBay's actual fees", async () => {
    const { ebayId } = await listedItem();
    const order = fake.sell(ebayId, { shipping: '5.0' });
    expect((await pollEbayConnectionOrders(deps(), { connectionId }, signal())).recorded).toBe(1);
    const [sale] = await sales(order.orderId);
    if (sale === undefined) throw new Error('no sale');
    const lines = () =>
      db
        .selectFrom('fee_line')
        .select(['kind', 'amount_cents', 'source', 'description', 'fee_table_version'])
        .where('sale_id', '=', sale.id)
        .orderBy('id')
        .execute();
    // The fake's listing sells at $45.00: eBay's table, on the item price.
    expect(await lines()).toEqual([
      {
        kind: 'marketplace',
        amount_cents: 612,
        source: 'estimated',
        description: 'Final value fee',
        fee_table_version: 'ebay-us-2026-10-24',
      },
      {
        kind: 'marketplace',
        amount_cents: 40,
        source: 'estimated',
        description: 'Per-order fee',
        fee_table_version: 'ebay-us-2026-10-24',
      },
    ]);
    const job = (await jobs(SALE_FEES_TASK)).find((entry) => entry.key === `sale_fees:${sale.id}`);
    expect(job?.payload).toEqual({ accountId, saleId: sale.id, check: '1' });

    // eBay is down for the first check: another follows, and the estimate stays meanwhile.
    fake.inject({ action: 'finances', fault: { type: 'server_error' } });
    const now = new Date('2026-10-25T12:00:00Z');
    const retry = await checkSaleFees(
      { db, adapters, logger, now: () => now },
      { accountId, saleId: sale.id, check: '1' },
      signal(),
    );
    expect(retry).toEqual({
      type: 'rescheduled',
      check: 2,
      runAt: new Date(now.getTime() + 2 * 60_000),
    });
    expect((await lines()).every((line) => line.source === 'estimated')).toBe(true);

    // eBay charges on the total with shipping: 13.6% of $50.00 and the per-order fee.
    expect(
      await checkSaleFees(
        { db, adapters, logger },
        { accountId, saleId: sale.id, check: '2' },
        signal(),
      ),
    ).toEqual({ type: 'recorded', fees: 2 });
    expect(await lines()).toEqual([
      {
        kind: 'marketplace',
        amount_cents: 680,
        source: 'actual',
        description: 'Final value fee',
        fee_table_version: null,
      },
      {
        kind: 'marketplace',
        amount_cents: 40,
        source: 'actual',
        description: 'Per-order fee',
        fee_table_version: null,
      },
    ]);
  });

  it('keeps the estimate after the last check, and when eBay will not report the fees', async () => {
    const { ebayId } = await listedItem();
    const order = fake.sell(ebayId);
    await pollEbayConnectionOrders(deps(), { connectionId }, signal());
    const [sale] = await sales(order.orderId);
    if (sale === undefined) throw new Error('no sale');
    fake.inject({ action: 'finances', fault: { type: 'server_error' } });
    expect(
      await checkSaleFees(
        { db, adapters, logger },
        { accountId, saleId: sale.id, check: '6' },
        signal(),
      ),
    ).toMatchObject({ type: 'kept_estimate' });
    fake.inject({ action: 'finances', fault: { type: 'unauthorized' }, times: 2 });
    expect(
      await checkSaleFees(
        { db, adapters, logger },
        { accountId, saleId: sale.id, check: '1' },
        signal(),
      ),
    ).toEqual({ type: 'kept_estimate', reason: 'no_finances_access' });
    const sources = await db
      .selectFrom('fee_line')
      .select('source')
      .where('sale_id', '=', sale.id)
      .execute();
    expect(sources.map((line) => line.source)).toEqual(['estimated', 'estimated']);
  });

  it('ignores an order with no Listora listing, and fails one it cannot read for reconnect', async () => {
    const { ebayId } = await listedItem();
    await db.deleteFrom('marketplace_listing').where('external_listing_id', '=', ebayId).execute();
    const order = fake.sell(ebayId);
    const unknown = await storeConfirmation(order.orderId, ebayId);
    expect(
      await processEbayNotification(deps(), { accountId, inboundEventId: unknown.id }, signal()),
    ).toBe('not_listora');
    expect(await sales(order.orderId)).toEqual([]);

    const other = await listedItem();
    const sold = fake.sell(other.ebayId);
    const stored = await storeConfirmation(sold.orderId, other.ebayId);
    const working = tokenResult;
    tokenResult = async () => ({ type: 'reauth_required', code: 'invalid_grant', message: 'x' });
    try {
      expect(
        await processEbayNotification(deps(), { accountId, inboundEventId: stored.id }, signal()),
      ).toBe('reauth_required');
    } finally {
      tokenResult = working;
    }
    expect(await event(stored.id)).toMatchObject({
      result: 'failed',
      error_message: expect.stringContaining('Reconnect eBay') as string,
    });
  });

  it("deletes everything about an eBay user who deleted their account, and nobody else's", async () => {
    const other = await insertAccount(db, 'OT');
    const insertConnection = (account: string, user: string) =>
      db
        .insertInto('marketplace_connection')
        .values({
          account_id: account,
          marketplace: 'ebay',
          mode: 'api',
          external_user_id: user,
          display_name: user,
          token_ciphertext: Buffer.from('sealed'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const deleted = await insertConnection(other, 'deletedUser');
    const kept = await insertConnection(await insertAccount(db, 'KP'), 'keptUser');
    const item = await createInventoryItem(db, other, { title: 'Kept item' });
    const listing = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: other,
        item_id: item.id,
        marketplace: 'ebay',
        connection_id: deleted.id,
        status: 'active',
        external_listing_id: '119999999999',
        remote_snapshot: jsonb({ status: 'active', title: 'x' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [account, user] of [
      [other, 'deletedUser'],
      [other, 'keptUser'],
    ] as const) {
      await recordInboundEvent(db, {
        accountId: account,
        source: 'ebay_webhook',
        marketplace: 'ebay',
        providerEventId: `n-${user}`,
        signatureOk: true,
        payload: { user },
        externalUserId: user,
      });
    }

    expect(await purgeEbayUser({ db, logger }, { ebayUserId: 'deletedUser' })).toEqual({
      connections: 1,
      listings: 1,
      inboundEvents: 1,
    });
    expect(
      await db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('id', '=', deleted.id)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('marketplace_listing')
        .select(['connection_id', 'remote_snapshot', 'item_id'])
        .where('id', '=', listing.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ connection_id: null, remote_snapshot: null, item_id: item.id });
    expect(
      await db
        .selectFrom('inbound_event')
        .select('external_user_id')
        .where('account_id', '=', other)
        .execute(),
    ).toEqual([{ external_user_id: 'keptUser' }]);
    expect(
      await db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('id', '=', kept.id)
        .execute(),
    ).toHaveLength(1);
    // The completion record has the counts and nothing that names the eBay user.
    const records = await db
      .selectFrom('deletion_record')
      .selectAll()
      .where('kind', '=', 'ebay_user')
      .execute();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      reason: 'marketplace_account_deletion',
      marketplace: 'ebay',
      summary: { connections: 1, listings: 1, inboundEvents: 1, verified: { rows: 0 } },
    });
    expect(JSON.stringify(records)).not.toContain('deletedUser');
    // A repeat finds nothing.
    expect(await purgeEbayUser({ db, logger }, { ebayUserId: 'deletedUser' })).toEqual({
      connections: 0,
      listings: 0,
      inboundEvents: 0,
    });
  });
});
