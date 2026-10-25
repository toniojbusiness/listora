/**
 * Sale checks end to end on real Postgres, headless Chromium, and the fake site: linking
 * schedules the first check, a check records each order once and schedules the next from the
 * seller's history, a check that meets a CAPTCHA waits for the relink, a forwarded email asks
 * for a check at once, and the worker's dispatcher queues due checks and starts the runner.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createInventoryItem } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { ConnectionAwareAdapter, type AdapterLookup } from '@listora/marketplaces';
import { LocalTokenVault, SessionVault } from '@listora/connections';

import { RunnerSessions } from '../adapter/runner-sessions.ts';
import { AutomationDispatcher } from '../dispatch.ts';
import { assistedAdapter, createFakeSiteAdapter } from '../fake-site/fake-site-adapter.ts';
import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import { openRunnerPresence, type RunnerLauncher } from '../launcher.ts';
import { linkAutomationSession } from '../link.ts';
import type { AutomationProfile } from '../profiles.ts';
import { fakeSiteProfile, silentLogger, stubPhotos, testRunner } from '../test-support.ts';
import { runSaleCheck } from './job.ts';
import { recordSaleOrder, SALE_ORDER_TASK, type SaleOrderJobPayload } from './orders.ts';
import { dueSaleChecks, requestSaleCheck, saleCheckJobKey } from './schedule.ts';

const HOUR = 3_600_000;
const SETTINGS = {
  defaultIntervalMs: 12 * HOUR,
  minIntervalMs: 2 * HOUR,
  maxIntervalMs: 24 * HOUR,
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
      { accountId, marketplace: 'mercari', cookies: [site.issueSession(accountId)] },
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

  const check = (connectionId: string) =>
    runSaleCheck(
      { db: database.db, adapters, settings: SETTINGS, logger: silentLogger },
      { accountId, connectionId },
      new AbortController().signal,
    );

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

  it('records each new order once for the sale intake and schedules the next check', async () => {
    const { connectionId } = await link();
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
    const row = await schedule(connectionId);
    expect(row).toMatchObject({ last_outcome: 'succeeded', next_reason: 'scheduled' });
    // Too little history to adapt: the default 12 hours.
    const delay = row.next_check_at.getTime() - (row.last_finished_at?.getTime() ?? 0);
    expect(Math.abs(delay - 12 * HOUR)).toBeLessThan(60_000);
    expect(row.checked_through).toBeInstanceOf(Date);
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
      { accountId, marketplace: 'poshmark', cookies: [site.issueSession(accountId)] },
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
