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
  OPEN_APP_GAP_MS,
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
import { LISTING_IMPORT_APPLY_TASK, queueImportPage } from '../imports/schedule.ts';
import { queueLabelReads } from '../label-reads/queue.ts';
import { requestOfferAnswer } from '../offers/answer.ts';
import { queueDueOfferChecks, queueOfferCheck } from '../offers/schedule.ts';
import { enqueueSaleCheck, requestSaleHistoryRead } from '../sale-checks/schedule.ts';
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
  waitForPhoneWork,
} from './work.ts';
import { listenForPhoneWork } from './signals.ts';

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

  // Closing Chromium and the scratch database can take a while on a busy machine.
  afterAll(async () => {
    await browser.close();
    await site.close();
    await database.close();
  }, 60_000);

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
    // The seller already has a listing for sale.
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
   * Runs the phone, whose read-back confirms the change there at once: Depop's reads carry its
   * own last change time (depop/pages/api.ts).
   */
  async function runPhoneAndConfirm(
    op: { id: string },
    answers: HandOffAnswer[] = [],
  ): Promise<void> {
    await runPhone(answers);
    expect(await operation(op.id)).toMatchObject({ status: 'succeeded' });
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

  it('never hands the phone a write for a read-only shop, even mid-run, and still runs its reads', async () => {
    await runPhone();
    const readOnly = () =>
      db
        .updateTable('marketplace_connection')
        .set({ read_only: true })
        .where('id', '=', connectionId)
        .execute();
    const created = () => site.products().filter((product) => product.seller === seller);
    const before = created().length;

    // A publish queued for the phone before the shop became read only fails at its claim.
    const queued = await enqueue(await newListing(), 'create');
    await step(queued);
    await readOnly();
    expect(await runPhone()).toBe(0);
    expect(await operation(queued.id)).toMatchObject({
      status: 'failed',
      error_code: 'connection_read_only',
    });
    expect(await work()).toEqual([]);
    expect(created()).toHaveLength(before);

    // A publish whose run starts with a read (an earlier attempt's 5xx may have posted it) and
    // whose shop becomes read only meanwhile: the server answers the write itself.
    await db
      .updateTable('marketplace_connection')
      .set({ read_only: false })
      .where('id', '=', connectionId)
      .execute();
    const create = await enqueue(await newListing(), 'create');
    site.inject({ action: 'create', fault: { type: 'server_error' } });
    await step(create);
    await runPhone();
    expect(await operation(create.id)).toMatchObject({ status: 'retrying' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await step(create);
    const device = { accountId, deviceId, runtimeVersion: PHONE_RUNTIME_VERSION };
    const run = await claimPhoneRun(phone, db, device);
    const call = run?.call;
    if (run === null || call === null || call === undefined) throw new Error('no call');
    const input = JSON.parse(JSON.stringify(call.input)) as PhoneCallInput;
    expect(input.call.script).toBe('read');
    await readOnly();
    const host = new PlaywrightPhoneHost(await webData.newPage());
    const output = await runPhoneCall(input, host, { pacing: { random: () => 0 } });
    await host.page.close();
    const next = await answerPhoneCall(phone, {
      accountId,
      deviceId,
      runId: run.id,
      index: call.index,
      answer: JSON.parse(JSON.stringify(output)),
    });
    expect(next.call).toBeNull();
    expect(await operation(create.id)).toMatchObject({
      status: 'failed',
      error_code: 'connection_read_only',
    });
    expect(created()).toHaveLength(before);
    const runs = await db
      .selectFrom('automation_run')
      .select('script')
      .where('operation_id', '=', create.id)
      .orderBy('started_at')
      .execute();
    // The failed first send and the read; never a second send.
    expect(runs.map((row) => row.script)).toEqual(['create', 'read listing']);

    // Reads keep running, and the phone is told the shop is read only with each call.
    await requestSaleHistoryRead(db, { accountId, marketplace: 'depop' });
    const read = await claimPhoneRun(phone, db, device);
    expect(read?.call?.input).toMatchObject({ readOnly: true, call: { script: 'orders' } });
  });

  it('wakes the waiting app the moment the engine hands it a delist, and looks every few seconds without signals', async () => {
    await runPhone();
    const listingId = await newListing();
    const create = await enqueue(listingId, 'create');
    await step(create);
    await runPhoneAndConfirm(create);
    const device = { accountId, deviceId };
    let started: number;

    const listening = listenForPhoneWork({
      connectionString: database.scratch.url,
      logger: silentLogger,
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!listening.signals.listening && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const deps = { signals: listening.signals };
      // Nothing for the phone: the wait runs out.
      expect(await waitForPhoneWork(deps, db, device, { maxMs: 300 })).toBe(false);

      started = Date.now();
      const waiting = waitForPhoneWork(deps, db, device, { maxMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const end = await enqueue(listingId, 'end');
      await step(end);
      expect(await waiting).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);

      // A claim renewing its lease wakes nobody; the claim's end does.
      const run = await claimPhoneRun(phone, db, {
        accountId,
        deviceId,
        runtimeVersion: PHONE_RUNTIME_VERSION,
      });
      expect(run).toMatchObject({ operationId: end.id });
      const subscription = listening.signals.subscribe(accountId);
      await db
        .updateTable('phone_work')
        .set({ lease_expires_at: sql<Date>`now() + interval '10 minutes'` })
        .where('account_id', '=', accountId)
        .execute();
      expect(await subscription.wait(300)).toBe('timeout');
      subscription.cancel();
      started = Date.now();
      const released = waitForPhoneWork(deps, db, device, { maxMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The app stopped (it names no runs): the claim ends, and the work is claimable again.
      await claimPhoneRun(phone, db, {
        accountId,
        deviceId,
        runtimeVersion: PHONE_RUNTIME_VERSION,
        running: [crypto.randomUUID()],
      });
      expect(await released).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await listening.close();
    }

    // Without signals the wait still looks every PHONE_IDLE_CLAIM_SECONDS: due work ends it.
    started = Date.now();
    expect(await waitForPhoneWork({}, db, device, { maxMs: 15_000 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
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

  it('reads a Depop sale on the phone from its receipt, and hands it to the sale intake', async () => {
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
    // Depop's receipt names the purchase and the product it sold, which its sold listings name
    // by slug: the order of Listora's listing, handed over once.
    const schedule = await db
      .selectFrom('sale_check_schedule')
      .select(['last_outcome', 'next_reason'])
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(schedule).toEqual({ last_outcome: 'succeeded', next_reason: 'scheduled' });
    const events = await db
      .selectFrom('inbound_event')
      .select(['source', 'provider_event_id', 'payload'])
      .where('account_id', '=', accountId)
      .execute();
    expect(events).toEqual([
      {
        source: 'poll',
        provider_event_id: `order:${String(site.purchaseIdOf(slug ?? ''))}`,
        payload: expect.objectContaining({
          shipped: false,
          items: [expect.objectContaining({ externalListingId: slug }) as unknown],
        }) as unknown,
      },
    ]);
  });

  it("reads the sold history on the phone read-only, and records each check with the phone's step times", async () => {
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

    expect(await requestSaleHistoryRead(db, { accountId, marketplace: 'depop' })).toMatchObject({
      connectionId,
      runsOn: 'phone',
      queued: true,
    });
    expect(await work()).toEqual([
      expect.objectContaining({ purpose: 'sale_history', connection_id: connectionId }),
    ]);
    await runPhone();
    // Read, not acted on: no order handed over, no sale.
    const events = await db
      .selectFrom('inbound_event')
      .select('id')
      .where('account_id', '=', accountId)
      .execute();
    expect(events).toEqual([]);
    const checks = await db
      .selectFrom('sale_check_run')
      .select([
        'kind',
        'host',
        'outcome',
        'orders_seen',
        'new_orders',
        'orders',
        'automation_run_id',
      ])
      .where('account_id', '=', accountId)
      .orderBy('started_at')
      .execute();
    expect(
      checks.map(({ kind, host, outcome, orders_seen, new_orders }) => ({
        kind,
        host,
        outcome,
        orders_seen,
        new_orders,
      })),
    ).toEqual([
      // The first sale check after linking saw nothing sold yet.
      { kind: 'scheduled', host: 'phone', outcome: 'succeeded', orders_seen: 0, new_orders: 0 },
      // The history read saw the sale, and handed nothing to the sale intake.
      { kind: 'history', host: 'phone', outcome: 'succeeded', orders_seen: 1, new_orders: 0 },
    ]);
    // The phone said how long each step took.
    const session = await db
      .selectFrom('automation_run')
      .select('steps')
      .where('id', '=', checks[1]?.automation_run_id ?? '')
      .executeTakeFirstOrThrow();
    expect(session.steps?.length).toBeGreaterThan(0);
    for (const recorded of session.steps ?? []) {
      expect(recorded).toEqual({
        name: expect.any(String) as unknown,
        ms: expect.any(Number) as unknown,
      });
    }
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
  it('hands a phone that runs marketplaces side by side one run per marketplace, and recovers only the runs it stopped', async () => {
    await linkAutomationSession(
      db,
      { vault, profile: settings.profiles.mercari },
      {
        accountId,
        marketplace: 'mercari',
        deviceId,
        cookies: [
          {
            name: 'sid',
            value: 'mercari-session',
            domain: '.mercari.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      },
    );
    const device = { accountId, deviceId, runtimeVersion: PHONE_RUNTIME_VERSION };
    const first = await claimPhoneRun(phone, db, device);
    if (first === null) throw new Error('the first claim found nothing');
    const second = await claimPhoneRun(phone, db, { ...device, running: [first.id] });
    if (second === null) throw new Error('the second claim found nothing');
    expect(new Set([first.marketplace, second.marketplace])).toEqual(new Set(['depop', 'mercari']));
    // Both marketplaces run: nothing more for this phone until one of them is free.
    expect(
      await claimPhoneRun(phone, db, { ...device, running: [first.id, second.id] }),
    ).toBeNull();
    const held = async () =>
      (await work())
        .filter((row) => row.lease_expires_at !== null && row.lease_expires_at > new Date())
        .map((row) => row.id)
        .sort();
    expect(await held()).toEqual([first.id, second.id].sort());
    // The app no longer runs the second (it was closed in the middle of the call): a claim
    // that doesn't name it ends it, and its marketplace is free for its work again.
    const third = await claimPhoneRun(phone, db, { ...device, running: [first.id] });
    expect(third?.marketplace).toBe(second.marketplace);
    expect(await held()).toContain(first.id);
    const stopped = await db
      .selectFrom('automation_run')
      .select(['marketplace', 'outcome'])
      .where('account_id', '=', accountId)
      .where('error_code', '=', 'phone_stopped')
      .execute();
    expect(stopped).toEqual([{ marketplace: second.marketplace, outcome: 'canceled' }]);
  });

  it("starts a run's later calls at once: only its first waits out the pause between sessions", async () => {
    // The link's checks just ran, so a new session would wait out the pause after them.
    await runPhone();
    const paced: PhoneWorkDependencies = {
      ...phone,
      profiles: {
        ...phone.profiles,
        depop: {
          ...phone.profiles.depop,
          pacing: { ...QUICK_PACING, sessionGapMs: [60_000, 60_000] },
        },
      },
    };
    const op = await enqueue(await newListing(), 'create');
    await step(op);
    let run = await claimPhoneRun(paced, db, {
      accountId,
      deviceId,
      runtimeVersion: PHONE_RUNTIME_VERSION,
    });
    expect(run?.call?.input.startDelayMs).toBeGreaterThan(30_000);
    const later: number[] = [];
    while (run?.call) {
      const host = new PlaywrightPhoneHost(await webData.newPage());
      // The phone would wait the pause first; the test doesn't.
      const input = { ...run.call.input, startDelayMs: 0 };
      const output = await runPhoneCall(input, host, { pacing: { random: () => 0 } });
      await host.page.close();
      run = await answerPhoneCall(paced, {
        accountId,
        deviceId,
        runId: run.id,
        index: run.call.index,
        answer: JSON.parse(JSON.stringify(output)),
      });
      if (run.call !== null) later.push(run.call.input.startDelayMs);
    }
    // The create's read-back follows it in the same visit.
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((delay) => delay === 0)).toBe(true);
  });

  it('runs changes waiting out a backoff at once while the app is open, but keeps pacing waits', async () => {
    await runPhone();
    const waiting = async (errorCode: string) => {
      const op = await enqueue(await newListing(), 'create');
      await db
        .updateTable('marketplace_operation')
        .set({
          status: 'retrying',
          attempts: 1,
          next_attempt_at: sql<Date>`now() + interval '10 minutes'`,
          error_code: errorCode,
          error_message: 'Depop did not answer.',
        })
        .where('id', '=', op.id)
        .execute();
      return op;
    };
    const backoff = await waiting('step_timeout');
    const paced = await waiting('rate_limited');
    const device = { accountId, deviceId };
    const claim = (appOpen: boolean) =>
      claimPhoneRun(phone, db, { ...device, runtimeVersion: PHONE_RUNTIME_VERSION, appOpen });
    // Right after its last step, a change waits a moment even while the app is open.
    expect(await nextPhoneClaimSeconds(db, { ...device, appOpen: true })).toBeLessThanOrEqual(
      Math.ceil(OPEN_APP_GAP_MS / 1000) + 1,
    );
    await new Promise((resolve) => setTimeout(resolve, OPEN_APP_GAP_MS + 200));
    // A closed app's phone waits for the retry's time; an open one looks again at once.
    expect(await nextPhoneClaimSeconds(db, device)).toBe(PHONE_IDLE_CLAIM_SECONDS);
    expect(await nextPhoneClaimSeconds(db, { ...device, appOpen: true })).toBe(1);
    expect(await claim(false)).toBeNull();
    expect((await operation(backoff.id)).next_attempt_at?.getTime()).toBeGreaterThan(Date.now());

    expect(await claim(true)).toBeNull();
    expect((await operation(backoff.id)).next_attempt_at?.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const moved = await db
      .selectFrom('operation_event')
      .select('detail')
      .where('operation_id', '=', backoff.id)
      .where('to_status', '=', 'retrying')
      .execute();
    expect(moved.map((row) => row.detail)).toContainEqual({
      action: 'try_now',
      reason: 'app_open',
    });
    // The marketplace asked to slow down: that wait stands.
    expect((await operation(paced.id)).next_attempt_at?.getTime()).toBeGreaterThan(
      Date.now() + 60_000,
    );
    // The engine hands the change over at once, and the open app's next claim runs it.
    expect((await jobOf(backoff))?.run_at.getTime()).toBeLessThanOrEqual(Date.now());
    await step(backoff);
    expect((await claim(true))?.operationId).toBe(backoff.id);
  });

  /** An import of the seller's Depop listings, its first page waiting for the phone. */
  async function startImport(): Promise<string> {
    const { id } = await db
      .insertInto('listing_import')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace: 'depop',
        host: 'phone',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await queueImportPage(db, { accountId, importId: id, connectionId, marketplace: 'depop' });
    return id;
  }

  it("reads an import's pages on the phone one session each, read-only, with each listing's details", async () => {
    // The linked session's own check runs first.
    await runPhone();
    for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      site.seed({
        seller,
        description: `Listing ${String(number)}.`,
        priceCents: 1000 + number,
        photos: [`photo-${String(number)}.jpg`],
      });
    }
    const importId = await startImport();
    const before = site.requests.length;
    expect(await runPhone()).toBe(2);
    const read = await db
      .selectFrom('listing_import')
      .selectAll()
      .where('id', '=', importId)
      .executeTakeFirstOrThrow();
    // The scarf the seller had and the eleven new ones, over two pages of ten.
    expect(read).toMatchObject({
      status: 'importing',
      pages_read: 2,
      listings_read: 12,
      error_code: null,
    });
    const entries = await db
      .selectFrom('listing_import_entry')
      .select(['external_listing_id', 'listing'])
      .where('import_id', '=', importId)
      .execute();
    expect(entries).toHaveLength(12);
    const first = entries.find((entry) => entry.external_listing_id.includes('listing-1-'));
    expect(first?.listing).toMatchObject({
      status: 'active',
      description: 'Listing 1.',
      priceCents: 1001,
      details: { photoUrls: [`${site.url}/media/photo-1.jpg`], size: 'M' },
    });
    // Nothing on Depop changed, and the worker is asked to settle what was read.
    expect(site.requests.slice(before).filter((request) => request.method !== 'GET')).toEqual([]);
    const runs = await db
      .selectFrom('automation_run')
      .select(['purpose', 'host', 'outcome'])
      .where('account_id', '=', accountId)
      .where('purpose', '=', 'import')
      .execute();
    expect(runs).toEqual([
      { purpose: 'import', host: 'phone', outcome: 'succeeded' },
      { purpose: 'import', host: 'phone', outcome: 'succeeded' },
    ]);
    const { rows } = await sql<{ task_identifier: string }>`
      select task_identifier from graphile_worker.jobs where key = ${`listing-import-apply:${importId}`}
    `.execute(db);
    expect(rows.map((row) => row.task_identifier)).toEqual([LISTING_IMPORT_APPLY_TASK]);
  });

  it('stops reading at a check the seller is not there to complete, or a sign-in they declined, with the reason', async () => {
    await runPhone();
    const importOf = (id: string) =>
      db.selectFrom('listing_import').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const checked = await startImport();
    site.inject({ action: 'listings', fault: { type: 'bot_check' } });
    await runPhone();
    expect(await importOf(checked)).toMatchObject({
      status: 'importing',
      listings_read: 0,
      error_code: 'stopped_for_check',
      error_message:
        "Depop wants you to complete a check in Listora on your iPhone. Import again once it's done to read the rest.",
    });
    // Signed out, and the seller won't sign in again now: the connection waits for a relink.
    await db
      .updateTable('listing_import')
      .set({ status: 'finished', finished_at: new Date() })
      .where('id', '=', checked)
      .execute();
    const signedOut = await startImport();
    site.inject({ action: 'health', fault: { type: 'session_expired' } });
    await runPhone(['declined']);
    // The sign-in the seller declined discarded the session, so the import has none to go on.
    expect(await importOf(signedOut)).toMatchObject({
      status: 'importing',
      error_code: 'no_session',
      error_message: 'Link Depop again in Listora to finish the import.',
    });
    const connection = await db
      .selectFrom('marketplace_connection')
      .select('status')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(connection.status).toBe('reauth_required');
  });

  it("reads a sale's shipping label on the phone for Pack check, read-only, and records it", async () => {
    await runPhone();
    const listingId = await newListing();
    const create = await enqueue(listingId, 'create');
    await step(create);
    await runPhoneAndConfirm(create);
    const listing = await db
      .selectFrom('marketplace_listing')
      .select(['external_listing_id', 'item_id'])
      .where('id', '=', listingId)
      .executeTakeFirstOrThrow();
    const slug = listing.external_listing_id ?? '';
    site.sell(slug, new Date(), {
      trackingNumber: '9400 1118 9922 3197 4284 90',
      buyerFirstName: 'Sarah M.',
    });
    const sale = await db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace: 'depop',
        // A Depop order is named by its purchase id, as its receipt names it.
        external_order_id: String(site.purchaseIdOf(slug)),
        sold_at: new Date(),
        detection_source: 'poll',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: sale.id,
        marketplace: 'depop',
        item_id: listing.item_id,
        listing_id: listingId,
        sale_price_cents: 1500,
      })
      .execute();

    expect(await queueLabelReads(db, { accountId, now: new Date() })).toEqual([
      { marketplace: 'depop', orders: 1, where: 'phone' },
    ]);
    expect(await work()).toEqual([
      expect.objectContaining({ purpose: 'label_read', connection_id: connectionId }),
    ]);
    await runPhone();
    const label = await db
      .selectFrom('sale_label')
      .select(['tracking_number', 'carrier', 'source', 'buyer_first_name', 'read_status'])
      .where('account_id', '=', accountId)
      .where('sale_id', '=', sale.id)
      .executeTakeFirstOrThrow();
    expect(label).toEqual({
      tracking_number: '9400111899223197428490',
      carrier: 'usps',
      source: 'marketplace',
      buyer_first_name: 'Sarah',
      read_status: 'read',
    });
    const runs = await db
      .selectFrom('automation_run')
      .select(['purpose', 'host', 'outcome'])
      .where('account_id', '=', accountId)
      .where('purpose', '=', 'label_read')
      .execute();
    expect(runs).toEqual([{ purpose: 'label_read', host: 'phone', outcome: 'succeeded' }]);
    // A label already read is not read again.
    expect(await queueLabelReads(db, { accountId, now: new Date() })).toEqual([
      { marketplace: 'depop', orders: 0, where: 'none' },
    ]);
  });

  // Offers (docs/features/offers.md) -------------------------------------------------------------

  /** A Depop listing of an item, posted and confirmed on the phone, with a buyer's offer on it. */
  async function listingWithOffer(amountCents = 2000) {
    site.offers.clear();
    await runPhone();
    const listingId = await newListing();
    const create = await enqueue(listingId, 'create');
    await step(create);
    await runPhoneAndConfirm(create);
    const listing = await db
      .selectFrom('marketplace_listing')
      .select(['external_listing_id', 'item_id', 'price_cents'])
      .where('id', '=', listingId)
      .executeTakeFirstOrThrow();
    const offer = site.offers.add({
      listingId: listing.external_listing_id ?? '',
      listingTitle: 'Trucker jacket',
      amountCents,
      listPriceCents: 3000,
      buyer: 'jacketfan',
    });
    return { listingId, itemId: listing.item_id, priceCents: listing.price_cents, offer };
  }

  const readOffers = async () => {
    expect(await queueOfferCheck(db, { accountId, connectionId, marketplace: 'depop' })).toBe(true);
    await runPhone();
  };
  /** Listora's id of a fake Depop offer: its product and the offer's own id. */
  const externalOfferIds = new Map<string, string>();
  const offerRow = (fakeOfferId: string) => {
    const offer = site.offers.get(fakeOfferId);
    if (offer !== undefined) {
      externalOfferIds.set(
        fakeOfferId,
        `${String(site.productId(offer.listingId))}//${fakeOfferId}`,
      );
    }
    return db
      .selectFrom('marketplace_offer')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('external_offer_id', '=', externalOfferIds.get(fakeOfferId) ?? fakeOfferId)
      .executeTakeFirstOrThrow();
  };
  const offerTasks = () =>
    db
      .selectFrom('user_task')
      .select(['kind', 'status', 'offer_id', 'item_id', 'listing_id', 'deep_link'])
      .where('account_id', '=', accountId)
      .where('kind', '=', 'answer_offer')
      .execute();
  const responseRow = (id: string) =>
    db
      .selectFrom('offer_response')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const answerNow = (
    offer: { id: string; amount_cents: number },
    action: 'accept' | 'decline' | 'counter',
    counterCents: number | null = null,
  ) =>
    requestOfferAnswer(db, {
      accountId,
      offerId: offer.id,
      action,
      counterCents,
      offerAmountCents: offer.amount_cents,
      idempotencyKey: crypto.randomUUID(),
      now: new Date(),
    });
  /** Work put off (a read again after a send) is due now. */
  const dueNow = () =>
    db
      .updateTable('phone_work')
      .set({ due_at: sql<Date>`now()` })
      .where('account_id', '=', accountId)
      .execute();

  it("reads the seller's offers on the phone read-only: each pending one is a task, and one that goes away closes it", async () => {
    const { listingId, itemId, priceCents, offer } = await listingWithOffer();
    await readOffers();
    const row = await offerRow(offer.id);
    expect(row).toMatchObject({
      status: 'pending',
      amount_cents: 2000,
      // Depop's offers name no price: the listing's own.
      list_price_cents: priceCents,
      buyer_name: 'jacketfan',
      listing_id: listingId,
      item_id: itemId,
      offer_url: `${site.url}/sellinghub/offers/`,
    });
    expect(await offerTasks()).toEqual([
      {
        kind: 'answer_offer',
        status: 'open',
        offer_id: row.id,
        item_id: itemId,
        listing_id: listingId,
        deep_link: row.offer_url,
      },
    ]);
    const check = await db
      .selectFrom('offer_check')
      .select(['last_outcome', 'offers_seen'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(check).toEqual({ last_outcome: 'succeeded', offers_seen: 1 });
    const runs = await db
      .selectFrom('automation_run')
      .select(['purpose', 'host', 'outcome'])
      .where('account_id', '=', accountId)
      .where('purpose', '=', 'offer_check')
      .execute();
    expect(runs).toEqual([{ purpose: 'offer_check', host: 'phone', outcome: 'succeeded' }]);
    // Reading again keeps one task; nothing was ever answered.
    await readOffers();
    expect(await offerTasks()).toHaveLength(1);
    expect(site.offers.answers).toEqual([]);

    // The dispatcher asks again only once the hour since the last read is up.
    const offerReadsWaiting = async () =>
      (await work()).filter((row) => row.purpose === 'offer_check').length;
    await queueDueOfferChecks(db);
    expect(await offerReadsWaiting()).toBe(0);
    await queueDueOfferChecks(db, 0);
    expect(await offerReadsWaiting()).toBe(1);
    await runPhone();

    site.offers.remove(offer.id);
    await readOffers();
    expect(await offerRow(offer.id)).toMatchObject({ status: 'closed' });
    expect(await offerTasks()).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it('accepts an offer from the phone only when asked, done only once a read-back shows it, then checks for the sale', async () => {
    const { offer } = await listingWithOffer();
    await readOffers();
    const row = await offerRow(offer.id);
    const { responseId } = await answerNow(row, 'accept');
    await runPhone();
    expect(site.offers.answers).toMatchObject([{ offerId: offer.id, action: 'accept' }]);
    expect(await responseRow(responseId)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
      sent: true,
      net_cents: expect.any(Number) as number,
    });
    expect(await offerRow(offer.id)).toMatchObject({ status: 'accepted' });
    expect(await offerTasks()).toEqual([expect.objectContaining({ status: 'done' })]);
    // The normal sale flow takes it from here: a sale check of Depop, asked for by the offer.
    const checks = await db
      .selectFrom('sale_check_run')
      .select(['reason', 'host'])
      .where('account_id', '=', accountId)
      .execute();
    expect(checks).toContainEqual({ reason: 'offer', host: 'phone' });
    const runs = await db
      .selectFrom('automation_run')
      .select(['script'])
      .where('account_id', '=', accountId)
      .where('purpose', '=', 'offer_response')
      .orderBy('started_at')
      .execute();
    expect(runs.map((run) => run.script)).toEqual(['answer offer', 'read offer']);
  });

  it('never sends an answer twice: one whose page failed after it was taken is only read back', async () => {
    const { offer } = await listingWithOffer();
    await readOffers();
    const row = await offerRow(offer.id);
    site.offers.injectFault({ type: 'lost_answer' });
    const { responseId } = await answerNow(row, 'counter', 2600);
    await runPhone();
    await dueNow();
    await runPhone();
    expect(site.offers.answers).toHaveLength(1);
    expect(await responseRow(responseId)).toMatchObject({ status: 'succeeded', sent: true });
    expect(await offerRow(offer.id)).toMatchObject({ status: 'countered', amount_cents: 2600 });
  });

  it('treats an answer the phone stopped in the middle of as maybe sent: it is read back, never sent again', async () => {
    const { offer } = await listingWithOffer();
    await readOffers();
    const row = await offerRow(offer.id);
    const { responseId } = await answerNow(row, 'decline');
    // The phone claims the answer and is handed its send, then stops before answering.
    const run = await claimPhoneRun(phone, db, {
      accountId,
      deviceId,
      runtimeVersion: PHONE_RUNTIME_VERSION,
    });
    expect(run?.purpose).toBe('offer_response');
    await db
      .updateTable('phone_work')
      .set({ lease_expires_at: sql<Date>`now()` })
      .where('account_id', '=', accountId)
      .execute();
    expect(await responseRow(responseId)).toMatchObject({ sent: true });
    await runPhone();
    // The read shows the offer still waiting: not confirmed, and not sent again.
    expect(site.offers.answers).toEqual([]);
    expect(await responseRow(responseId)).toMatchObject({ status: 'verifying', sent: true });
  });

  it('fails an answer the marketplace refuses with its reason, and refuses one for an offer that moved', async () => {
    const { offer } = await listingWithOffer();
    await readOffers();
    const row = await offerRow(offer.id);
    site.offers.injectFault({ type: 'refuse', message: 'This offer has expired.' });
    const { responseId } = await answerNow(row, 'accept');
    await runPhone();
    expect(await responseRow(responseId)).toMatchObject({
      status: 'failed',
      error_message: 'Depop: This offer has expired.',
      retryable: false,
    });
    expect(await offerTasks()).toEqual([expect.objectContaining({ status: 'open' })]);
    await expect(answerNow({ ...row, amount_cents: 1900 }, 'accept')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(answerNow(row, 'counter', row.list_price_cents ?? 0)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(site.offers.answers).toEqual([]);
  });

  it('reads a read-only account’s offers, but never answers one there, even one asked for before', async () => {
    const { offer } = await listingWithOffer();
    const readOnly = (on: boolean) =>
      db
        .updateTable('marketplace_connection')
        .set({ read_only: on })
        .where('account_id', '=', accountId)
        .where('id', '=', connectionId)
        .execute();
    await readOnly(true);
    // Reading stays allowed: the offer is a task.
    await readOffers();
    const row = await offerRow(offer.id);
    expect(await offerTasks()).toEqual([expect.objectContaining({ status: 'open' })]);
    await expect(answerNow(row, 'accept')).rejects.toMatchObject({ code: 'unavailable' });

    // An answer asked for while the account was writable, then the account made read only:
    // the claim refuses it before anything is sent.
    await readOnly(false);
    const { responseId } = await answerNow(row, 'accept');
    await readOnly(true);
    await runPhone();
    expect(await responseRow(responseId)).toMatchObject({
      status: 'failed',
      error_code: 'read_only',
      sent: false,
    });
    expect(site.offers.answers).toEqual([]);
    await readOnly(false);
  });

  it('hands an app on runtime 2 every call but the offers, which wait for its update', async () => {
    await runPhone();
    await db
      .updateTable('app_device')
      .set({ runtime_version: 2 })
      .where('account_id', '=', accountId)
      .where('id', '=', deviceId)
      .execute();
    const olderApp = { accountId, deviceId, runtimeVersion: 2 };
    expect(await queueOfferCheck(db, { accountId, connectionId, marketplace: 'depop' })).toBe(true);
    expect(await claimPhoneRun(phone, db, olderApp)).toBeNull();
    expect((await work()).map((row) => row.purpose)).toEqual(['offer_check']);

    const listingId = await newListing();
    const create = await enqueue(listingId, 'create');
    await step(create);
    const run = await claimPhoneRun(phone, db, olderApp);
    expect(run?.purpose).toBe('operation');
    expect((run?.call?.input as unknown as { runtimeVersion: number }).runtimeVersion).toBe(2);
    await expect(claimPhoneRun(phone, db, { ...olderApp, runtimeVersion: 1 })).rejects.toThrow(
      /needs an update/,
    );
  });
});
