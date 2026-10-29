/**
 * Sale checks end to end on real Postgres, headless Chromium, and the fake site: linking
 * schedules the first check, a check records each order once and schedules the next from the
 * seller's history, a relink after an unlink reads the whole sales history again, a check that
 * meets a CAPTCHA waits for the relink, a forwarded email asks for a check at once, and the
 * worker's dispatcher queues due checks and starts the runner.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createInventoryItem, inTransaction, jsonb } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  ConnectionAwareAdapter,
  useMarketplaceFeatures,
  type AdapterLookup,
} from '@listora/marketplaces';
import { LocalTokenVault, SessionVault, startConnectionDeletion } from '@listora/connections';

import { RunnerSessions } from '../adapter/runner-sessions.ts';
import { AutomationDispatcher } from '../dispatch.ts';
import { assistedAdapter, createFakeSiteAdapter } from '../fake-site/fake-site-adapter.ts';
import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import { openRunnerPresence, type RunnerLauncher } from '../launcher.ts';
import { linkAutomationSession } from '../link.ts';
import type { AutomationProfile } from '../profiles.ts';
import { fakeSiteProfile, silentLogger, stubPhotos, testRunner } from '../test-support.ts';
import { PUSH_TASK } from '@listora/push';

import { runReadAlerts, type OwnerEmail } from '../read-health/health.ts';
import { runSaleCheckHealth } from './health.ts';
import { runSaleCheck } from './job.ts';
import {
  recordSaleOrder,
  SALE_ORDER_TASK,
  type SaleOrderJobPayload,
  type SoldItemMaker,
  type SoldItemSource,
} from './orders.ts';
import {
  dueSaleChecks,
  requestSaleCheck,
  requestSaleHistoryRead,
  saleCheckJobKey,
} from './schedule.ts';

const HOUR = 3_600_000;
const SETTINGS = {
  defaultIntervalMs: 12 * HOUR,
  minIntervalMs: 2 * HOUR,
  maxIntervalMs: 24 * HOUR,
  alertAfterFailures: 2,
  overdueMs: 6 * HOUR,
};

describe('sale checks (real Postgres, headless Chromium)', () => {
  let database: MigratedDatabase;
  let site: FakeAutomationSite;
  let profile: AutomationProfile;
  let adapters: AdapterLookup;
  let accountId: string;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  const { runner } = testRunner({ stepTimeoutMs: 3_000 });

  beforeAll(async () => {
    database = await createMigratedDatabase('sale_checks', { jobQueue: true, max: 8 });
    site = await FakeAutomationSite.start();
    profile = fakeSiteProfile(site);
    const sessions = new RunnerSessions({
      db: database.db,
      vault,
      runner,
      profile: (marketplace) => (marketplace === 'mercari' ? profile : undefined),
      logger: silentLogger,
    });
    const mercari = new ConnectionAwareAdapter({
      assisted: assistedAdapter('mercari'),
      automation: createFakeSiteAdapter({
        marketplace: 'mercari',
        siteUrl: site.url,
        profile,
        sessions,
        photos: stubPhotos,
        logger: silentLogger,
      }),
    });
    adapters = (marketplace) => (marketplace === 'mercari' ? mercari : undefined);
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
    await database.close();
  });

  beforeEach(async () => {
    site.clearFaults();
    accountId = await insertAccount(database.db);
  });

  const link = () =>
    linkAutomationSession(
      database.db,
      { vault, profile },
      // These are the cloud runner's checks; phone-work.int.test.ts runs them on the phone.
      {
        accountId,
        marketplace: 'mercari',
        cookies: [site.issueSession(accountId)],
        runsOn: 'cloud',
      },
    );

  const schedule = (connectionId: string) =>
    database.db
      .selectFrom('sale_check_schedule')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();

  const jobs = async (connectionId: string) => {
    const { rows } = await sql<{ task_identifier: string }>`
      select task_identifier from graphile_worker.jobs where key = ${saleCheckJobKey(connectionId)}
    `.execute(database.db);
    return rows.map((row) => row.task_identifier);
  };

  const clearJobs = () => sql`delete from graphile_worker._private_jobs`.execute(database.db);

  const check = (connectionId: string, history = false) =>
    runSaleCheck(
      { db: database.db, adapters, settings: SETTINGS, logger: silentLogger },
      { accountId, connectionId, ...(history ? { history: true } : {}) },
      new AbortController().signal,
    );

  /** The connection's recorded checks, oldest first. */
  const checks = (connectionId: string) =>
    database.db
      .selectFrom('sale_check_run')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .orderBy('started_at')
      .execute();

  /** The account's queued push notifications' payloads. */
  const pushes = async () => {
    const { rows } = await sql<{ payload: { accountId: string; title: string; body: string } }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${PUSH_TASK})
    `.execute(database.db);
    return rows.map((row) => row.payload).filter((push) => push.accountId === accountId);
  };

  const events = () =>
    database.db
      .selectFrom('inbound_event')
      .select(['source', 'marketplace', 'provider_event_id', 'payload', 'result'])
      .where('account_id', '=', accountId)
      .orderBy('provider_event_id')
      .execute();

  /** `count` of the seller's listings sold on the fake site, the newest an hour ago. */
  function soldOnSite(count: number): string[] {
    return Array.from({ length: count }, (_, index) => {
      const id = site.seed({
        seller: accountId,
        sku: `SKU-${accountId}-${String(index)}`,
        title: 'Sold jacket',
        description: 'Blue.',
        priceCents: 3000,
      });
      return site.sell(id, new Date(Date.now() - (index + 1) * HOUR)).id;
    });
  }

  it('schedules a check at once when a marketplace is linked, and moves its listings to automation', async () => {
    const item = await createInventoryItem(database.db, accountId, { title: 'Jacket' });
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace: 'mercari' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const other = await database.db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace: 'poshmark' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const { connectionId } = await link();
    expect(await schedule(connectionId)).toMatchObject({
      marketplace: 'mercari',
      next_reason: 'linked',
      last_outcome: null,
    });
    expect((await schedule(connectionId)).next_check_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await jobs(connectionId)).toEqual(['automation_sale_check']);
    const connections = await database.db
      .selectFrom('marketplace_listing')
      .select(['id', 'connection_id'])
      .where('id', 'in', [listing.id, other.id])
      .execute();
    expect(Object.fromEntries(connections.map((row) => [row.id, row.connection_id]))).toEqual({
      [listing.id]: connectionId,
      [other.id]: null,
    });
    await clearJobs();
  });

  /** Ends the connection's sales history a day ago: the sales the site shows came after it. */
  /** Records every order the checks handed over (the sale intake's jobs), then clears them. */
  const recordOrders = async (maker?: SoldItemMaker<SoldItemSource>) => {
    const { rows } = await sql<{ payload: SaleOrderJobPayload }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${SALE_ORDER_TASK})
    `.execute(database.db);
    for (const { payload } of rows) {
      await recordSaleOrder(
        {
          db: database.db,
          adapters,
          logger: silentLogger,
          ...(maker ? { soldItems: maker } : {}),
        },
        payload,
      );
    }
    await clearJobs();
  };

  const connectedSinceYesterday = (connectionId: string) =>
    database.db
      .updateTable('sale_check_schedule')
      .set({ history_until: new Date(Date.now() - 24 * HOUR) })
      .where('connection_id', '=', connectionId)
      .execute();

  it('records each new order once for the sale intake and schedules the next check', async () => {
    const { connectionId } = await link();
    await connectedSinceYesterday(connectionId);
    // The first order sold a listing Listora made; the second one Listora knows nothing of.
    const ours = site.seed({
      seller: accountId,
      sku: `SKU-${accountId}-ours`,
      title: 'Sold jacket',
      description: 'Blue.',
      priceCents: 3000,
    });
    const orders = [site.sell(ours, new Date(Date.now() - 2 * HOUR)).id, ...soldOnSite(1)];
    const item = await createInventoryItem(database.db, accountId, { title: 'Sold jacket' });
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'mercari',
        connection_id: connectionId,
        external_listing_id: ours,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await check(connectionId);
    await check(connectionId);
    // Each new order is stored once, pending, with the worker's job that records its sale.
    expect(await events()).toEqual(
      [...orders].sort().map((id) => ({
        source: 'poll',
        marketplace: 'mercari',
        provider_event_id: `order:${id}`,
        payload: expect.objectContaining({ connectionId, externalOrderId: id }) as unknown,
        result: null,
      })),
    );
    const { rows: queued } = await sql<{ payload: SaleOrderJobPayload }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${SALE_ORDER_TASK})
    `.execute(database.db);
    expect(queued).toHaveLength(2);

    // The worker's side, run twice: the second run changes nothing.
    for (let run = 0; run < 2; run += 1) {
      for (const { payload } of queued) {
        await recordSaleOrder({ db: database.db, adapters, logger: silentLogger }, payload);
      }
    }
    expect((await events()).map((event) => [event.provider_event_id, event.result])).toEqual(
      [...orders].sort().map((id) => [`order:${id}`, id === orders[0] ? 'processed' : 'ignored']),
    );
    // One sale, for Listora's listing, and its auto-delist started.
    const sales = await database.db
      .selectFrom('sale')
      .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
      .select([
        'sale.id',
        'sale.external_order_id',
        'sale.detection_source',
        'sale_item.listing_id',
      ])
      .where('sale.account_id', '=', accountId)
      .execute();
    expect(sales).toEqual([
      {
        id: expect.any(String) as unknown,
        external_order_id: orders[0],
        detection_source: 'poll',
        listing_id: listing.id,
      },
    ]);
    const runs = await database.db
      .selectFrom('delist_run')
      .select('item_id')
      .where('account_id', '=', accountId)
      .execute();
    expect(runs).toEqual([{ item_id: item.id }]);
    // Each check is recorded: where it ran, what it read, and what it handed over.
    const recorded = await checks(connectionId);
    expect(recorded).toMatchObject([
      {
        kind: 'scheduled',
        reason: 'linked',
        host: 'runner',
        outcome: 'succeeded',
        since: null,
        orders_seen: 2,
        items_seen: 2,
        new_orders: 2,
        error_code: null,
      },
      { kind: 'scheduled', host: 'runner', outcome: 'succeeded', orders_seen: 2, new_orders: 0 },
    ]);
    expect(recorded[1]?.since).toBeInstanceOf(Date);
    expect(recorded[0]?.orders).toEqual(
      expect.arrayContaining([
        {
          orderId: orders[0],
          soldAt: expect.any(String) as unknown,
          // The fake site's sold orders show no title.
          items: [{ listingId: ours, title: null, priceCents: 3000 }],
        },
      ]),
    );
    // The browser session that read them, with its steps and their times.
    const session = await database.db
      .selectFrom('automation_run')
      .select(['purpose', 'steps'])
      .where('id', '=', recorded[0]?.automation_run_id ?? '')
      .executeTakeFirstOrThrow();
    expect(session.purpose).toBe('sale_check');
    expect(session.steps?.length).toBeGreaterThan(0);
    for (const step of session.steps ?? []) {
      expect(step).toEqual({
        name: expect.any(String) as unknown,
        ms: expect.any(Number) as unknown,
      });
    }
    // The sale names the check that saw it.
    const seenBy = await database.db
      .selectFrom('sale')
      .select('sale_check_run_id')
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(seenBy.sale_check_run_id).toBe(recorded[0]?.id);
    const row = await schedule(connectionId);
    expect(row).toMatchObject({
      last_outcome: 'succeeded',
      next_reason: 'scheduled',
      health: 'healthy',
      failures_in_a_row: 0,
    });
    expect(row.last_succeeded_at).toBeInstanceOf(Date);
    // Too little history to adapt: the default 12 hours.
    const delay = row.next_check_at.getTime() - (row.last_finished_at?.getTime() ?? 0);
    expect(Math.abs(delay - 12 * HOUR)).toBeLessThan(60_000);
    expect(row.checked_through).toBeInstanceOf(Date);
    await clearJobs();
  });

  it('records the sales history: every sale shown, a sold item each, once; a dropped order again', async () => {
    const { connectionId } = await link();
    await connectedSinceYesterday(connectionId);
    // A sale from before Listora was connected, and one since, of listings Listora doesn't have.
    const before = site.sell(
      site.seed({
        seller: accountId,
        sku: `SKU-${accountId}-old`,
        title: 'Old jacket',
        description: 'Red.',
        priceCents: 2000,
      }),
      new Date(Date.now() - 3 * 24 * HOUR),
    ).id;
    const since = soldOnSite(1)[0] ?? '';
    // Before sold items: the first check dropped both orders.
    await check(connectionId);
    await recordOrders();
    expect((await events()).map((event) => [event.provider_event_id, event.result])).toEqual(
      [before, since].sort().map((id) => [`order:${id}`, 'ignored']),
    );

    // The next check reads the whole history again (the migration's reset) and hands each
    // dropped order over once more; a later full read hands nothing over twice.
    const made: SoldItemSource[] = [];
    const maker: SoldItemMaker<SoldItemSource> = {
      prepare: (source) => Promise.resolve(source),
      create: async (trx, source) => {
        made.push(source);
        const item = await createInventoryItem(trx, source.accountId, { title: 'Sold jacket' });
        return { itemId: item.id, listingId: null };
      },
    };
    for (let read = 0; read < 2; read += 1) {
      await database.db
        .updateTable('sale_check_schedule')
        .set({ checked_through: null })
        .where('connection_id', '=', connectionId)
        .execute();
      await check(connectionId);
      await recordOrders(maker);
    }
    expect((await events()).map((event) => [event.provider_event_id, event.result])).toEqual(
      [
        ...[before, since].map((id) => [`history:order:${id}`, 'processed']),
        ...[before, since].map((id) => [`order:${id}`, 'ignored']),
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({ accountId, connectionId, marketplace: 'mercari' });
    // Each a sale of its own sold item: the one from before Listora was connected found in the
    // sales history, never one to ship; nothing else to delist.
    const sales = await database.db
      .selectFrom('sale')
      .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
      .innerJoin('inventory_item as item', 'item.id', 'sale_item.item_id')
      .select([
        'sale.external_order_id',
        'sale.detection_source',
        'sale.status',
        'item.status as item',
      ])
      .where('sale.account_id', '=', accountId)
      .orderBy('sale.sold_at')
      .execute();
    expect(sales).toEqual([
      { external_order_id: before, detection_source: 'history', status: 'detected', item: 'sold' },
      { external_order_id: since, detection_source: 'poll', status: 'detected', item: 'sold' },
    ]);
    expect(await pushes()).toEqual([]);
  });

  it('reads the whole sales history again after an unlink and a relink, and records it anew', async () => {
    // Sold items made as @listora/imports makes them: items only the marketplace brought in.
    const maker: SoldItemMaker<SoldItemSource> = {
      prepare: (source) => Promise.resolve(source),
      create: async (trx, source) => {
        const item = await createInventoryItem(trx, source.accountId, { title: 'Sold jacket' });
        await trx
          .insertInto('audit_log')
          .values({
            account_id: source.accountId,
            item_id: item.id,
            actor_kind: 'marketplace',
            action: 'item.imported',
            changes: jsonb({ marketplace: source.marketplace, sold: true }),
          })
          .execute();
        return { itemId: item.id, listingId: null };
      },
    };
    const sales = () =>
      database.db
        .selectFrom('sale')
        .select(['external_order_id', 'detection_source'])
        .where('account_id', '=', accountId)
        .orderBy('external_order_id')
        .execute();
    const first = await link();
    const sold = soldOnSite(2).sort();
    await check(first.connectionId);
    await recordOrders(maker);
    expect((await sales()).map((sale) => sale.external_order_id)).toEqual(sold);

    await inTransaction(database.db, (trx) =>
      startConnectionDeletion(trx, {
        accountId,
        connectionId: first.connectionId,
        reason: 'unlinked',
      }),
    );
    expect(await sales()).toEqual([]);
    expect(await events()).toEqual([]);
    const items = await database.db
      .selectFrom('inventory_item')
      .select('id')
      .where('account_id', '=', accountId)
      .execute();
    expect(items).toEqual([]);

    // The relink is a new connection: its first check reads the whole history, as a first
    // link's does, and every sale is recorded again, found in the sales history.
    const relinked = await link();
    expect(relinked.connectionId).not.toBe(first.connectionId);
    expect(await schedule(relinked.connectionId)).toMatchObject({
      next_reason: 'linked',
      checked_through: null,
    });
    await check(relinked.connectionId);
    await recordOrders(maker);
    expect(await sales()).toEqual(
      sold.map((id) => ({ external_order_id: id, detection_source: 'history' })),
    );
  });

  it("records a sale of Listora's own listing from before the history ends only: no delist, no alert", async () => {
    const { connectionId } = await link();
    // Listora's listing, also live on Poshmark, sold on the marketplace before it was linked.
    const ours = site.seed({
      seller: accountId,
      sku: `SKU-${accountId}-history`,
      title: 'Sold jacket',
      description: 'Blue.',
      priceCents: 3000,
    });
    const order = site.sell(ours, new Date(Date.now() - 2 * HOUR)).id;
    const item = await createInventoryItem(database.db, accountId, {
      title: 'Sold jacket',
      status: 'listed',
    });
    for (const marketplace of ['mercari', 'poshmark'] as const) {
      await database.db
        .insertInto('marketplace_listing')
        .values({
          account_id: accountId,
          item_id: item.id,
          marketplace,
          status: 'active',
          ...(marketplace === 'mercari'
            ? { connection_id: connectionId, external_listing_id: ours }
            : { external_listing_id: `posh-${accountId}` }),
        })
        .execute();
    }
    await check(connectionId);
    const { rows } = await sql<{ payload: SaleOrderJobPayload }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${SALE_ORDER_TASK})
    `.execute(database.db);
    for (const { payload } of rows) {
      await recordSaleOrder({ db: database.db, adapters, logger: silentLogger }, payload);
    }
    await clearJobs();
    // The sale, from the sales history: recorded, its item sold, and nothing else.
    const sales = await database.db
      .selectFrom('sale')
      .select(['external_order_id', 'detection_source'])
      .where('account_id', '=', accountId)
      .execute();
    expect(sales).toEqual([{ external_order_id: order, detection_source: 'history' }]);
    const sold = await database.db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(sold.status).toBe('sold');
    const acted = await Promise.all(
      (['delist_run', 'marketplace_operation', 'user_task'] as const).map((table) =>
        database.db.selectFrom(table).select('id').where('account_id', '=', accountId).execute(),
      ),
    );
    expect(acted).toEqual([[], [], []]);
    expect(await pushes()).toEqual([]);
    // The Poshmark listing is left as it was.
    const posh = await database.db
      .selectFrom('marketplace_listing')
      .select('status')
      .where('external_listing_id', '=', `posh-${accountId}`)
      .executeTakeFirstOrThrow();
    expect(posh.status).toBe('active');
  });

  it("records why a check failed; checks failing in a row are the owner's, never the seller's", async () => {
    const { connectionId } = await link();
    site.inject({ action: 'orders', fault: { type: 'server_error' }, times: 2 });

    await check(connectionId);
    expect(await schedule(connectionId)).toMatchObject({
      last_outcome: 'failed',
      next_reason: 'retry',
      failures_in_a_row: 1,
      last_error_code: 'server_error',
      last_error_message: 'Mercari had a problem showing your sales.',
      // One failure is not a problem yet.
      health: 'healthy',
    });
    await check(connectionId);
    const failing = await schedule(connectionId);
    expect(failing).toMatchObject({ failures_in_a_row: 2, health: 'failing', alerted_at: null });
    expect(failing.unhealthy_since).toBeInstanceOf(Date);
    expect(await checks(connectionId)).toMatchObject([
      { outcome: 'failed', error_code: 'server_error', orders_seen: null },
      { outcome: 'failed', error_code: 'server_error' },
    ]);

    const health = { db: database.db, settings: SETTINGS, logger: silentLogger };
    // Nothing the seller can do: the owner's alarm and the support views have it, not a push.
    expect(await runSaleCheckHealth(health)).toMatchObject({ alerted: 0 });
    expect(await pushes()).toEqual([]);
    expect((await schedule(connectionId)).alerted_at).toBeInstanceOf(Date);

    // A check that works ends the problem.
    await check(connectionId);
    expect(await schedule(connectionId)).toMatchObject({
      health: 'healthy',
      failures_in_a_row: 0,
      unhealthy_since: null,
      alerted_at: null,
      last_error_code: null,
    });
    await clearJobs();
  });

  it("emails the owner at the third failure in a row, with the step and the reader's words", async () => {
    const { connectionId } = await link();
    site.inject({ action: 'orders', fault: { type: 'server_error' }, times: 3 });
    const sent: OwnerEmail[] = [];
    const alerts = () =>
      runReadAlerts({
        db: database.db,
        settings: { alertAfterFailures: 3, noSuccessMs: 24 * HOUR },
        mailer: {
          send: (email) => {
            sent.push(email);
            return Promise.resolve();
          },
        },
        environment: 'test',
        logger: silentLogger,
      });
    const read = () =>
      database.db
        .selectFrom('background_read_health')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('connection_id', '=', connectionId)
        .executeTakeFirstOrThrow();

    await check(connectionId);
    await check(connectionId);
    expect(await alerts()).toEqual({ alerted: 0, failed: 0 });
    await check(connectionId);
    expect(await read()).toMatchObject({
      read: 'sale_check',
      marketplace: 'mercari',
      failures_in_a_row: 3,
      last_error_code: 'server_error',
      last_succeeded_at: null,
      owner_alerted_at: null,
    });
    expect(await alerts()).toEqual({ alerted: 1, failed: 0 });
    const [email] = sent;
    expect(email?.subject).toBe('[Listora test] Mercari sale check failed 3 times in a row');
    const { last_error_step: step, last_error_detail: detail } = await read();
    expect(step).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(email?.text).toContain(`Step: ${String(step)}`);
    expect(email?.text).toContain('Last error: server_error');
    expect(email?.text).toContain(`Reader's words: ${String(detail)}`);
    expect(email?.text).toContain('Last worked: never');
    // Once per run of failures.
    expect(await alerts()).toEqual({ alerted: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(await pushes()).toEqual([]);

    // A check that works ends the run.
    await check(connectionId);
    const recovered = await read();
    expect(recovered).toMatchObject({
      failures_in_a_row: 0,
      failing_since: null,
      owner_alerted_at: null,
    });
    expect(recovered.last_succeeded_at).toBeInstanceOf(Date);
    await clearJobs();
  });

  it('calls a check overdue when it has not run long past due, and asks only a phone to open Listora', async () => {
    const { connectionId } = await link();
    const health = { db: database.db, settings: SETTINGS, logger: silentLogger };
    // Due now: within the grace.
    expect(await runSaleCheckHealth(health)).toMatchObject({ alerted: 0 });
    expect((await schedule(connectionId)).health).toBe('healthy');
    await sql`update sale_check_schedule set next_check_at = now() - interval '7 hours'
      where connection_id = ${connectionId}`.execute(database.db);
    await runSaleCheckHealth(health);
    expect(await schedule(connectionId)).toMatchObject({ health: 'overdue' });
    // Overdue in Listora's cloud is Listora's to fix: the seller is told nothing.
    expect(await pushes()).toEqual([]);
    // Overdue on the seller's iPhone means Listora has not been opened there: ask, once.
    await sql`update marketplace_connection set runs_on = 'phone' where id = ${connectionId}`.execute(
      database.db,
    );
    await sql`update sale_check_schedule set alerted_at = null where connection_id = ${connectionId}`.execute(
      database.db,
    );
    expect(await runSaleCheckHealth(health)).toMatchObject({ alerted: 1 });
    expect(await pushes()).toEqual([
      expect.objectContaining({ title: 'Open Listora to keep Mercari in sync' }),
    ]);
    expect(await runSaleCheckHealth(health)).toMatchObject({ alerted: 0 });
    // A connection only the seller can fix has its own reconnect card: no second alarm.
    await sql`update marketplace_connection set status = 'reauth_required', token_ciphertext = null
      where id = ${connectionId}`.execute(database.db);
    await sql`update sale_check_schedule set alerted_at = null where connection_id = ${connectionId}`.execute(
      database.db,
    );
    expect(await runSaleCheckHealth(health)).toMatchObject({ alerted: 0 });
    await clearJobs();
  });

  it('never checks, calls overdue, or pushes about sales on a marketplace whose checks never passed live', async () => {
    const { id: connectionId } = await database.db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'poshmark',
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        runs_on: 'phone',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Scheduled before Poshmark's checks were hidden, and long past due.
    await database.db
      .insertInto('sale_check_schedule')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace: 'poshmark',
        next_check_at: new Date(Date.now() - 7 * HOUR),
        next_reason: 'linked',
      })
      .execute();
    useMarketplaceFeatures('verified');
    try {
      expect(await requestSaleCheck(database.db, { accountId, marketplace: 'poshmark' })).toBe(
        false,
      );
      expect((await dueSaleChecks(database.db)).map((due) => due.connectionId)).not.toContain(
        connectionId,
      );
      const health = { db: database.db, settings: SETTINGS, logger: silentLogger };
      expect(await runSaleCheckHealth(health)).toMatchObject({ alerted: 0 });
    } finally {
      useMarketplaceFeatures('all');
    }
    expect((await schedule(connectionId)).health).toBe('healthy');
    expect(await pushes()).toEqual([]);
    const work = await database.db
      .selectFrom('phone_work')
      .select('purpose')
      .where('account_id', '=', accountId)
      .execute();
    expect(work).toEqual([]);
  });

  it('reads the sold history read-only: records every sold order and hands none over', async () => {
    const { connectionId } = await link();
    // A sold listing Listora knows: a sale check would record its sale and start its delist.
    const ours = site.seed({
      seller: accountId,
      sku: `SKU-${accountId}-ours`,
      title: 'Sold jacket',
      description: 'Blue.',
      priceCents: 3000,
    });
    site.sell(ours, new Date(Date.now() - 2 * HOUR));
    soldOnSite(2);
    const item = await createInventoryItem(database.db, accountId, { title: 'Sold jacket' });
    await database.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'mercari',
        connection_id: connectionId,
        external_listing_id: ours,
        status: 'active',
      })
      .execute();
    await clearJobs();
    const before = await schedule(connectionId);

    const requested = await requestSaleHistoryRead(database.db, {
      accountId,
      marketplace: 'mercari',
    });
    expect(requested).toMatchObject({ connectionId, runsOn: 'cloud', queued: true });
    const { rows } = await sql<{ payload: unknown }>`
      select payload from graphile_worker._private_jobs where key = ${saleCheckJobKey(connectionId, 'history')}
    `.execute(database.db);
    expect(rows).toEqual([{ payload: { accountId, connectionId, history: true } }]);
    await check(connectionId, true);

    expect(await checks(connectionId)).toMatchObject([
      {
        kind: 'history',
        reason: null,
        host: 'runner',
        outcome: 'succeeded',
        orders_seen: 3,
        new_orders: 0,
      },
    ]);
    const [read] = await checks(connectionId);
    expect(read?.orders).toHaveLength(3);
    // Nothing handed over, nothing changed: no order, no sale, no delist, the schedule as it was.
    expect(await events()).toEqual([]);
    const sales = await database.db
      .selectFrom('sale')
      .select('id')
      .where('account_id', '=', accountId)
      .execute();
    expect(sales).toEqual([]);
    const after = await schedule(connectionId);
    expect(after).toEqual({ ...before, updated_at: after.updated_at });
    const listed = await database.db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(listed.status).toBe(item.status);
    await clearJobs();
  });

  it('checks sooner when the seller has been selling a lot lately', async () => {
    const { connectionId } = await link();
    for (let sale = 0; sale < 12; sale += 1) {
      await database.db
        .insertInto('sale')
        .values({
          account_id: accountId,
          marketplace: 'mercari',
          external_order_id: `hist-${String(sale)}`,
          sold_at: new Date(Date.now() - (sale < 8 ? sale * 4 + 1 : 24 * 20 + sale) * HOUR),
          detection_source: 'poll',
        })
        .execute();
    }
    await check(connectionId);
    const row = await schedule(connectionId);
    const delay = row.next_check_at.getTime() - (row.last_finished_at?.getTime() ?? 0);
    expect(delay).toBeLessThan(12 * HOUR);
    expect(delay).toBeGreaterThanOrEqual(2 * HOUR - 60_000);
    await clearJobs();
  });

  it('waits for the relink after a check met a CAPTCHA', async () => {
    const { connectionId } = await link();
    site.inject({ action: 'orders', fault: { type: 'captcha' } });
    await check(connectionId);
    expect(await schedule(connectionId)).toMatchObject({ last_outcome: 'challenge' });
    const connection = await database.db
      .selectFrom('marketplace_connection')
      .select('status')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(connection.status).toBe('reauth_required');
    await sql`update sale_check_schedule set next_check_at = now() - interval '1 minute'`.execute(
      database.db,
    );
    expect((await dueSaleChecks(database.db)).map((due) => due.connectionId)).not.toContain(
      connectionId,
    );
    // The seller logs in again: checked at once.
    await clearJobs();
    await link();
    expect((await dueSaleChecks(database.db)).map((due) => due.connectionId)).toContain(
      connectionId,
    );
    expect(await schedule(connectionId)).toMatchObject({ next_reason: 'linked' });
    await clearJobs();
  });

  it('checks at once when a forwarded email says something sold', async () => {
    expect(await requestSaleCheck(database.db, { accountId, marketplace: 'mercari' })).toBe(false);
    const { connectionId } = await link();
    await check(connectionId);
    await clearJobs();
    expect(await requestSaleCheck(database.db, { accountId, marketplace: 'mercari' })).toBe(true);
    expect(await schedule(connectionId)).toMatchObject({ next_reason: 'email' });
    expect(await jobs(connectionId)).toEqual(['automation_sale_check']);
    // A second email while that check waits adds no second job.
    expect(await requestSaleCheck(database.db, { accountId, marketplace: 'mercari' })).toBe(true);
    expect(await jobs(connectionId)).toHaveLength(1);
    await clearJobs();
  });

  it('queues due checks, starts the runner only when none is alive, and prunes old runs', async () => {
    const { connectionId } = await link();
    await clearJobs();
    let starts = 0;
    const launcher: RunnerLauncher = {
      kind: 'none',
      ensureRunning: () => {
        starts += 1;
        return Promise.resolve();
      },
    };
    const deleted: string[] = [];
    const dispatcher = new AutomationDispatcher({
      db: database.db,
      launcher,
      storage: { delete: (key: string) => Promise.resolve(void deleted.push(key)) } as never,
      logger: silentLogger,
      adapters,
      deferUnsupportedMs: SETTINGS.maxIntervalMs,
    });
    // Poshmark has no adapter here that reads orders: its check is put off, not queued.
    const poshmark = await linkAutomationSession(
      database.db,
      { vault, profile: { ...profile, marketplace: 'poshmark' } },
      {
        accountId,
        marketplace: 'poshmark',
        cookies: [site.issueSession(accountId)],
        runsOn: 'cloud',
      },
    );
    await sql`delete from graphile_worker._private_jobs where key = ${saleCheckJobKey(poshmark.connectionId)}`.execute(
      database.db,
    );
    const old = await database.db
      .insertInto('automation_run')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace: 'mercari',
        purpose: 'health',
        script: 'old',
        started_at: new Date(Date.now() - 20 * 24 * HOUR),
        finished_at: new Date(Date.now() - 20 * 24 * HOUR),
        outcome: 'failed',
        screenshot_key: `automation/${accountId}/old.png`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await dispatcher.dispatch();
    expect(await jobs(connectionId)).toEqual(['automation_sale_check']);
    expect(starts).toBe(1);
    expect(await jobs(poshmark.connectionId)).toEqual([]);
    const deferred = await schedule(poshmark.connectionId);
    expect(deferred.next_reason).toBe('retry');
    expect(deferred.next_check_at.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(deleted).toEqual([`automation/${accountId}/old.png`]);
    const pruned = await database.db
      .selectFrom('automation_run')
      .select('screenshot_key')
      .where('id', '=', old.id)
      .executeTakeFirstOrThrow();
    expect(pruned.screenshot_key).toBeNull();

    const presence = await openRunnerPresence(database.scratch.url, () => undefined);
    try {
      await dispatcher.dispatch();
      expect(starts).toBe(1);
    } finally {
      await presence.close();
    }
    await clearJobs();
  });
});
