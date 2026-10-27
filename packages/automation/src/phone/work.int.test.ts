/**
 * Phone runs end to end (docs/features/phone-execution.md), on real Postgres and the fake Depop
 * site: the operation engine hands a Depop step to the phone, the phone claims it, runs each
 * script call in its runtime (headless Chromium standing in for the app's web view), and
 * answers, and the server records the result exactly as for the browser runner: a publish and
 * a delist are confirmed by read-back, a check the seller can't complete now retries, a run
 * the phone abandons is recovered, work that waits too long fails with a Retry, and a
 * connection moved to the cloud takes its waiting work with it. Linking checks the session on
 * the phone, and a sale check there finds no sales, or fails visibly on sales Depop's page
 * doesn't say the listing of.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LocalTokenVault, SessionVault } from '@listora/connections';
import { createInventoryItem, type Db } from '@listora/db';
import { createLogger } from '@listora/shared';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createMarketplaceAdapters, type AdapterLookup } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';
import {
  enqueueOperation,
  runOperationStep,
  type OperationRow,
  type StepDependencies,
} from '@listora/operations';

import { NoBrowserSessions } from '../adapter/sessions.ts';
import { createAutomationAdapters } from '../adapters.ts';
import { FakeDepopSite } from '../depop/fake/fake-depop-site.ts';
import { setExecutionLocation } from '../execution.ts';
import { linkAutomationSession } from '../link.ts';
import { loadChromium } from '../runner/playwright.ts';
import { enqueueSaleCheck } from '../sale-checks/schedule.ts';
import { loadAutomationSettings, type AutomationSettings } from '../settings.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { phoneWorkAdapters } from './adapters.ts';
import type { HandOffAnswer } from './host.ts';
import { PHONE_RUNTIME_VERSION, runPhoneCall, type PhoneCallInput } from './runtime.ts';
import { PlaywrightPhoneHost } from './test-host.ts';
import {
  answerPhoneCall,
  claimPhoneRun,
  nextPhoneClaimSeconds,
  PHONE_IDLE_CLAIM_SECONDS,
  PHONE_UNUSED_CLAIM_SECONDS,
  type PhoneWorkDependencies,
} from './work.ts';

const FAST_POLICY = { delaysMs: [10, 20, 30, 40, 50, 60], jitter: 0, random: () => 0.5 };

describe('phone runs (real Postgres, the phone runtime in headless Chromium)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let site: FakeDepopSite;
  let browser: Browser;
  let settings: AutomationSettings;
  let phone: PhoneWorkDependencies;
  let worker: StepDependencies;
  let accountId: string;
  let deviceId: string;
  let connectionId: string;
  /** The seller's Depop username. */
  let seller: string;
  /** The phone's own web data: its signed-in Depop session. */
  let webData: BrowserContext;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });

  beforeAll(async () => {
    database = await createMigratedDatabase('phone_work', { jobQueue: true, max: 8 });
    db = database.db;
    site = await FakeDepopSite.start();
    browser = await (await loadChromium()).launch({ headless: true });
    const loaded = loadAutomationSettings({ FAKE_DEPOP_SITE_URL: site.url });
    settings = {
      ...loaded,
      profiles: { ...loaded.profiles, depop: { ...loaded.profiles.depop, pacing: QUICK_PACING } },
    };
    const marketplaces = { fakeMarketplaceUrl: undefined, ebay: undefined, depop: undefined };
    const workerAdapters: AdapterLookup = createMarketplaceAdapters({
      ...marketplaces,
      automation: createAutomationAdapters({
        settings,
        sessions: NoBrowserSessions,
        photos: stubPhotos,
        logger: silentLogger,
      }),
    }).lookup;
    worker = {
      db,
      adapters: workerAdapters,
      logger: silentLogger,
      policy: FAST_POLICY,
      callTimeoutMs: 30_000,
      blockedRecheckMs: 60_000,
    };
    phone = {
      db,
      adapters: phoneWorkAdapters(settings, marketplaces, silentLogger),
      profiles: settings.profiles,
      vault,
      policy: FAST_POLICY,
      saleChecks: settings.saleChecks,
      logger: silentLogger,
      stepTimeoutMs: 4_000,
      callTimeoutMs: 60_000,
      blockedRecheckMs: 60_000,
    };
  });

  afterAll(async () => {
    await browser.close();
    await site.close();
    await database.close();
  });

  beforeEach(async () => {
    site.clearFaults();
    accountId = await insertAccount(db);
    const { id: userId } = await db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: `phone-${accountId}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    ({ id: deviceId } = await db
      .insertInto('app_device')
      .values({
        account_id: accountId,
        installation_id: crypto.randomUUID(),
        user_id: userId,
        name: "Sam's iPhone",
        platform: 'ios',
        runtime_version: PHONE_RUNTIME_VERSION,
      })
      .returning('id')
      .executeTakeFirstOrThrow());
    seller = `seller_${accountId.replaceAll('-', '').slice(-12)}`;
    const cookie = site.issueSession(seller);
    // The seller already has a listing for sale. A lookup by SKU reads the shop's product links,
    // and an empty shop is only known as empty after the shop page module's wait for them (15
    // seconds), longer than these steps get.
    site.seed({ seller, description: 'Wool scarf.', priceCents: 1500 });
    ({ connectionId } = await linkAutomationSession(
      db,
      { vault, profile: settings.profiles.depop },
      { accountId, marketplace: 'depop', cookies: [cookie], deviceId },
    ));
    webData = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: { cookies: [{ ...cookie }], origins: [] },
    });
  });

  /** The phone's loop: claim work, run each call, answer, until nothing waits. */
  async function runPhone(answers: HandOffAnswer[] = []): Promise<number> {
    let runs = 0;
    for (;;) {
      let run = await claimPhoneRun(phone, db, {
        accountId,
        deviceId,
        runtimeVersion: PHONE_RUNTIME_VERSION,
      });
      if (run === null) return runs;
      runs += 1;
      while (run.call !== null) {
        const host = new PlaywrightPhoneHost(await webData.newPage());
        host.answers = [...answers];
        host.defaultAnswer = 'unavailable';
        const input = JSON.parse(JSON.stringify(run.call.input)) as PhoneCallInput;
        const output = await runPhoneCall(input, host, { pacing: { random: () => 0 } });
        await host.page.close();
        run = await answerPhoneCall(phone, {
          accountId,
          deviceId,
          runId: run.id,
          index: run.call.index,
          answer: JSON.parse(JSON.stringify(output)),
        });
      }
    }
  }

  /**
   * Runs the phone, then the read-back the engine repeats there: Depop's pages show no revision,
   * so a read-back that matches confirms a change only once a later read matches too.
   */
  async function runPhoneAndConfirm(
    op: { id: string },
    answers: HandOffAnswer[] = [],
  ): Promise<void> {
    await runPhone(answers);
    expect(await operation(op.id)).toMatchObject({ status: 'verifying', error_code: 'confirming' });
    await step(op);
    await runPhone();
  }

  async function newListing(): Promise<string> {
    const item = await createInventoryItem(db, accountId, { title: 'Trucker jacket' });
    const listing = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'depop',
        connection_id: connectionId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return listing.id;
  }

  async function enqueue(listingId: string, kind: 'create' | 'end'): Promise<OperationRow> {
    const content = sampleListingContent();
    const base = {
      accountId,
      listingId,
      idempotencyKey: crypto.randomUUID(),
      origin: 'user' as const,
      delistRunId: null,
    };
    const { operation } = await enqueueOperation(
      db,
      kind === 'create'
        ? { ...base, kind, content }
        : { ...base, kind, desired: { status: 'ended' } },
    );
    return operation;
  }

  const operation = (id: string) =>
    db
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const step = (op: { id: string }) =>
    runOperationStep(worker, { accountId, operationId: op.id }, AbortSignal.timeout(30_000));
  const work = () =>
    db.selectFrom('phone_work').selectAll().where('account_id', '=', accountId).execute();
  const jobOf = async (op: { id: string }) => {
    const { rows } = await sql<{ task_identifier: string; run_at: Date }>`
      select task_identifier, run_at from graphile_worker.jobs where key = ${`operation:${op.id}`}
    `.execute(db);
    return rows[0];
  };

  it('checks a session linked on the phone there, and runs Depop on that phone', async () => {
    expect(await work()).toEqual([
      expect.objectContaining({ purpose: 'session_check', connection_id: connectionId }),
      expect.objectContaining({ purpose: 'sale_check', connection_id: connectionId }),
    ]);
    const connection = await db
      .selectFrom('marketplace_connection')
      .select(['runs_on', 'phone_device_id'])
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(connection).toEqual({ runs_on: 'phone', phone_device_id: deviceId });
    expect(await runPhone()).toBe(2);
    const check = await db
      .selectFrom('session_check')
      .select('status')
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(check.status).toBe('passed');
    // Every session was the phone's, counted with the runner's for the rate limits.
    const runs = await db
      .selectFrom('automation_run')
      .select(['host', 'purpose', 'outcome'])
      .where('account_id', '=', accountId)
      .orderBy('started_at')
      .execute();
    expect(runs).toEqual([
      { host: 'phone', purpose: 'health', outcome: 'succeeded' },
      { host: 'phone', purpose: 'sale_check', outcome: 'succeeded' },
    ]);
    expect(await work()).toEqual([]);
  });

  it('tries a check again once it is due, and tells the phone when to ask for it', async () => {
    // The phone's first attempt finds a page Listora no longer understands. The check waits 30
    // seconds for its next attempt, which the phone must claim by itself while the app is
    // open: a phone with nothing to run is told when to ask again, never left to a push.
    site.inject({ action: 'health', fault: { type: 'redesigned' } });
    expect(await runPhone()).toBe(2);
    const check = () =>
      db
        .selectFrom('session_check')
        .select(['status', 'attempts', 'failure_code', 'failure_message'])
        .where('connection_id', '=', connectionId)
        .executeTakeFirstOrThrow();
    expect(await check()).toEqual({
      status: 'pending',
      attempts: 1,
      failure_code: null,
      failure_message: null,
    });
    const device = { accountId, deviceId };
    expect(await nextPhoneClaimSeconds(db, device)).toBe(PHONE_IDLE_CLAIM_SECONDS);
    const due = (interval: string) =>
      db
        .updateTable('phone_work')
        .set({ due_at: sql<Date>`now() + ${interval}::interval` })
        .where('account_id', '=', accountId)
        .where('purpose', '=', 'session_check')
        .execute();
    await due('3 seconds');
    expect(await nextPhoneClaimSeconds(db, device)).toBeLessThanOrEqual(3);
    await due('0 seconds');
    expect(await nextPhoneClaimSeconds(db, device)).toBe(1);
    expect(await runPhone()).toBe(1);
    expect(await check()).toEqual({
      status: 'passed',
      attempts: 2,
      failure_code: null,
      failure_message: null,
    });
    // A device that runs no marketplace asks only rarely.
    await setExecutionLocation(db, { accountId, connectionId }, 'cloud');
    expect(await nextPhoneClaimSeconds(db, device)).toBe(PHONE_UNUSED_CLAIM_SECONDS);
  });

  it("logs what a page the phone's script no longer understands has instead, structure only", async () => {
    const lines: Record<string, unknown>[] = [];
    const quiet = phone;
    phone = {
      ...quiet,
      logger: createLogger({
        service: 'phone-test',
        level: 'warn',
        destination: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      }),
    };
    try {
      site.inject({ action: 'health', fault: { type: 'redesigned' } });
      await runPhone();
    } finally {
      phone = quiet;
    }
    const stopped = lines.find(
      (line) => line['msg'] === 'automation script stopped' && line['code'] === 'element_missing',
    );
    expect(stopped).toMatchObject({
      host: 'phone',
      marketplace: 'depop',
      evidence: { path: expect.any(String) as string, testIds: expect.any(Array) as string[] },
    });
    expect(JSON.stringify(lines)).not.toContain(seller);
    // Only the log line has it: the run's transcript keeps the answer without it.
    const kept = await db
      .selectFrom('phone_work')
      .select('transcript')
      .where('account_id', '=', accountId)
      .execute();
    expect(JSON.stringify(kept)).not.toContain('evidence');
  });

  it('publishes and delists on the phone, each confirmed by a read-back there', async () => {
    await runPhone();
    const listingId = await newListing();
    const create = await enqueue(listingId, 'create');
    await step(create);
    // Handed to the phone: it waits there, and the engine looks again later.
    expect(await operation(create.id)).toMatchObject({ status: 'queued' });
    expect(await work()).toEqual([
      expect.objectContaining({ purpose: 'operation', operation_id: create.id, claimed_at: null }),
    ]);
    expect(await jobOf(create)).toMatchObject({ task_identifier: 'marketplace_operation' });
    await runPhoneAndConfirm(create);
    expect(await operation(create.id)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    const listing = await db
      .selectFrom('marketplace_listing')
      .select(['status', 'external_listing_id'])
      .where('id', '=', listingId)
      .executeTakeFirstOrThrow();
    expect(listing.status).toBe('active');
    expect(site.product(listing.external_listing_id ?? '')?.status).toBe('ONSALE');

    const end = await enqueue(listingId, 'end');
    await step(end);
    await runPhoneAndConfirm(end);
    expect(await operation(end.id)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    expect(site.product(listing.external_listing_id ?? '')?.status).toBe('DELETED');
    expect(await work()).toEqual([]);
  });

  it('stops at a check nobody can complete now, keeps the session, and retries', async () => {
    await runPhone();
    const create = await enqueue(await newListing(), 'create');
    await step(create);
    site.inject({ action: 'form', fault: { type: 'captcha' } });
    await runPhone(['unavailable']);
    expect(await operation(create.id)).toMatchObject({
      status: 'retrying',
      error_code: 'stopped_for_check',
      error_message: expect.stringContaining('complete a check on your iPhone') as unknown,
    });
    const connection = await db
      .selectFrom('marketplace_connection')
      .select('status')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(connection.status).toBe('connected');
    // Once the seller completes it, the next run of the step lists it.
    await step(create);
    await runPhoneAndConfirm(create, ['completed']);
    expect(await operation(create.id)).toMatchObject({ status: 'succeeded' });
  });

  it('recovers a step the phone stopped in the middle of, by a read-back', async () => {
    await runPhone();
    const create = await enqueue(await newListing(), 'create');
    await step(create);
    const run = await claimPhoneRun(phone, db, {
      accountId,
      deviceId,
      runtimeVersion: PHONE_RUNTIME_VERSION,
    });
    expect(run?.call).not.toBeNull();
    expect(await operation(create.id)).toMatchObject({ status: 'running' });
    // While the lease holds, the engine leaves the phone's run alone.
    await step(create);
    expect(await operation(create.id)).toMatchObject({ status: 'running' });
    await db
      .updateTable('phone_work')
      .set({ lease_expires_at: sql<Date>`now() - interval '1 second'` })
      .where('account_id', '=', accountId)
      .execute();
    await step(create);
    expect(await operation(create.id)).toMatchObject({
      status: 'verifying',
      error_code: 'interrupted',
    });
    // The read-back goes to the phone too, which finds nothing listed: it is sent again.
    await step(create);
    await runPhone();
    await step(create);
    await runPhoneAndConfirm(create);
    expect(await operation(create.id)).toMatchObject({ status: 'succeeded' });
  });

  it('gives up a run the phone stopped in the middle of once it asks for work again', async () => {
    await runPhone();
    const create = await enqueue(await newListing(), 'create');
    await step(create);
    const stopped = await claimPhoneRun(phone, db, {
      accountId,
      deviceId,
      runtimeVersion: PHONE_RUNTIME_VERSION,
    });
    expect(stopped?.call).not.toBeNull();
    // The app was closed in the middle; opened again, it asks for work long before the lease
    // runs out. Its unanswered call is canceled and the step is recovered by a read-back.
    expect(
      await claimPhoneRun(phone, db, {
        accountId,
        deviceId,
        runtimeVersion: PHONE_RUNTIME_VERSION,
      }),
    ).toBeNull();
    const [run] = await db
      .selectFrom('automation_run')
      .select(['outcome', 'error_code'])
      .where('account_id', '=', accountId)
      .where('host', '=', 'phone')
      .where('purpose', '=', 'operation')
      .execute();
    expect(run).toEqual({ outcome: 'canceled', error_code: 'phone_stopped' });
    expect(await operation(create.id)).toMatchObject({
      status: 'verifying',
      error_code: 'interrupted',
    });
    await step(create);
    await runPhone();
    await step(create);
    await runPhoneAndConfirm(create);
    expect(await operation(create.id)).toMatchObject({ status: 'succeeded' });
  });

  it('fails work the phone has not run for a day, with a Retry', async () => {
    await runPhone();
    const create = await enqueue(await newListing(), 'create');
    await step(create);
    await db
      .updateTable('phone_work')
      .set({ waiting_since: sql<Date>`now() - interval '25 hours'` })
      .where('account_id', '=', accountId)
      .execute();
    await step(create);
    expect(await operation(create.id)).toMatchObject({
      status: 'failed',
      error_code: 'phone_unavailable',
      error_message: expect.stringContaining(
        'Open Listora on your iPhone, then tap Retry',
      ) as unknown,
    });
    expect(await work()).toEqual([]);
  });

  it('moves waiting work to the cloud runner with its connection', async () => {
    await runPhone();
    const create = await enqueue(await newListing(), 'create');
    await step(create);
    expect(await setExecutionLocation(db, { accountId, connectionId }, 'cloud')).toBe(true);
    expect(await work()).toEqual([]);
    await step(create);
    expect(await jobOf(create)).toMatchObject({
      task_identifier: 'marketplace_operation_automation',
    });
    expect(
      await claimPhoneRun(phone, db, {
        accountId,
        deviceId,
        runtimeVersion: PHONE_RUNTIME_VERSION,
      }),
    ).toBeNull();
  });

  it('fails a phone sale check visibly when Depop shows a sale, and hands nothing to the sale intake', async () => {
    await runPhone();
    const listingId = await newListing();
    const create = await enqueue(listingId, 'create');
    await step(create);
    await runPhoneAndConfirm(create);
    const { external_listing_id: slug } = await db
      .selectFrom('marketplace_listing')
      .select('external_listing_id')
      .where('id', '=', listingId)
      .executeTakeFirstOrThrow();
    site.sell(slug ?? '');
    expect(await enqueueSaleCheck(db, { accountId, connectionId, marketplace: 'depop' })).toBe(
      true,
    );
    await runPhone();
    // Depop's sold items page names a sale's receipt, not its listing: the check fails, and is
    // tried again, rather than guess which listing sold (a wrong guess would delist it).
    const schedule = await db
      .selectFrom('sale_check_schedule')
      .select(['last_outcome', 'next_reason'])
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(schedule).toEqual({ last_outcome: 'failed', next_reason: 'retry' });
    const [run] = await db
      .selectFrom('automation_run')
      .select(['outcome', 'error_code'])
      .where('account_id', '=', accountId)
      .where('host', '=', 'phone')
      .where('purpose', '=', 'sale_check')
      .orderBy('started_at', 'desc')
      .limit(1)
      .execute();
    expect(run).toEqual({ outcome: 'failed', error_code: 'element_missing' });
    const events = await db
      .selectFrom('inbound_event')
      .select(['source', 'provider_event_id'])
      .where('account_id', '=', accountId)
      .execute();
    expect(events).toEqual([]);
  });

  it('runs nothing for a runtime that speaks another version, or another device', async () => {
    await expect(
      claimPhoneRun(phone, db, { accountId, deviceId, runtimeVersion: PHONE_RUNTIME_VERSION + 1 }),
    ).rejects.toThrow('needs an update');
    expect(
      await claimPhoneRun(phone, db, {
        accountId,
        deviceId: crypto.randomUUID(),
        runtimeVersion: PHONE_RUNTIME_VERSION,
      }),
    ).toBeNull();
  });
});
